import { describe, it, expect } from 'vitest';
import type {
  iCloudConfig,
  EmailMessage,
  Attachment,
  SendEmailOptions,
  SearchOptions,
  OrganizationRule,
} from './config.js';

describe('Config Types', () => {
  describe('iCloudConfig', () => {
    it('should accept valid minimal config', () => {
      const config: iCloudConfig = {
        email: 'test@icloud.com',
        appPassword: 'app-password',
      };

      expect(config.email).toBe('test@icloud.com');
      expect(config.appPassword).toBe('app-password');
    });

    it('should accept full config with optional properties', () => {
      const config: iCloudConfig = {
        email: 'test@icloud.com',
        appPassword: 'app-password',
        imapHost: 'imap.mail.me.com',
        imapPort: 993,
        smtpHost: 'smtp.mail.me.com',
        smtpPort: 587,
      };

      expect(config.imapHost).toBe('imap.mail.me.com');
      expect(config.imapPort).toBe(993);
      expect(config.smtpHost).toBe('smtp.mail.me.com');
      expect(config.smtpPort).toBe(587);
    });
  });

  describe('EmailMessage', () => {
    it('should create valid email message', () => {
      const message: EmailMessage = {
        id: '123',
        uid: 123,
        rfc822MessageId: '<abc@example.com>',
        mailbox: 'INBOX',
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Test body content',
        date: new Date('2024-01-01'),
        flags: ['\\Seen'],
      };

      expect(message.id).toBe('123');
      expect(message.uid).toBe(123);
      expect(message.rfc822MessageId).toBe('<abc@example.com>');
      expect(message.mailbox).toBe('INBOX');
      expect(message.from).toBe('sender@example.com');
      expect(message.to).toEqual(['recipient@example.com']);
      expect(message.subject).toBe('Test Subject');
      expect(message.body).toBe('Test body content');
      expect(message.flags).toEqual(['\\Seen']);
    });

    it('should accept email message with attachments', () => {
      const attachment: Attachment = {
        filename: 'test.txt',
        contentType: 'text/plain',
        size: 1024,
        data: Buffer.from('test content'),
      };

      const message: EmailMessage = {
        id: '123',
        uid: 123,
        mailbox: 'INBOX',
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Test body content',
        date: new Date('2024-01-01'),
        flags: ['\\Seen'],
        attachments: [attachment],
      };

      expect(message.attachments).toHaveLength(1);
      expect(message.attachments?.[0].filename).toBe('test.txt');
    });
  });

  describe('SendEmailOptions', () => {
    it('should accept minimal send email options', () => {
      const options: SendEmailOptions = {
        to: 'recipient@example.com',
        subject: 'Test Subject',
      };

      expect(options.to).toBe('recipient@example.com');
      expect(options.subject).toBe('Test Subject');
    });

    it('should accept send email options with multiple recipients', () => {
      const options: SendEmailOptions = {
        to: ['recipient1@example.com', 'recipient2@example.com'],
        subject: 'Test Subject',
        text: 'Plain text content',
        html: '<p>HTML content</p>',
      };

      expect(Array.isArray(options.to)).toBe(true);
      expect(options.to).toHaveLength(2);
      expect(options.text).toBe('Plain text content');
      expect(options.html).toBe('<p>HTML content</p>');
    });

    it('should accept send email options with attachments', () => {
      const options: SendEmailOptions = {
        to: 'recipient@example.com',
        subject: 'Test Subject',
        attachments: [
          {
            filename: 'test.txt',
            content: Buffer.from('test content'),
            contentType: 'text/plain',
          },
        ],
      };

      expect(options.attachments).toHaveLength(1);
      expect(options.attachments?.[0].filename).toBe('test.txt');
    });
  });

  describe('SearchOptions', () => {
    it('should accept empty search options', () => {
      const options: SearchOptions = {};

      expect(typeof options).toBe('object');
    });

    it('should accept full search options', () => {
      const options: SearchOptions = {
        query: 'test query',
        mailbox: 'INBOX',
        limit: 10,
        dateFrom: '2024-01-01',
        dateTo: '2024-01-31',
        fromEmail: 'sender@example.com',
        unreadOnly: true,
      };

      expect(options.query).toBe('test query');
      expect(options.mailbox).toBe('INBOX');
      expect(options.limit).toBe(10);
      expect(options.dateFrom).toBe('2024-01-01');
      expect(options.dateTo).toBe('2024-01-31');
      expect(options.fromEmail).toBe('sender@example.com');
      expect(options.unreadOnly).toBe(true);
    });
  });

  describe('OrganizationRule', () => {
    it('should create organization rule with subject condition', () => {
      const rule: OrganizationRule = {
        name: 'Newsletter Rule',
        condition: {
          subjectContains: 'Newsletter',
        },
        action: {
          moveToMailbox: 'Newsletters',
        },
      };

      expect(rule.name).toBe('Newsletter Rule');
      expect(rule.condition.subjectContains).toBe('Newsletter');
      expect(rule.action.moveToMailbox).toBe('Newsletters');
    });

    it('should create organization rule with from condition', () => {
      const rule: OrganizationRule = {
        name: 'Work Email Rule',
        condition: {
          fromContains: '@company.com',
        },
        action: {
          moveToMailbox: 'Work',
        },
      };

      expect(rule.condition.fromContains).toBe('@company.com');
      expect(rule.action.moveToMailbox).toBe('Work');
    });

    it('should create organization rule with multiple conditions', () => {
      const rule: OrganizationRule = {
        name: 'Complex Rule',
        condition: {
          fromContains: '@github.com',
          subjectContains: '[notification]',
        },
        action: {
          moveToMailbox: 'GitHub Notifications',
        },
      };

      expect(rule.condition.fromContains).toBe('@github.com');
      expect(rule.condition.subjectContains).toBe('[notification]');
    });
  });

  describe('Attachment', () => {
    it('should create valid attachment', () => {
      const attachment: Attachment = {
        filename: 'document.pdf',
        contentType: 'application/pdf',
        size: 2048,
        data: Buffer.from('PDF content'),
      };

      expect(attachment.filename).toBe('document.pdf');
      expect(attachment.contentType).toBe('application/pdf');
      expect(attachment.size).toBe(2048);
      expect(Buffer.isBuffer(attachment.data)).toBe(true);
    });
  });
});
