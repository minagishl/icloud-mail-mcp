import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { iCloudMailClient } from './icloud-mail-client.js';
import type { iCloudConfig } from '../types/config.js';

const mockConfig: iCloudConfig = {
  email: 'test@icloud.com',
  appPassword: 'test-password',
  imapHost: 'imap.mail.me.com',
  imapPort: 993,
  smtpHost: 'smtp.mail.me.com',
  smtpPort: 587,
};

// Mock the dependencies
vi.mock('imap', () => ({
  default: vi.fn().mockImplementation(() => ({
    state: 'authenticated',
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    serverSupports: vi.fn(() => true),
    connect: vi.fn(),
    end: vi.fn(),
    getBoxes: vi.fn(),
    openBox: vi.fn(),
    search: vi.fn(),
    fetch: vi.fn(),
    move: vi.fn(),
    addFlags: vi.fn(),
    delFlags: vi.fn(),
    expunge: vi.fn(),
    setFlags: vi.fn(),
    addBox: vi.fn(),
    delBox: vi.fn(),
  })),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-message-id' }),
    })),
  },
}));

describe('iCloudMailClient', () => {
  let client: iCloudMailClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new iCloudMailClient(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create client with valid config', () => {
      expect(client).toBeInstanceOf(iCloudMailClient);
    });

    it('should create client with different email format', () => {
      const configWithDifferentEmail = {
        ...mockConfig,
        email: 'john@icloud.com',
      };
      const testClient = new iCloudMailClient(configWithDifferentEmail);
      expect(testClient).toBeInstanceOf(iCloudMailClient);
    });
  });

  describe('email name extraction behavior', () => {
    it('should handle email with @ symbol correctly', () => {
      const configWithEmail = {
        ...mockConfig,
        email: 'john@icloud.com',
      };
      const testClient = new iCloudMailClient(configWithEmail);
      expect(testClient).toBeInstanceOf(iCloudMailClient);
    });

    it('should handle email without @ symbol', () => {
      const configWithSimpleName = {
        ...mockConfig,
        email: 'john',
      };
      const testClient = new iCloudMailClient(configWithSimpleName);
      expect(testClient).toBeInstanceOf(iCloudMailClient);
    });

    it('should handle empty email string', () => {
      const configWithEmptyEmail = {
        ...mockConfig,
        email: '',
      };
      const testClient = new iCloudMailClient(configWithEmptyEmail);
      expect(testClient).toBeInstanceOf(iCloudMailClient);
    });
  });

  describe('basic functionality', () => {
    it('should be created with correct configuration', () => {
      expect(client).toBeDefined();
    });

    it('should handle config validation', () => {
      const minimalConfig: iCloudConfig = {
        email: 'test@example.com',
        appPassword: 'password',
      };
      const minimalClient = new iCloudMailClient(minimalConfig);
      expect(minimalClient).toBeInstanceOf(iCloudMailClient);
    });
  });

  describe('acting on message IDs', () => {
    type Imap = Record<string, ReturnType<typeof vi.fn>>;
    let imap: Imap;

    beforeEach(() => {
      imap = (client as unknown as { imap: Imap }).imap;
      imap.openBox.mockImplementation((_box, _ro, cb) => cb(null));
      // UID 42 has the given Message-ID; sequence number 7 maps to UID 7.
      imap.search.mockImplementation((criteria, cb) => {
        const [c] = criteria;
        if (Array.isArray(c) && c[2] === '<a@example.com>') cb(null, [42]);
        else if (c === '7') cb(null, [7]);
        else cb(null, []);
      });
      imap.move.mockImplementation((_uids, _dest, cb) => cb(null));
      imap.addFlags.mockImplementation((_uids, _flags, cb) => cb(null));
      imap.expunge.mockImplementation((...args) => args[args.length - 1](null));
    });

    it('moves only the messages whose IDs were given', async () => {
      const result = await client.moveMessages(
        ['<a@example.com>', '7'],
        'INBOX',
        'Archive'
      );
      expect(result.status).toBe('success');
      expect(imap.search).not.toHaveBeenCalledWith(['ALL'], expect.anything());
      expect(imap.move).toHaveBeenCalledWith(
        [42, 7],
        'Archive',
        expect.any(Function)
      );
    });

    it('does nothing when no ID matches', async () => {
      const result = await client.deleteMessages(['<missing@example.com>']);
      expect(result.status).toBe('error');
      expect(imap.addFlags).not.toHaveBeenCalled();
      expect(imap.expunge).not.toHaveBeenCalled();
    });

    it('ignores IDs that are neither a Message-ID nor a number', async () => {
      const result = await client.setFlags(['ALL', '1:*'], ['\\Flagged']);
      expect(result.status).toBe('error');
      expect(imap.search).not.toHaveBeenCalled();
      expect(imap.addFlags).not.toHaveBeenCalled();
    });

    it('expunges only the deleted UIDs', async () => {
      await client.deleteMessages(['<a@example.com>']);
      expect(imap.expunge).toHaveBeenCalledWith([42], expect.any(Function));
    });
  });

  describe('getMessages', () => {
    it('waits for every message to finish parsing', async () => {
      const imap = (
        client as unknown as { imap: Record<string, ReturnType<typeof vi.fn>> }
      ).imap;
      imap.openBox.mockImplementation(
        (_box: string, _ro: boolean, cb: (e: null) => void) => cb(null)
      );
      imap.search.mockImplementation(
        (_c: unknown, cb: (e: null, r: number[]) => void) => cb(null, [1, 2, 3])
      );
      imap.fetch.mockImplementation(() => {
        const fetch = new EventEmitter();
        setImmediate(() => {
          for (const n of [1, 2, 3]) {
            const msg = new EventEmitter();
            fetch.emit('message', msg, n);
            const body = new EventEmitter();
            msg.emit('body', body, {});
            body.emit(
              'data',
              Buffer.from(
                `Message-ID: <m${n}@example.com>\r\nSubject: s${n}\r\n\r\nbody ${n}\r\n`
              )
            );
            body.emit('end');
            msg.emit('attributes', { flags: [`\\F${n}`] });
            msg.emit('end');
          }
          // 'end' fires before any async parse has completed
          fetch.emit('end');
        });
        return fetch;
      });

      const messages = await client.getMessages('INBOX', 10);
      expect(messages.map((m) => m.subject).sort()).toEqual(['s1', 's2', 's3']);
      const m2 = messages.find((m) => m.subject === 's2');
      expect(m2?.flags).toEqual(['\\F2']);
    });
  });
});
