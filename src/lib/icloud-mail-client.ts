import Imap from 'imap';
import {
  simpleParser,
  ParsedMail,
  Attachment as MailparserAttachment,
  AddressObject as MailparserAddressObject,
} from 'mailparser';
import nodemailer from 'nodemailer';
import {
  iCloudConfig,
  EmailMessage,
  SendEmailOptions,
  Attachment,
  SearchOptions,
  OrganizationRule,
} from '../types/config.js';

// Type definitions for IMAP
interface ImapBox {
  attribs: string[];
  delimiter: string;
  children?: ImapBoxes;
  parent?: ImapBox;
}

interface ImapBoxes {
  [boxName: string]: ImapBox;
}

interface ImapMessage {
  on(
    event: 'body',
    listener: (stream: NodeJS.ReadableStream, info: object) => void
  ): this;
  on(
    event: 'attributes',
    listener: (attrs: ImapMessageAttributes) => void
  ): this;
  once(event: 'end', listener: () => void): this;
  once(
    event: 'attributes',
    listener: (attrs: ImapMessageAttributes) => void
  ): this;
}

interface ImapMessageAttributes {
  flags?: string[];
  date?: Date;
  struct?: unknown[];
  size?: number;
}

// Remove unused ImapFetch interface

// Use mailparser's AddressObject type instead

export class iCloudMailClient {
  private imap: Imap;
  private transporter: nodemailer.Transporter;
  private config: iCloudConfig;

  constructor(config: iCloudConfig) {
    this.config = config;

    // For IMAP, try email name first (e.g., "johnappleseed"), fallback to full email
    const imapUsername = this.extractEmailName(config.email);

    this.imap = new Imap({
      user: imapUsername,
      password: config.appPassword,
      host: config.imapHost || 'imap.mail.me.com',
      port: config.imapPort || 993,
      tls: true,
      tlsOptions: {
        servername: config.imapHost || 'imap.mail.me.com',
        rejectUnauthorized: false, // Allow self-signed certificates if needed
      },
      authTimeout: 30000, // 30 seconds timeout
      connTimeout: 30000,
    });

    this.transporter = nodemailer.createTransport({
      host: config.smtpHost || 'smtp.mail.me.com',
      port: config.smtpPort || 587,
      secure: false, // Use STARTTLS
      requireTLS: true, // Force TLS
      auth: {
        user: config.email, // SMTP requires full email address
        pass: config.appPassword,
      },
      tls: {
        rejectUnauthorized: false, // Allow self-signed certificates if needed
      },
    });
  }

  private extractEmailName(email: string): string {
    // Extract username part from email (e.g., "john@icloud.com" -> "john")
    const atIndex = email.indexOf('@');
    return atIndex > 0 ? email.substring(0, atIndex) : email;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.once('ready', () => {
        console.error('IMAP connection ready');
        resolve();
      });

      this.imap.once('error', (err: Error) => {
        console.error('IMAP connection error:', err);

        // Try with full email if username-only failed
        if (
          err.message.includes('authenticate') ||
          err.message.includes('Invalid credentials')
        ) {
          console.error('Retrying IMAP connection with full email address...');

          // Recreate IMAP with full email
          this.imap = new Imap({
            user: this.config.email, // Use full email instead of username
            password: this.config.appPassword,
            host: this.config.imapHost || 'imap.mail.me.com',
            port: this.config.imapPort || 993,
            tls: true,
            tlsOptions: {
              servername: this.config.imapHost || 'imap.mail.me.com',
              rejectUnauthorized: false,
            },
            authTimeout: 30000,
            connTimeout: 30000,
          });

          // Try connecting again with full email
          this.imap.once('ready', () => {
            console.error('IMAP connection ready (with full email)');
            resolve();
          });

          this.imap.once('error', (retryErr: Error) => {
            console.error(
              'IMAP connection failed even with full email:',
              retryErr
            );
            reject(
              new Error(
                `IMAP authentication failed. Please check your app-specific password and ensure two-factor authentication is enabled. Details: ${retryErr.message}`
              )
            );
          });

          this.imap.connect();
        } else {
          reject(new Error(`IMAP connection failed: ${err.message}`));
        }
      });

      this.imap.connect();
    });
  }

  async testConnection(): Promise<{ status: string; message: string }> {
    try {
      console.error('Testing IMAP connection...');
      await this.connect();
      console.error('IMAP connection successful, disconnecting...');
      await this.disconnect();

      console.error('Testing SMTP connection...');
      // Test SMTP connection with timeout
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('Connection test failed:', errorMessage);

      // Provide helpful error messages based on common issues
      let helpfulMessage = errorMessage;
      if (
        errorMessage.includes('authenticate') ||
        errorMessage.includes('Invalid credentials')
      ) {
        helpfulMessage +=
          "\n\nTroubleshooting:\n1. Ensure you're using an app-specific password, not your regular Apple ID password\n2. Verify that two-factor authentication is enabled on your Apple ID\n3. Generate a new app-specific password if the current one isn't working\n4. Check that your Apple ID hasn't been locked";
      } else if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('ECONNREFUSED')
      ) {
        helpfulMessage +=
          '\n\nTroubleshooting:\n1. Check your internet connection\n2. Verify firewall settings allow connections to iCloud mail servers\n3. Try connecting from a different network';
      }

      return {
        status: 'error',
        message: helpfulMessage,
      };
    }
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.imap.once('end', () => {
        resolve();
      });
      this.imap.end();
    });
  }

  async getMailboxes(): Promise<ImapBoxes> {
    return new Promise((resolve, reject) => {
      this.imap.getBoxes((err: Error, boxes: ImapBoxes) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(boxes);
      });
    });
  }

  async getMessages(
    mailbox: string = 'INBOX',
    limit: number = 10,
    unreadOnly: boolean = false
  ): Promise<EmailMessage[]> {
    return new Promise((resolve, reject) => {
      this.imap.openBox(mailbox, true, (err: Error) => {
        if (err) {
          reject(err);
          return;
        }

        const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];

        this.imap.search(searchCriteria, (err: Error, results: number[]) => {
          if (err) {
            reject(err);
            return;
          }

          if (!results || results.length === 0) {
            resolve([]);
            return;
          }

          const messageIds = results.slice(-limit);
          const fetch = this.imap.fetch(messageIds, {
            bodies: '',
            struct: true,
          });

          const messages: EmailMessage[] = [];

          fetch.on('message', (msg: ImapMessage, seqno: number) => {
            let emailData = '';

            msg.on('body', (stream: NodeJS.ReadableStream) => {
              stream.on('data', (chunk: Buffer) => {
                emailData += chunk.toString('utf8');
              });

              stream.once('end', async () => {
                try {
                  const parsed: ParsedMail = await simpleParser(emailData);

                  const attachments: Attachment[] = [];
                  if (parsed.attachments) {
                    parsed.attachments.forEach((att: MailparserAttachment) => {
                      attachments.push({
                        filename: att.filename || 'unknown',
                        contentType:
                          att.contentType || 'application/octet-stream',
                        size: att.size || 0,
                        data: att.content,
                      });
                    });
                  }

                  const getEmailText = (
                    addr:
                      | MailparserAddressObject
                      | MailparserAddressObject[]
                      | undefined
                  ) => {
                    if (!addr) return '';
                    if (Array.isArray(addr))
                      return addr.map((a) => a.text).join(', ');
                    return addr.text;
                  };

                  const emailMessage: EmailMessage = {
                    id: parsed.messageId || `${seqno}`,
                    from: getEmailText(parsed.from),
                    to: parsed.to
                      ? Array.isArray(parsed.to)
                        ? parsed.to.map((t) => getEmailText(t))
                        : [getEmailText(parsed.to)]
                      : [],
                    subject: parsed.subject || '',
                    body: parsed.text || parsed.html || '',
                    date: parsed.date || new Date(),
                    flags: [],
                    attachments:
                      attachments.length > 0 ? attachments : undefined,
                  };

                  messages.push(emailMessage);
                } catch (parseError) {
                  console.error('Error parsing email:', parseError);
                }
              });
            });

            msg.once('attributes', (attrs: ImapMessageAttributes) => {
              if (attrs.flags) {
                const lastMessage = messages[messages.length - 1];
                if (lastMessage) {
                  lastMessage.flags = attrs.flags;
                }
              }
            });
          });

          fetch.once('error', (fetchErr: Error) => {
            reject(fetchErr);
          });

          fetch.once('end', () => {
            resolve(messages);
          });
        });
      });
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
    const mailOptions: nodemailer.SendMailOptions = {
      from: this.config.email,
      to: options.to,
      subject: options.subject,
    };

    if (options.text) {
      mailOptions.text = options.text;
    }

    if (options.html) {
      mailOptions.html = options.html;
    }

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

  /**
   * Resolves Message-ID header strings to IMAP sequence numbers.
   * The mailbox must already be open when this method is called.
   */
  private resolveMessageIds(messageIds: string[]): Promise<number[]> {
    return new Promise((resolve, reject) => {
      this.imap.search(['ALL'], (err: Error, results: number[]) => {
        if (err) {
          reject(err);
          return;
        }

        if (!results || results.length === 0) {
          resolve([]);
          return;
        }

        const targetIds = new Set(messageIds);
        const matchedSeqnos: number[] = [];

        const fetch = this.imap.fetch(results, {
          bodies: 'HEADER.FIELDS (MESSAGE-ID)',
        });

        fetch.on('message', (msg: ImapMessage, seqno: number) => {
          let headerData = '';

          msg.on('body', (stream: NodeJS.ReadableStream) => {
            stream.on('data', (chunk: Buffer) => {
              headerData += chunk.toString('utf8');
            });
          });

          msg.once('end', () => {
            const match = headerData.match(/Message-ID:\s*(<[^>]+>|[^\s]+)/i);
            if (match) {
              const mid = match[1].trim();
              if (targetIds.has(mid)) {
                matchedSeqnos.push(seqno);
              }
            }
            // Fallback: check if seqno was passed directly as an ID
            if (targetIds.has(`${seqno}`)) {
              matchedSeqnos.push(seqno);
            }
          });
        });

        fetch.once('error', (fetchErr: Error) => {
          reject(fetchErr);
        });

        fetch.once('end', () => {
          resolve(matchedSeqnos);
        });
      });
    });
  }

  async markAsRead(
    messageIds: string[],
    mailbox: string = 'INBOX'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.openBox(mailbox, false, async (err: Error) => {
        if (err) {
          reject(err);
          return;
        }

        try {
          const seqnos = await this.resolveMessageIds(messageIds);
          if (seqnos.length === 0) {
            resolve();
            return;
          }

          this.imap.addFlags(seqnos, ['\\Seen'], (err: Error) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  async createMailbox(
    name: string
  ): Promise<{ status: string; message: string }> {
    return new Promise((resolve) => {
      this.imap.addBox(name, (err: Error) => {
        if (err) {
          resolve({
            status: 'error',
            message: err.message,
          });
          return;
        }

        resolve({
          status: 'success',
          message: `Mailbox '${name}' created successfully`,
        });
      });
    });
  }

  async deleteMailbox(
    name: string
  ): Promise<{ status: string; message: string }> {
    if (!name || name.trim() === '') {
      return {
        status: 'error',
        message: 'Mailbox name cannot be empty',
      };
    }

    const trimmedName = name.trim();

    // Prevent deletion of important system mailboxes
    const systemMailboxes = ['INBOX', 'Sent', 'Trash', 'Drafts', 'Junk'];
    if (systemMailboxes.includes(trimmedName)) {
      return {
        status: 'error',
        message: `Cannot delete system mailbox '${trimmedName}'`,
      };
    }

    return new Promise((resolve) => {
      this.imap.delBox(trimmedName, (err: Error) => {
        if (err) {
          let errorMessage = err.message;

          // Provide more helpful error messages for common issues
          if (err.message.includes('does not exist')) {
            errorMessage = `Mailbox '${trimmedName}' does not exist`;
          } else if (err.message.includes('not empty')) {
            errorMessage = `Cannot delete mailbox '${trimmedName}' because it contains messages. Please move or delete all messages first.`;
          } else if (err.message.includes('permission')) {
            errorMessage = `Permission denied: Cannot delete mailbox '${trimmedName}'`;
          }

          resolve({
            status: 'error',
            message: errorMessage,
          });
          return;
        }

        resolve({
          status: 'success',
          message: `Mailbox '${trimmedName}' deleted successfully`,
        });
      });
    });
  }

  async moveMessages(
    messageIds: string[],
    sourceMailbox: string,
    destinationMailbox: string
  ): Promise<{ status: string; message: string }> {
    return new Promise((resolve) => {
      this.imap.openBox(sourceMailbox, false, async (err: Error) => {
        if (err) {
          resolve({
            status: 'error',
            message: `Failed to open source mailbox '${sourceMailbox}': ${err.message}`,
          });
          return;
        }

        try {
          const seqnos = await this.resolveMessageIds(messageIds);

          if (seqnos.length === 0) {
            resolve({
              status: 'error',
              message: 'No matching messages found in source mailbox',
            });
            return;
          }

          this.imap.move(seqnos, destinationMailbox, (err: Error) => {
            if (err) {
              resolve({
                status: 'error',
                message: `Failed to move messages: ${err.message}`,
              });
              return;
            }

            resolve({
              status: 'success',
              message: `Successfully moved ${seqnos.length} messages from '${sourceMailbox}' to '${destinationMailbox}'`,
            });
          });
        } catch (e) {
          resolve({
            status: 'error',
            message: `Failed to resolve message IDs: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
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
    } = options;

    return new Promise((resolve, reject) => {
      this.imap.openBox(mailbox, true, (err: Error) => {
        if (err) {
          reject(err);
          return;
        }

        type SearchCriterion =
          | string
          | [string, string | Date]
          | [string, [string, string], [string, string]];
        const searchCriteria: SearchCriterion[] = [];

        if (unreadOnly) {
          searchCriteria.push('UNSEEN');
        }

        if (dateFrom) {
          const date = new Date(dateFrom);
          if (!isNaN(date.getTime())) {
            searchCriteria.push(['SINCE', date]);
          }
        }

        if (dateTo) {
          const date = new Date(dateTo);
          if (!isNaN(date.getTime())) {
            searchCriteria.push(['BEFORE', date]);
          }
        }

        if (fromEmail) {
          searchCriteria.push(['FROM', fromEmail]);
        }

        if (query) {
          searchCriteria.push(['OR', ['SUBJECT', query], ['BODY', query]]);
        }

        if (searchCriteria.length === 0) {
          searchCriteria.push('ALL');
        }

        this.imap.search(searchCriteria, (err: Error, results: number[]) => {
          if (err) {
            reject(err);
            return;
          }

          if (!results || results.length === 0) {
            resolve([]);
            return;
          }

          const messageIds = results.slice(-limit);
          const fetch = this.imap.fetch(messageIds, {
            bodies: '',
            struct: true,
          });

          const messages: EmailMessage[] = [];

          fetch.on('message', (msg: ImapMessage, seqno: number) => {
            let emailData = '';

            msg.on('body', (stream: NodeJS.ReadableStream) => {
              stream.on('data', (chunk: Buffer) => {
                emailData += chunk.toString('utf8');
              });

              stream.once('end', async () => {
                try {
                  const parsed: ParsedMail = await simpleParser(emailData);

                  const attachments: Attachment[] = [];
                  if (parsed.attachments) {
                    parsed.attachments.forEach((att: MailparserAttachment) => {
                      attachments.push({
                        filename: att.filename || 'unknown',
                        contentType:
                          att.contentType || 'application/octet-stream',
                        size: att.size || 0,
                        data: att.content,
                      });
                    });
                  }

                  const getEmailText = (
                    addr:
                      | MailparserAddressObject
                      | MailparserAddressObject[]
                      | undefined
                  ) => {
                    if (!addr) return '';
                    if (Array.isArray(addr))
                      return addr.map((a) => a.text).join(', ');
                    return addr.text;
                  };

                  const emailMessage: EmailMessage = {
                    id: parsed.messageId || `${seqno}`,
                    from: getEmailText(parsed.from),
                    to: parsed.to
                      ? Array.isArray(parsed.to)
                        ? parsed.to.map((t) => getEmailText(t))
                        : [getEmailText(parsed.to)]
                      : [],
                    subject: parsed.subject || '',
                    body: parsed.text || parsed.html || '',
                    date: parsed.date || new Date(),
                    flags: [],
                    attachments:
                      attachments.length > 0 ? attachments : undefined,
                  };

                  messages.push(emailMessage);
                } catch (parseError) {
                  console.error('Error parsing email:', parseError);
                }
              });
            });

            msg.once('attributes', (attrs: ImapMessageAttributes) => {
              if (attrs.flags) {
                const lastMessage = messages[messages.length - 1];
                if (lastMessage) {
                  lastMessage.flags = attrs.flags;
                }
              }
            });
          });

          fetch.once('error', (fetchErr: Error) => {
            reject(fetchErr);
          });

          fetch.once('end', () => {
            resolve(messages);
          });
        });
      });
    });
  }

  async deleteMessages(
    messageIds: string[],
    mailbox: string = 'INBOX'
  ): Promise<{ status: string; message: string }> {
    return new Promise((resolve) => {
      this.imap.openBox(mailbox, false, async (err: Error) => {
        if (err) {
          resolve({
            status: 'error',
            message: `Failed to open mailbox '${mailbox}': ${err.message}`,
          });
          return;
        }

        try {
          const seqnos = await this.resolveMessageIds(messageIds);

          if (seqnos.length === 0) {
            resolve({
              status: 'error',
              message: 'No matching messages found in mailbox',
            });
            return;
          }

          this.imap.addFlags(seqnos, ['\\Deleted'], (err: Error) => {
            if (err) {
              resolve({
                status: 'error',
                message: `Failed to mark messages for deletion: ${err.message}`,
              });
              return;
            }

            this.imap.expunge((err: Error) => {
              if (err) {
                resolve({
                  status: 'error',
                  message: `Failed to expunge deleted messages: ${err.message}`,
                });
                return;
              }

              resolve({
                status: 'success',
                message: `Successfully deleted ${seqnos.length} messages from '${mailbox}'`,
              });
            });
          });
        } catch (e) {
          resolve({
            status: 'error',
            message: `Failed to resolve message IDs: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
    });
  }

  async setFlags(
    messageIds: string[],
    flags: string[],
    mailbox: string = 'INBOX',
    action: 'add' | 'remove' = 'add'
  ): Promise<{ status: string; message: string }> {
    return new Promise((resolve) => {
      this.imap.openBox(mailbox, false, async (err: Error) => {
        if (err) {
          resolve({
            status: 'error',
            message: `Failed to open mailbox '${mailbox}': ${err.message}`,
          });
          return;
        }

        try {
          const seqnos = await this.resolveMessageIds(messageIds);

          if (seqnos.length === 0) {
            resolve({
              status: 'error',
              message: 'No matching messages found in mailbox',
            });
            return;
          }

          const flagOperation = action === 'add' ? 'addFlags' : 'delFlags';

          this.imap[flagOperation](seqnos, flags, (err: Error) => {
            if (err) {
              resolve({
                status: 'error',
                message: `Failed to ${action} flags: ${err.message}`,
              });
              return;
            }

            resolve({
              status: 'success',
              message: `Successfully ${action === 'add' ? 'added' : 'removed'} flags [${flags.join(', ')}] ${action === 'add' ? 'to' : 'from'} ${seqnos.length} messages in '${mailbox}'`,
            });
          });
        } catch (e) {
          resolve({
            status: 'error',
            message: `Failed to resolve message IDs: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
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
    return new Promise((resolve) => {
      this.imap.openBox(mailbox, true, (err: Error) => {
        if (err) {
          resolve({
            status: 'error',
            message: `Failed to open mailbox '${mailbox}': ${err.message}`,
          });
          return;
        }

        this.imap.search(['ALL'], (err: Error, results: number[]) => {
          if (err) {
            resolve({
              status: 'error',
              message: `Failed to search messages: ${err.message}`,
            });
            return;
          }

          if (!results || results.length === 0) {
            resolve({
              status: 'error',
              message: 'No messages found in mailbox',
            });
            return;
          }

          const fetch = this.imap.fetch(results, {
            bodies: '',
            struct: true,
          });

          let found = false;

          fetch.on('message', (msg: ImapMessage, seqno: number) => {
            if (found) return;

            let emailData = '';

            msg.on('body', (stream: NodeJS.ReadableStream) => {
              stream.on('data', (chunk: Buffer) => {
                emailData += chunk.toString('utf8');
              });

              stream.once('end', async () => {
                try {
                  const parsed: ParsedMail = await simpleParser(emailData);

                  if (
                    parsed.messageId === messageId ||
                    `${seqno}` === messageId
                  ) {
                    found = true;

                    if (
                      !parsed.attachments ||
                      parsed.attachments.length === 0
                    ) {
                      resolve({
                        status: 'error',
                        message: 'No attachments found in the message',
                      });
                      return;
                    }

                    if (attachmentIndex >= parsed.attachments.length) {
                      resolve({
                        status: 'error',
                        message: `Attachment index ${attachmentIndex} out of range. Message has ${parsed.attachments.length} attachments`,
                      });
                      return;
                    }

                    const attachment = parsed.attachments[attachmentIndex];

                    resolve({
                      status: 'success',
                      message: `Successfully downloaded attachment '${attachment.filename}'`,
                      attachment: {
                        filename: attachment.filename || 'unknown',
                        contentType:
                          attachment.contentType || 'application/octet-stream',
                        size: attachment.size || 0,
                        data: attachment.content.toString('base64'),
                      },
                    });
                  }
                } catch (parseError) {
                  console.error('Error parsing email:', parseError);
                }
              });
            });
          });

          fetch.once('error', (fetchErr: Error) => {
            resolve({
              status: 'error',
              message: `Failed to fetch messages: ${fetchErr.message}`,
            });
          });

          fetch.once('end', () => {
            if (!found) {
              resolve({
                status: 'error',
                message: `Message with ID '${messageId}' not found`,
              });
            }
          });
        });
      });
    });
  }

  async autoOrganize(
    rules: OrganizationRule[],
    sourceMailbox: string = 'INBOX',
    dryRun: boolean = false
  ): Promise<{
    status: string;
    message: string;
    results: Array<{
      rule: string;
      matchedMessages: number;
      moved: boolean;
      messages?: Array<{
        id: string;
        from: string;
        subject: string;
        destinationMailbox: string;
      }>;
    }>;
  }> {
    try {
      const messages = await this.getMessages(sourceMailbox, 100);
      const results: Array<{
        rule: string;
        matchedMessages: number;
        moved: boolean;
        messages?: Array<{
          id: string;
          from: string;
          subject: string;
          destinationMailbox: string;
        }>;
      }> = [];

      for (const rule of rules) {
        const matchedMessages: Array<{
          id: string;
          from: string;
          subject: string;
          destinationMailbox: string;
        }> = [];

        for (const message of messages) {
          let matches = false;

          if (rule.condition.fromContains) {
            matches =
              matches ||
              message.from
                .toLowerCase()
                .includes(rule.condition.fromContains.toLowerCase());
          }

          if (rule.condition.subjectContains) {
            matches =
              matches ||
              message.subject
                .toLowerCase()
                .includes(rule.condition.subjectContains.toLowerCase());
          }

          if (matches) {
            matchedMessages.push({
              id: message.id,
              from: message.from,
              subject: message.subject,
              destinationMailbox: rule.action.moveToMailbox,
            });
          }
        }

        if (matchedMessages.length > 0) {
          let moved = false;

          if (!dryRun) {
            try {
              const messageIds = matchedMessages.map((m) => m.id);
              await this.moveMessages(
                messageIds,
                sourceMailbox,
                rule.action.moveToMailbox
              );
              moved = true;
            } catch (moveError) {
              console.error(
                `Failed to move messages for rule '${rule.name}':`,
                moveError
              );
            }
          }

          results.push({
            rule: rule.name,
            matchedMessages: matchedMessages.length,
            moved: !dryRun && moved,
            messages: matchedMessages,
          });
        } else {
          results.push({
            rule: rule.name,
            matchedMessages: 0,
            moved: false,
          });
        }
      }

      const totalMatched = results.reduce(
        (sum, result) => sum + result.matchedMessages,
        0
      );

      return {
        status: 'success',
        message: dryRun
          ? `Dry run completed. Found ${totalMatched} messages matching organization rules`
          : `Organization completed. Processed ${totalMatched} messages`,
        results,
      };
    } catch (error) {
      return {
        status: 'error',
        message: `Failed to organize emails: ${error instanceof Error ? error.message : String(error)}`,
        results: [],
      };
    }
  }
}
