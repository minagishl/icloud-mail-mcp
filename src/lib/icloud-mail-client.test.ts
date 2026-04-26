import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { iCloudMailClient } from './icloud-mail-client.js';
import { IcloudMailError } from '../types/config.js';
import type { iCloudConfig } from '../types/config.js';

const mockConfig: iCloudConfig = {
  email: 'test@icloud.com',
  appPassword: 'test-password',
  imapHost: 'imap.mail.me.com',
  imapPort: 993,
  smtpHost: 'smtp.mail.me.com',
  smtpPort: 587,
};

interface MockClient {
  usable: boolean;
  authenticated: boolean;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  messageMove: ReturnType<typeof vi.fn>;
  messageDelete: ReturnType<typeof vi.fn>;
  messageFlagsAdd: ReturnType<typeof vi.fn>;
  messageFlagsRemove: ReturnType<typeof vi.fn>;
  mailboxCreate: ReturnType<typeof vi.fn>;
  mailboxDelete: ReturnType<typeof vi.fn>;
}

let lastClient: MockClient | undefined;

function createMockClient(): MockClient {
  const m: MockClient = {
    usable: true,
    authenticated: true,
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 0, unseen: 0, recent: 0 }),
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockImplementation(async function* () {}),
    fetchOne: vi.fn().mockResolvedValue(null),
    messageMove: vi.fn().mockResolvedValue(undefined),
    messageDelete: vi.fn().mockResolvedValue(undefined),
    messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
    messageFlagsRemove: vi.fn().mockResolvedValue(undefined),
    mailboxCreate: vi.fn().mockResolvedValue({ path: 'NewBox', created: true }),
    mailboxDelete: vi.fn().mockResolvedValue({ path: 'OldBox' }),
  };
  return m;
}

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => {
    const m = createMockClient();
    lastClient = m;
    return m;
  }),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-message-id' }),
    })),
  },
}));

async function* asyncFromArray<T>(arr: T[]) {
  for (const item of arr) yield item;
}

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
    it('creates a client', () => {
      expect(client).toBeInstanceOf(iCloudMailClient);
    });

    it('handles email without @ symbol', () => {
      const c = new iCloudMailClient({ ...mockConfig, email: 'noatsign' });
      expect(c).toBeInstanceOf(iCloudMailClient);
    });
  });

  describe('mutators honor messageIds (catches the entire bug family)', () => {
    it('moveMessages calls messageMove with the supplied UIDs and never fetches the whole mailbox', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 123,
            envelope: {
              messageId: '<a@example.com>',
              from: [{ address: 'a@example.com' }],
              subject: 's1',
            },
          },
          {
            uid: 456,
            envelope: {
              messageId: '<b@example.com>',
              from: [{ address: 'b@example.com' }],
              subject: 's2',
            },
          },
        ])
      );
      // destination search returns empty: nothing already present
      m.search.mockResolvedValue([]);

      const result = await client.moveMessages(
        ['123', '456'],
        'INBOX',
        'Archive'
      );

      expect(m.messageMove).toHaveBeenCalledTimes(1);
      expect(m.messageMove).toHaveBeenCalledWith('123,456', 'Archive', {
        uid: true,
      });
      // critical: never invoked the whole-mailbox fallback
      const fetchCalls = m.fetch.mock.calls.map((c) => c[0] as string);
      expect(fetchCalls.every((arg) => arg !== '1:*' && arg !== 'ALL')).toBe(
        true
      );
      expect(result.moved).toBe(2);
      expect(result.skipped).toBe(0);
    });

    it('deleteMessages calls messageDelete with supplied UIDs', async () => {
      const m = lastClient!;
      const result = await client.deleteMessages(['10', '20'], 'INBOX');
      expect(m.messageDelete).toHaveBeenCalledWith('10,20', { uid: true });
      expect(result.deleted).toBe(2);
    });

    it('setFlags(add) calls messageFlagsAdd with supplied UIDs', async () => {
      const m = lastClient!;
      await client.setFlags(['7'], ['\\Flagged'], 'INBOX', 'add');
      expect(m.messageFlagsAdd).toHaveBeenCalledWith('7', ['\\Flagged'], {
        uid: true,
      });
      expect(m.messageFlagsRemove).not.toHaveBeenCalled();
    });

    it('setFlags(remove) calls messageFlagsRemove with supplied UIDs', async () => {
      const m = lastClient!;
      await client.setFlags(['7'], ['\\Seen'], 'INBOX', 'remove');
      expect(m.messageFlagsRemove).toHaveBeenCalledWith('7', ['\\Seen'], {
        uid: true,
      });
    });

    it('markAsRead delegates to setFlags add \\Seen with supplied UIDs', async () => {
      const m = lastClient!;
      await client.markAsRead(['1', '2', '3'], 'INBOX');
      expect(m.messageFlagsAdd).toHaveBeenCalledWith('1,2,3', ['\\Seen'], {
        uid: true,
      });
    });
  });

  describe('empty messageIds is a no-op (not a whole-mailbox wipe)', () => {
    it('moveMessages with [] does not call messageMove', async () => {
      const m = lastClient!;
      const result = await client.moveMessages([], 'INBOX', 'Archive');
      expect(m.messageMove).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
      expect(result.moved).toBe(0);
    });

    it('deleteMessages with [] does not call messageDelete', async () => {
      const m = lastClient!;
      const result = await client.deleteMessages([], 'INBOX');
      expect(m.messageDelete).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
    });

    it('setFlags with [] does not call any flag operation', async () => {
      const m = lastClient!;
      await client.setFlags([], ['\\Seen'], 'INBOX');
      expect(m.messageFlagsAdd).not.toHaveBeenCalled();
      expect(m.messageFlagsRemove).not.toHaveBeenCalled();
    });
  });

  describe('moveMessages idempotency', () => {
    it('skips messages whose Message-ID already exists in destination', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 100,
            envelope: {
              messageId: '<dup@example.com>',
              from: [{ address: 'a@example.com' }],
              subject: 'dup',
            },
          },
          {
            uid: 200,
            envelope: {
              messageId: '<fresh@example.com>',
              from: [{ address: 'b@example.com' }],
              subject: 'fresh',
            },
          },
        ])
      );
      // First search call (for <dup@>) finds it; second (for <fresh@>) returns empty.
      m.search.mockResolvedValueOnce([999]).mockResolvedValueOnce([]);

      const result = await client.moveMessages(
        ['100', '200'],
        'INBOX',
        'Archive'
      );

      expect(m.messageMove).toHaveBeenCalledWith('200', 'Archive', {
        uid: true,
      });
      expect(result.moved).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedDetails?.[0]).toMatchObject({
        uid: 100,
        reason: 'already present in destination',
      });
    });
  });

  describe('dryRun previews', () => {
    it('move_messages dryRun returns wouldAffect and does not call messageMove', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 5,
            envelope: {
              from: [{ name: 'Alice', address: 'a@example.com' }],
              subject: 'hi',
            },
          },
        ])
      );
      const result = await client.moveMessages(['5'], 'INBOX', 'Archive', {
        dryRun: true,
      });
      expect(m.messageMove).not.toHaveBeenCalled();
      expect(result.wouldAffect).toHaveLength(1);
      expect(result.wouldAffect?.[0].id).toBe('5');
    });

    it('delete_messages dryRun returns wouldAffect and does not call messageDelete', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 9,
            envelope: {
              from: [{ address: 'x@example.com' }],
              subject: 't',
            },
          },
        ])
      );
      const result = await client.deleteMessages(['9'], 'INBOX', {
        dryRun: true,
      });
      expect(m.messageDelete).not.toHaveBeenCalled();
      expect(result.wouldAffect).toHaveLength(1);
    });
  });

  describe('getMailboxes — flat output, JSON-serializable', () => {
    it('returns flat array with path/name/delimiter/flags', async () => {
      const m = lastClient!;
      m.list.mockResolvedValue([
        {
          path: 'INBOX',
          name: 'INBOX',
          delimiter: '/',
          flags: new Set(['\\HasChildren']),
          specialUse: undefined,
        },
        {
          path: 'Test/A/B',
          name: 'B',
          delimiter: '/',
          flags: new Set(['\\HasNoChildren']),
        },
      ]);
      const result = await client.getMailboxes();
      expect(result).toHaveLength(2);
      expect(result[1].path).toBe('Test/A/B');
      // The whole point of T1.2: must round-trip JSON without circular refs
      expect(() => JSON.stringify(result)).not.toThrow();
      const json = JSON.stringify(result);
      expect(json).toContain('"path":"Test/A/B"');
    });
  });

  describe('getMailboxStats', () => {
    it('returns total/unread/recent shape', async () => {
      const m = lastClient!;
      m.status.mockResolvedValue({
        messages: 9331,
        unseen: 1884,
        recent: 12,
      });
      const stats = await client.getMailboxStats('INBOX');
      expect(stats).toEqual({
        mailbox: 'INBOX',
        total: 9331,
        unread: 1884,
        recent: 12,
      });
    });
  });

  describe('ensureConnected — auto-reconnect after close', () => {
    it('reconnects when client becomes unusable', async () => {
      const m = lastClient!;
      m.usable = false;
      m.authenticated = false;
      await client.ensureConnected();
      expect(m.connect).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when already connected', async () => {
      const m = lastClient!;
      m.usable = true;
      m.authenticated = true;
      await client.ensureConnected();
      expect(m.connect).not.toHaveBeenCalled();
    });
  });

  describe('metadataOnly fetches', () => {
    it('does not request source body when metadataOnly=true', async () => {
      const m = lastClient!;
      m.search.mockResolvedValue([1]);
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              from: [{ address: 'a@example.com' }],
              to: [{ address: 'b@example.com' }],
              subject: 'meta',
              messageId: '<m@example.com>',
            },
            flags: new Set(['\\Seen']),
          },
        ])
      );
      const messages = await client.getMessages('INBOX', 10, false, {
        metadataOnly: true,
      });
      const fetchQuery = m.fetch.mock.calls[0][1] as Record<string, unknown>;
      expect(fetchQuery.source).toBeUndefined();
      expect(fetchQuery.envelope).toBe(true);
      expect(messages[0].body).toBe('');
      expect(messages[0].id).toBe('1');
      expect(messages[0].uid).toBe(1);
      expect(messages[0].mailbox).toBe('INBOX');
    });
  });

  describe('error mapping', () => {
    it('maps AUTHENTICATIONFAILED to kind=auth retryable=false', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() => {
        throw new Error('AUTHENTICATIONFAILED: bad password');
      });
      m.search.mockResolvedValue([1]);
      await expect(client.getMessages('INBOX', 1, false)).rejects.toMatchObject(
        {
          kind: 'auth',
          retryable: false,
        }
      );
    });

    it('maps timeout to kind=network retryable=true', async () => {
      const m = lastClient!;
      m.search.mockRejectedValue(new Error('socket timeout after 30s'));
      let caught: unknown;
      try {
        await client.getMessages('INBOX', 1, false);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(IcloudMailError);
      expect((caught as IcloudMailError).kind).toBe('network');
      expect((caught as IcloudMailError).retryable).toBe(true);
    });

    it('rejects non-numeric messageIds with invalid_input error', async () => {
      let caught: unknown;
      try {
        await client.deleteMessages(['<not-a-uid>'], 'INBOX');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(IcloudMailError);
      expect((caught as IcloudMailError).kind).toBe('invalid_input');
    });
  });
});
