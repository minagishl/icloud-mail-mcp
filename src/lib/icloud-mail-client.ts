import { ImapFlow, type FetchQueryObject, type ListResponse } from 'imapflow';
import {
  simpleParser,
  type ParsedMail,
  type Attachment as MailparserAttachment,
} from 'mailparser';
import nodemailer from 'nodemailer';
import {
  iCloudConfig,
  EmailMessage,
  SendEmailOptions,
  Attachment,
  SearchOptions,
  FetchOptions,
  OrganizationRule,
  MailboxInfo,
  MailboxStats,
  IcloudMailError,
  type IcloudMailErrorKind,
} from '../types/config.js';

interface FetchedMessage {
  uid: number;
  flags?: Set<string>;
  envelope?: {
    date?: Date;
    subject?: string;
    messageId?: string;
    from?: Array<{ name?: string; address?: string }>;
    to?: Array<{ name?: string; address?: string }>;
    cc?: Array<{ name?: string; address?: string }>;
  };
  source?: Buffer;
  size?: number;
  internalDate?: Date;
}

const ICLOUD_TIMEOUTS = {
  connectionTimeout: 30000,
  greetingTimeout: 16000,
  socketTimeout: 300000,
};

function mapImapflowError(err: unknown): IcloudMailError {
  if (err instanceof IcloudMailError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  const lower = `${code} ${message}`.toLowerCase();

  let kind: IcloudMailErrorKind = 'server';
  let retryable = false;

  if (
    lower.includes('authenticationfailed') ||
    lower.includes('invalid credentials') ||
    lower.includes('auth') ||
    lower.includes('login')
  ) {
    kind = 'auth';
  } else if (
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('socket')
  ) {
    kind = 'network';
    retryable = true;
  } else if (lower.includes('overquota') || lower.includes('rate')) {
    kind = 'rate_limit';
    retryable = true;
  } else if (lower.includes('nonexistent') || lower.includes('not found')) {
    kind = 'not_found';
  }

  return new IcloudMailError(kind, message, { retryable, cause: err });
}

function envelopeAddress(
  addrs?: Array<{ name?: string; address?: string }>
): string {
  if (!addrs || addrs.length === 0) return '';
  return addrs
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');
}

function envelopeAddressList(
  addrs?: Array<{ name?: string; address?: string }>
): string[] {
  if (!addrs) return [];
  return addrs.map((a) => a.address ?? '').filter((a) => a.length > 0);
}

export class iCloudMailClient {
  private client: ImapFlow;
  private transporter: nodemailer.Transporter;
  private config: iCloudConfig;
  private currentImapUser: string;
  // Sticky for the lifetime of the client: once the local-part user fails auth,
  // we don't try it again on reconnect. iCloud accepts both forms for most accounts;
  // restart the server if you change credentials and want to retry the local-part path.
  private fellBackToFullEmail = false;
  private connectPromise: Promise<void> | null = null;

  constructor(config: iCloudConfig) {
    this.config = config;
    this.currentImapUser = this.extractEmailName(config.email);
    this.client = this.buildClient(this.currentImapUser);
    this.attachClientHandlers(this.client);

    this.transporter = nodemailer.createTransport({
      host: config.smtpHost || 'smtp.mail.me.com',
      port: config.smtpPort || 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: config.email,
        pass: config.appPassword,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  private extractEmailName(email: string): string {
    const atIndex = email.indexOf('@');
    return atIndex > 0 ? email.substring(0, atIndex) : email;
  }

  private buildClient(user: string): ImapFlow {
    return new ImapFlow({
      host: this.config.imapHost || 'imap.mail.me.com',
      port: this.config.imapPort || 993,
      secure: true,
      auth: {
        user,
        pass: this.config.appPassword,
      },
      tls: {
        servername: this.config.imapHost || 'imap.mail.me.com',
        rejectUnauthorized: false,
      },
      logger: false,
      ...ICLOUD_TIMEOUTS,
    });
  }

  private attachClientHandlers(client: ImapFlow) {
    client.on('error', (err: Error) => {
      console.error('IMAP error:', err.message);
    });
    client.on('close', () => {
      console.error('IMAP connection closed');
    });
  }

  async connect(): Promise<void> {
    if (this.client.usable && this.client.authenticated) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    // ImapFlow throws "Can not re-use ImapFlow instance" if you call connect()
    // on a client whose connection has already been closed. Rebuild before
    // attempting connect — handles long-session decay and post-close revival.
    if (!this.client.usable) {
      try {
        this.client.removeAllListeners();
      } catch {
        /* ignore */
      }
      this.client = this.buildClient(this.currentImapUser);
      this.attachClientHandlers(this.client);
    }
    try {
      await this.client.connect();
      console.error(
        `IMAP connection ready (user=${this.fellBackToFullEmail ? 'full email' : 'local part'})`
      );
    } catch (err) {
      const mapped = mapImapflowError(err);
      if (mapped.kind === 'auth' && !this.fellBackToFullEmail) {
        console.error(
          'IMAP auth failed with local-part user; retrying with full email address...'
        );
        this.fellBackToFullEmail = true;
        this.currentImapUser = this.config.email;
        try {
          this.client.removeAllListeners();
        } catch {
          /* ignore */
        }
        this.client = this.buildClient(this.currentImapUser);
        this.attachClientHandlers(this.client);
        try {
          await this.client.connect();
          console.error('IMAP connection ready (with full email)');
          return;
        } catch (retryErr) {
          throw mapImapflowError(retryErr);
        }
      }
      throw mapped;
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.client.usable && this.client.authenticated) {
      return;
    }
    await this.connect();
  }

  /**
   * Detects errors that indicate the underlying ImapFlow instance is wedged
   * and cannot be reused — most commonly the literal "Can not re-use ImapFlow
   * instance" thrown when an operation tries to use a client whose socket has
   * been closed mid-flight (long idle, network blip, server-side disconnect).
   */
  private isDeadClientError(err: unknown): boolean {
    if (!err) return false;
    const msg = (
      err instanceof Error ? err.message : String(err)
    ).toLowerCase();
    return (
      msg.includes('re-use') ||
      msg.includes('reuse') ||
      msg.includes('not connected') ||
      msg.includes('connection closed') ||
      msg.includes('connection ended') ||
      (msg.includes('socket') && msg.includes('closed'))
    );
  }

  /**
   * Force-rebuilds the underlying ImapFlow instance and reconnects.
   * Called when an operation fails because the existing instance is wedged.
   */
  private async forceRebuildClient(): Promise<void> {
    console.error('IMAP client wedged; forcing rebuild and reconnect...');
    try {
      this.client.close();
    } catch {
      /* ignore */
    }
    try {
      this.client.removeAllListeners();
    } catch {
      /* ignore */
    }
    this.client = this.buildClient(this.currentImapUser);
    this.attachClientHandlers(this.client);
    this.connectPromise = null;
    await this.connect();
  }

  /**
   * Wraps an IMAP-using operation. Ensures the client is connected before the
   * first attempt, and if the operation fails because the ImapFlow instance is
   * wedged, rebuilds the client and retries exactly once. Any other error is
   * rethrown immediately.
   *
   * This is the main mechanism for auto-recovering from the "Can not re-use
   * ImapFlow instance" wedge that historically required a process restart.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureConnected();
    try {
      return await fn();
    } catch (err) {
      if (this.isDeadClientError(err)) {
        await this.forceRebuildClient();
        return await fn();
      }
      throw err;
    }
  }

  async testConnection(): Promise<{ status: string; message: string }> {
    try {
      console.error('Testing IMAP connection...');
      await this.connect();
      // Active probe — connect() is a no-op when already authenticated, so do
      // a NOOP roundtrip to confirm the IMAP session is still live (not just
      // half-dead with TCP up but session expired).
      await this.client.noop();
      console.error('IMAP connection successful');

      console.error('Testing SMTP connection...');
      await Promise.race([
        this.transporter.verify(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error('SMTP verification timeout after 30 seconds')),
            30000
          )
        ),
      ]);

      console.error('SMTP connection successful');

      return {
        status: 'success',
        message:
          'Email connection test successful - both IMAP and SMTP are working',
      };
    } catch (error) {
      const mapped = mapImapflowError(error);
      let helpful = mapped.message;
      if (mapped.kind === 'auth') {
        helpful +=
          "\n\nTroubleshooting:\n1. Ensure you're using an app-specific password, not your regular Apple ID password\n2. Verify that two-factor authentication is enabled on your Apple ID\n3. Generate a new app-specific password if the current one isn't working\n4. Check that your Apple ID hasn't been locked";
      } else if (mapped.kind === 'network') {
        helpful +=
          '\n\nTroubleshooting:\n1. Check your internet connection\n2. Verify firewall settings allow connections to iCloud mail servers\n3. Try connecting from a different network';
      }
      return {
        status: 'error',
        message: helpful,
      };
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  async getMailboxes(): Promise<MailboxInfo[]> {
    return this.withRetry(async () => {
      try {
        const list = await this.client.list();
        return list.map((box: ListResponse) => ({
          path: box.path,
          name: box.name,
          delimiter: box.delimiter ?? '/',
          flags: box.flags ? Array.from(box.flags) : [],
          specialUse: box.specialUse,
        }));
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      }
    });
  }

  async getMailboxStats(mailbox: string = 'INBOX'): Promise<MailboxStats> {
    return this.withRetry(async () => {
      try {
        return await this.statusInternal(mailbox);
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      }
    });
  }

  /**
   * Internal STATUS without retry / connection management — for callers that
   * are already inside withRetry and don't want to nest. STATUS does not need
   * a mailbox lock (it queries the server directly without selecting).
   */
  private async statusInternal(mailbox: string): Promise<MailboxStats> {
    const status = await this.client.status(mailbox, {
      messages: true,
      unseen: true,
      recent: true,
    });
    return {
      mailbox,
      total: status.messages ?? 0,
      unread: status.unseen ?? 0,
      recent: status.recent ?? 0,
    };
  }

  async getMessages(
    mailbox: string = 'INBOX',
    limit: number = 10,
    unreadOnly: boolean = false,
    options: FetchOptions = {}
  ): Promise<EmailMessage[]> {
    return this.withRetry(async () => {
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const uids = await this.client.search(
          unreadOnly ? { seen: false } : { all: true },
          { uid: true }
        );
        if (!uids || uids.length === 0) {
          return [];
        }
        const sliced = uids.slice(-limit);
        return await this.fetchMessagesByUids(sliced, mailbox, options);
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      } finally {
        try {
          lock.release();
        } catch {
          /* lock may already be invalid after a wedge; ignore */
        }
      }
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
    const mailOptions: nodemailer.SendMailOptions = {
      from: this.config.email,
      to: options.to,
      subject: options.subject,
    };

    if (options.text) mailOptions.text = options.text;
    if (options.html) mailOptions.html = options.html;
    if (options.attachments) {
      mailOptions.attachments = options.attachments.map((att) => ({
        filename: att.filename,
        path: att.path,
        content: att.content,
        contentType: att.contentType,
      }));
    }

    const info = await this.transporter.sendMail(mailOptions);
    return { messageId: info.messageId };
  }

  async markAsRead(
    messageIds: string[],
    mailbox: string = 'INBOX'
  ): Promise<{ status: string; message: string; affected: number }> {
    return this.setFlags(messageIds, ['\\Seen'], mailbox, 'add');
  }

  async setFlags(
    messageIds: string[],
    flags: string[],
    mailbox: string = 'INBOX',
    action: 'add' | 'remove' = 'add'
  ): Promise<{ status: string; message: string; affected: number }> {
    if (!messageIds || messageIds.length === 0) {
      return {
        status: 'success',
        message: 'No messages provided; no flags changed.',
        affected: 0,
      };
    }
    const uids = this.normalizeUids(messageIds);
    return this.withRetry(async () => {
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const range = uids.join(',');
        if (action === 'add') {
          await this.client.messageFlagsAdd(range, flags, { uid: true });
        } else {
          await this.client.messageFlagsRemove(range, flags, { uid: true });
        }
        return {
          status: 'success',
          message: `Successfully ${action === 'add' ? 'added' : 'removed'} flags [${flags.join(', ')}] ${action === 'add' ? 'to' : 'from'} ${uids.length} messages in '${mailbox}'`,
          affected: uids.length,
        };
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      } finally {
        try {
          lock.release();
        } catch {
          /* ignore */
        }
      }
    });
  }

  async createMailbox(
    name: string
  ): Promise<{ status: string; message: string }> {
    return this.withRetry(async () => {
      try {
        const result = await this.client.mailboxCreate(name);
        return {
          status: 'success',
          message: result.created
            ? `Mailbox '${result.path}' created successfully`
            : `Mailbox '${result.path}' already exists`,
        };
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        const mapped = mapImapflowError(err);
        return { status: 'error', message: mapped.message };
      }
    });
  }

  async deleteMailbox(
    name: string
  ): Promise<{ status: string; message: string }> {
    return this.withRetry(async () => {
      try {
        const result = await this.client.mailboxDelete(name);
        return {
          status: 'success',
          message: `Mailbox '${result.path}' deleted successfully`,
        };
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        const mapped = mapImapflowError(err);
        return { status: 'error', message: mapped.message };
      }
    });
  }

  async moveMessages(
    messageIds: string[],
    sourceMailbox: string,
    destinationMailbox: string,
    options: { dryRun?: boolean; verifyCounts?: boolean } = {}
  ): Promise<{
    status: string;
    message: string;
    moved: number;
    skipped: number;
    skippedDetails?: Array<{ uid: number; reason: string }>;
    wouldAffect?: Array<{ id: string; from: string; subject: string }>;
    counts?: {
      expected: number;
      sourceBefore: number;
      sourceAfter: number;
      sourceDelta: number;
      destBefore: number;
      destAfter: number;
      destDelta: number;
    };
    countWarning?: string;
  }> {
    if (!messageIds || messageIds.length === 0) {
      return {
        status: 'success',
        message: 'No messages provided; nothing moved.',
        moved: 0,
        skipped: 0,
      };
    }
    if (!sourceMailbox || !destinationMailbox) {
      throw new IcloudMailError(
        'invalid_input',
        'Both sourceMailbox and destinationMailbox are required.'
      );
    }
    const uids = this.normalizeUids(messageIds);
    const verifyCounts = options.verifyCounts !== false; // default true

    return this.withRetry(async () => {
      const skippedDetails: Array<{ uid: number; reason: string }> = [];
      const movableUids: number[] = [];

      const sourceLock = await this.client.getMailboxLock(sourceMailbox);
      let envelopes: FetchedMessage[] = [];
      try {
        envelopes = (await this.collectEnvelopes(uids)) as FetchedMessage[];
        if (options.dryRun) {
          return {
            status: 'success',
            message: `Dry run: would move ${envelopes.length} message(s) from '${sourceMailbox}' to '${destinationMailbox}'`,
            moved: 0,
            skipped: 0,
            wouldAffect: envelopes.map((m) => ({
              id: String(m.uid),
              from: envelopeAddress(m.envelope?.from),
              subject: m.envelope?.subject ?? '',
            })),
          };
        }
      } finally {
        try {
          sourceLock.release();
        } catch {
          /* ignore */
        }
      }

      const messageIdHeaders = envelopes
        .map((m) => ({
          uid: m.uid,
          rfc822: m.envelope?.messageId,
        }))
        .filter((m) => !!m.rfc822) as Array<{ uid: number; rfc822: string }>;

      const presentInDestination = new Set<string>();
      if (messageIdHeaders.length > 0) {
        try {
          const destLock = await this.client.getMailboxLock(destinationMailbox);
          try {
            for (const { rfc822 } of messageIdHeaders) {
              const found = await this.client.search(
                { header: { 'message-id': rfc822 } },
                { uid: true }
              );
              if (found && found.length > 0) {
                presentInDestination.add(rfc822);
              }
            }
          } finally {
            try {
              destLock.release();
            } catch {
              /* ignore */
            }
          }
        } catch (err) {
          if (this.isDeadClientError(err)) throw err;
          throw mapImapflowError(err);
        }
      }

      for (const m of envelopes) {
        const rfc822 = m.envelope?.messageId;
        if (rfc822 && presentInDestination.has(rfc822)) {
          skippedDetails.push({
            uid: m.uid,
            reason: 'already present in destination',
          });
        } else {
          movableUids.push(m.uid);
        }
      }
      const foundUidSet = new Set(envelopes.map((m) => m.uid));
      for (const uid of uids) {
        if (!foundUidSet.has(uid)) {
          skippedDetails.push({ uid, reason: 'not found in source mailbox' });
        }
      }

      if (movableUids.length === 0) {
        return {
          status: 'success',
          message: `No messages moved. ${skippedDetails.length} skipped.`,
          moved: 0,
          skipped: skippedDetails.length,
          skippedDetails,
        };
      }

      // Capture counts before mutation. Wrapped in try/catch so a failing
      // STATUS doesn't poison the move itself.
      let sourceBefore: number | undefined;
      let destBefore: number | undefined;
      if (verifyCounts) {
        try {
          sourceBefore = (await this.statusInternal(sourceMailbox)).total;
          destBefore = (await this.statusInternal(destinationMailbox)).total;
        } catch (err) {
          if (this.isDeadClientError(err)) throw err;
          // Soft-fail: skip count verification but still move.
          sourceBefore = undefined;
          destBefore = undefined;
        }
      }

      const moveLock = await this.client.getMailboxLock(sourceMailbox);
      try {
        const range = movableUids.join(',');
        await this.client.messageMove(range, destinationMailbox, {
          uid: true,
        });
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      } finally {
        try {
          moveLock.release();
        } catch {
          /* ignore */
        }
      }

      let counts:
        | {
            expected: number;
            sourceBefore: number;
            sourceAfter: number;
            sourceDelta: number;
            destBefore: number;
            destAfter: number;
            destDelta: number;
          }
        | undefined;
      let countWarning: string | undefined;
      if (
        verifyCounts &&
        sourceBefore !== undefined &&
        destBefore !== undefined
      ) {
        try {
          const sourceAfter = (await this.statusInternal(sourceMailbox)).total;
          const destAfter = (await this.statusInternal(destinationMailbox))
            .total;
          counts = {
            expected: movableUids.length,
            sourceBefore,
            sourceAfter,
            sourceDelta: sourceBefore - sourceAfter,
            destBefore,
            destAfter,
            destDelta: destAfter - destBefore,
          };
          // Tolerance: small drift is normal (mail arriving during the
          // operation, server-side rules firing concurrently). Flag larger
          // discrepancies for the caller to investigate.
          const tolerance = 5;
          if (Math.abs(counts.sourceDelta - counts.expected) > tolerance) {
            countWarning = `Source mailbox '${sourceMailbox}' dropped by ${counts.sourceDelta} but expected ${counts.expected}.`;
          } else if (Math.abs(counts.destDelta - counts.expected) > tolerance) {
            countWarning = `Destination mailbox '${destinationMailbox}' grew by ${counts.destDelta} but expected ${counts.expected}.`;
          }
        } catch (err) {
          if (this.isDeadClientError(err)) throw err;
          // Soft-fail post-move count check; the move already succeeded.
        }
      }

      return {
        status: 'success',
        message: `Moved ${movableUids.length} message(s) from '${sourceMailbox}' to '${destinationMailbox}' (${skippedDetails.length} skipped)`,
        moved: movableUids.length,
        skipped: skippedDetails.length,
        skippedDetails: skippedDetails.length > 0 ? skippedDetails : undefined,
        counts,
        countWarning,
      };
    });
  }

  async searchMessages(options: SearchOptions): Promise<EmailMessage[]> {
    const {
      query,
      mailbox = 'INBOX',
      limit = 10,
      dateFrom,
      dateTo,
      fromEmail,
      unreadOnly = false,
      metadataOnly,
      bodyPreview,
    } = options;

    return this.withRetry(async () => {
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const criteria: Record<string, unknown> = {};
        if (unreadOnly) criteria.seen = false;
        if (dateFrom) {
          const d = new Date(dateFrom);
          if (!Number.isNaN(d.getTime())) criteria.since = d;
        }
        if (dateTo) {
          const d = new Date(dateTo);
          if (!Number.isNaN(d.getTime())) criteria.before = d;
        }
        if (fromEmail) criteria.from = fromEmail;
        if (query) {
          criteria.or = [{ subject: query }, { body: query }];
        }
        if (Object.keys(criteria).length === 0) {
          criteria.all = true;
        }

        const uids = await this.client.search(criteria, { uid: true });
        if (!uids || uids.length === 0) return [];
        const sliced = uids.slice(-limit);
        return await this.fetchMessagesByUids(sliced, mailbox, {
          metadataOnly,
          bodyPreview,
        });
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      } finally {
        try {
          lock.release();
        } catch {
          /* ignore */
        }
      }
    });
  }

  async deleteMessages(
    messageIds: string[],
    mailbox: string = 'INBOX',
    options: { dryRun?: boolean; verifyCounts?: boolean } = {}
  ): Promise<{
    status: string;
    message: string;
    deleted: number;
    wouldAffect?: Array<{ id: string; from: string; subject: string }>;
    counts?: {
      expected: number;
      sourceBefore: number;
      sourceAfter: number;
      sourceDelta: number;
    };
    countWarning?: string;
  }> {
    if (!messageIds || messageIds.length === 0) {
      return {
        status: 'success',
        message: 'No messages provided; nothing deleted.',
        deleted: 0,
      };
    }
    const uids = this.normalizeUids(messageIds);
    const verifyCounts = options.verifyCounts !== false;

    return this.withRetry(async () => {
      // Dry run: capture envelopes without locking the mailbox in write mode longer than needed.
      if (options.dryRun) {
        const dryLock = await this.client.getMailboxLock(mailbox);
        try {
          const envelopes = await this.collectEnvelopes(uids);
          return {
            status: 'success',
            message: `Dry run: would delete ${envelopes.length} message(s) from '${mailbox}'`,
            deleted: 0,
            wouldAffect: envelopes.map((m) => ({
              id: String(m.uid),
              from: envelopeAddress(m.envelope?.from),
              subject: m.envelope?.subject ?? '',
            })),
          };
        } catch (err) {
          if (this.isDeadClientError(err)) throw err;
          throw mapImapflowError(err);
        } finally {
          try {
            dryLock.release();
          } catch {
            /* ignore */
          }
        }
      }

      let sourceBefore: number | undefined;
      if (verifyCounts) {
        try {
          sourceBefore = (await this.statusInternal(mailbox)).total;
        } catch (err) {
          if (this.isDeadClientError(err)) throw err;
          sourceBefore = undefined;
        }
      }

      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const range = uids.join(',');
        await this.client.messageDelete(range, { uid: true });
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      } finally {
        try {
          lock.release();
        } catch {
          /* ignore */
        }
      }

      let counts:
        | {
            expected: number;
            sourceBefore: number;
            sourceAfter: number;
            sourceDelta: number;
          }
        | undefined;
      let countWarning: string | undefined;
      if (verifyCounts && sourceBefore !== undefined) {
        try {
          const sourceAfter = (await this.statusInternal(mailbox)).total;
          counts = {
            expected: uids.length,
            sourceBefore,
            sourceAfter,
            sourceDelta: sourceBefore - sourceAfter,
          };
          const tolerance = 5;
          if (Math.abs(counts.sourceDelta - counts.expected) > tolerance) {
            countWarning = `Mailbox '${mailbox}' dropped by ${counts.sourceDelta} but expected ${counts.expected}.`;
          }
        } catch (err) {
          if (this.isDeadClientError(err)) throw err;
          // Soft-fail post-delete count check; the delete already succeeded.
        }
      }

      return {
        status: 'success',
        message: `Deleted ${uids.length} message(s) from '${mailbox}'`,
        deleted: uids.length,
        counts,
        countWarning,
      };
    });
  }

  async downloadAttachment(
    messageId: string,
    attachmentIndex: number = 0,
    mailbox: string = 'INBOX'
  ): Promise<{
    status: string;
    message: string;
    attachment?: {
      filename: string;
      contentType: string;
      size: number;
      data: string;
    };
  }> {
    if (!messageId) {
      throw new IcloudMailError('invalid_input', 'messageId is required.');
    }
    const uid = this.normalizeUids([messageId])[0];
    return this.withRetry(async () => {
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const fetched = await this.client.fetchOne(
          String(uid),
          { source: true } satisfies FetchQueryObject,
          { uid: true }
        );
        if (!fetched || !fetched.source) {
          return {
            status: 'error',
            message: `Message with UID '${messageId}' not found in '${mailbox}'`,
          };
        }
        const parsed = await simpleParser(fetched.source as Buffer);
        if (!parsed.attachments || parsed.attachments.length === 0) {
          return {
            status: 'error',
            message: 'No attachments found in the message',
          };
        }
        if (attachmentIndex >= parsed.attachments.length) {
          return {
            status: 'error',
            message: `Attachment index ${attachmentIndex} out of range. Message has ${parsed.attachments.length} attachments`,
          };
        }
        const attachment = parsed.attachments[attachmentIndex];
        return {
          status: 'success',
          message: `Successfully downloaded attachment '${attachment.filename ?? 'unknown'}'`,
          attachment: {
            filename: attachment.filename || 'unknown',
            contentType: attachment.contentType || 'application/octet-stream',
            size: attachment.size || 0,
            data: attachment.content.toString('base64'),
          },
        };
      } catch (err) {
        if (this.isDeadClientError(err)) throw err;
        throw mapImapflowError(err);
      } finally {
        try {
          lock.release();
        } catch {
          /* ignore */
        }
      }
    });
  }

  async autoOrganize(
    rules: OrganizationRule[],
    sourceMailbox: string = 'INBOX',
    dryRun: boolean = false,
    maxMessages: number = 100,
    timeBudgetMs: number = 50000
  ): Promise<{
    status: string;
    message: string;
    results: Array<{
      rule: string;
      matchedMessages: number;
      moved: number;
      skipped: number;
      ruleStatus: 'completed' | 'pending' | 'failed';
      error?: string;
      messages?: Array<{
        id: string;
        from: string;
        subject: string;
        destinationMailbox: string;
      }>;
    }>;
    progress: {
      rulesTotal: number;
      rulesCompleted: number;
      rulesPending: number;
      rulesFailed: number;
      durationMs: number;
      stoppedReason?: string;
    };
  }> {
    const startTime = Date.now();
    try {
      // Fetch envelopes only — no body required for matching against from/subject.
      // Bounded by maxMessages (default 100); for large mailboxes use move_messages
      // with explicit UIDs from search_messages instead.
      const messages = await this.getMessages(
        sourceMailbox,
        maxMessages,
        false,
        { metadataOnly: true }
      );

      type RuleResult = {
        rule: string;
        matchedMessages: number;
        moved: number;
        skipped: number;
        ruleStatus: 'completed' | 'pending' | 'failed';
        error?: string;
        messages?: Array<{
          id: string;
          from: string;
          subject: string;
          destinationMailbox: string;
        }>;
      };
      const results: RuleResult[] = [];

      // Pre-compute matches for every rule against the loaded message window.
      // Matching is in-memory and cheap; the actual time cost is the moves.
      const ruleMatches = rules.map((rule) => {
        const matched: Array<{
          id: string;
          from: string;
          subject: string;
          destinationMailbox: string;
        }> = [];
        for (const msg of messages) {
          let matches = false;
          if (rule.condition.fromContains) {
            matches =
              matches ||
              msg.from
                .toLowerCase()
                .includes(rule.condition.fromContains.toLowerCase());
          }
          if (rule.condition.subjectContains) {
            matches =
              matches ||
              msg.subject
                .toLowerCase()
                .includes(rule.condition.subjectContains.toLowerCase());
          }
          if (matches) {
            matched.push({
              id: msg.id,
              from: msg.from,
              subject: msg.subject,
              destinationMailbox: rule.action.moveToMailbox,
            });
          }
        }
        return { rule, matched };
      });

      let stoppedReason: string | undefined;

      for (const { rule, matched } of ruleMatches) {
        const elapsed = Date.now() - startTime;
        const budgetExhausted = elapsed > timeBudgetMs;

        if (budgetExhausted && matched.length > 0 && !dryRun) {
          // Report remaining rules as pending so the caller can continue with
          // a follow-up call instead of guessing what ran.
          if (!stoppedReason) {
            stoppedReason = `time budget of ${timeBudgetMs}ms exhausted after ${elapsed}ms`;
          }
          results.push({
            rule: rule.name,
            matchedMessages: matched.length,
            moved: 0,
            skipped: 0,
            ruleStatus: 'pending',
            messages: matched,
          });
          continue;
        }

        if (matched.length === 0) {
          results.push({
            rule: rule.name,
            matchedMessages: 0,
            moved: 0,
            skipped: 0,
            ruleStatus: 'completed',
          });
          continue;
        }

        if (dryRun) {
          results.push({
            rule: rule.name,
            matchedMessages: matched.length,
            moved: 0,
            skipped: 0,
            ruleStatus: 'completed',
            messages: matched,
          });
          continue;
        }

        try {
          const moveResult = await this.moveMessages(
            matched.map((m) => m.id),
            sourceMailbox,
            rule.action.moveToMailbox
          );
          results.push({
            rule: rule.name,
            matchedMessages: matched.length,
            moved: moveResult.moved,
            skipped: moveResult.skipped,
            ruleStatus: 'completed',
            messages: matched,
          });
        } catch (err) {
          const mapped = mapImapflowError(err);
          console.error(
            `Failed to move messages for rule '${rule.name}': ${mapped.message}`
          );
          results.push({
            rule: rule.name,
            matchedMessages: matched.length,
            moved: 0,
            skipped: 0,
            ruleStatus: 'failed',
            error: mapped.message,
            messages: matched,
          });
        }
      }

      const totalMatched = results.reduce(
        (sum, r) => sum + r.matchedMessages,
        0
      );
      const totalMoved = results.reduce((sum, r) => sum + r.moved, 0);
      const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
      const rulesCompleted = results.filter(
        (r) => r.ruleStatus === 'completed'
      ).length;
      const rulesPending = results.filter(
        (r) => r.ruleStatus === 'pending'
      ).length;
      const rulesFailed = results.filter(
        (r) => r.ruleStatus === 'failed'
      ).length;

      return {
        status: 'success',
        message: dryRun
          ? `Dry run completed. ${totalMatched} message(s) match organization rules.`
          : stoppedReason
            ? `Organization stopped early (${stoppedReason}). Matched ${totalMatched}, moved ${totalMoved}, skipped ${totalSkipped}, ${rulesPending} rule(s) pending.`
            : `Organization completed. Matched ${totalMatched}, moved ${totalMoved}, skipped ${totalSkipped}.`,
        results,
        progress: {
          rulesTotal: rules.length,
          rulesCompleted,
          rulesPending,
          rulesFailed,
          durationMs: Date.now() - startTime,
          stoppedReason,
        },
      };
    } catch (err) {
      const mapped = mapImapflowError(err);
      return {
        status: 'error',
        message: `Failed to organize emails: ${mapped.message}`,
        results: [],
        progress: {
          rulesTotal: rules.length,
          rulesCompleted: 0,
          rulesPending: rules.length,
          rulesFailed: 0,
          durationMs: Date.now() - startTime,
          stoppedReason: 'fatal error before processing',
        },
      };
    }
  }

  // ---- Internal helpers ----

  private normalizeUids(messageIds: string[]): number[] {
    const uids: number[] = [];
    for (const raw of messageIds) {
      const n = Number.parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new IcloudMailError(
          'invalid_input',
          `messageId '${raw}' is not a valid IMAP UID. As of v1.2.0, messageId values must be IMAP UIDs (e.g. "12345"). See CHANGELOG.`
        );
      }
      uids.push(n);
    }
    return uids;
  }

  private async collectEnvelopes(uids: number[]): Promise<FetchedMessage[]> {
    const range = uids.join(',');
    const messages: FetchedMessage[] = [];
    for await (const msg of this.client.fetch(
      range,
      {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      } satisfies FetchQueryObject,
      { uid: true }
    )) {
      messages.push(msg as unknown as FetchedMessage);
    }
    return messages;
  }

  private async fetchMessagesByUids(
    uids: number[],
    mailbox: string,
    options: FetchOptions
  ): Promise<EmailMessage[]> {
    if (uids.length === 0) return [];
    const range = uids.join(',');
    const metadataOnly = options.metadataOnly === true;
    const query: FetchQueryObject = {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
    };
    if (!metadataOnly) {
      query.source = true;
    }

    const result: EmailMessage[] = [];
    for await (const msg of this.client.fetch(range, query, { uid: true })) {
      const m = msg as unknown as FetchedMessage;
      let body = '';
      let attachments: Attachment[] | undefined;

      if (!metadataOnly && m.source) {
        try {
          const parsed: ParsedMail = await simpleParser(m.source);
          body = parsed.text || parsed.html || '';
          if (typeof options.bodyPreview === 'number') {
            body = body.slice(0, Math.max(0, options.bodyPreview));
          }
          if (
            parsed.attachments &&
            parsed.attachments.length > 0 &&
            typeof options.bodyPreview !== 'number'
          ) {
            attachments = parsed.attachments.map(
              (att: MailparserAttachment) => ({
                filename: att.filename || 'unknown',
                contentType: att.contentType || 'application/octet-stream',
                size: att.size || 0,
                data: att.content,
              })
            );
          }
        } catch (parseError) {
          console.error('Error parsing email:', parseError);
        }
      }

      const env = m.envelope ?? {};

      result.push({
        id: String(m.uid),
        uid: m.uid,
        rfc822MessageId: env.messageId,
        mailbox,
        from: envelopeAddress(env.from),
        to: envelopeAddressList(env.to),
        subject: env.subject ?? '',
        body,
        date: env.date ?? new Date(),
        flags: m.flags ? Array.from(m.flags) : [],
        attachments,
      });
    }

    return result;
  }
}
