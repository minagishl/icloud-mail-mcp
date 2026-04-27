export interface iCloudConfig {
  email: string;
  appPassword: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

export interface EmailMessage {
  id: string;
  uid: number;
  rfc822MessageId?: string;
  mailbox: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  date: Date;
  flags: string[];
  attachments?: Attachment[];
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  data: Buffer;
}

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: Buffer;
    contentType?: string;
  }>;
}

export interface FetchOptions {
  metadataOnly?: boolean;
  bodyPreview?: number;
}

export interface SearchOptions extends FetchOptions {
  query?: string;
  mailbox?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  fromEmail?: string;
  unreadOnly?: boolean;
}

export interface OrganizationRule {
  name: string;
  condition: {
    fromContains?: string;
    subjectContains?: string;
  };
  action: {
    moveToMailbox: string;
  };
}

export interface MailboxInfo {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
}

export interface MailboxStats {
  mailbox: string;
  total: number;
  unread: number;
  recent: number;
}

export type IcloudMailErrorKind =
  | 'auth'
  | 'network'
  | 'rate_limit'
  | 'not_found'
  | 'invalid_input'
  | 'server';

export class IcloudMailError extends Error {
  kind: IcloudMailErrorKind;
  retryable: boolean;
  override cause?: unknown;

  constructor(
    kind: IcloudMailErrorKind,
    message: string,
    options?: { retryable?: boolean; cause?: unknown }
  ) {
    super(message);
    this.name = 'IcloudMailError';
    this.kind = kind;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      retryable: this.retryable,
      message: this.message,
    };
  }
}
