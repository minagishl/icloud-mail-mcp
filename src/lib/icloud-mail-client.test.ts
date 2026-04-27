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
    it('rebuilds the client and connects when previous instance is unusable', async () => {
      // Bug #19 fix: doConnect() rebuilds before connect() because ImapFlow
      // throws "Can not re-use ImapFlow instance" if you call connect() on a
      // closed instance. The old client's connect() must NOT be called.
      const old = lastClient!;
      old.usable = false;
      old.authenticated = false;
      await client.ensureConnected();
      const fresh = lastClient!;
      expect(fresh).not.toBe(old);
      expect(fresh.connect).toHaveBeenCalledTimes(1);
      expect(old.connect).not.toHaveBeenCalled();
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

  describe('dead-client recovery (bug #19)', () => {
    it('catches "Can not re-use ImapFlow instance" mid-operation, rebuilds, and retries once', async () => {
      const initial = lastClient!;
      let messageMoveCalls = 0;
      initial.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              messageId: '<a@example.com>',
              from: [{ address: 'a@example.com' }],
              subject: 's',
            },
          },
        ])
      );
      initial.search.mockResolvedValue([]); // dest is empty
      initial.messageMove.mockImplementation(async () => {
        messageMoveCalls++;
        if (messageMoveCalls === 1) {
          throw new Error('Can not re-use ImapFlow instance');
        }
      });

      const result = await client.moveMessages(['1'], 'INBOX', 'Archive', {
        verifyCounts: false,
      });

      // After the wedge, the client should be rebuilt and the move retried.
      expect(messageMoveCalls).toBeGreaterThanOrEqual(1);
      // lastClient is now the rebuilt instance — different identity.
      expect(lastClient!).not.toBe(initial);
      expect(result.status).toBe('success');
    });

    it('does NOT retry on non-wedge errors (e.g. AUTHENTICATIONFAILED)', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              messageId: '<a@example.com>',
              from: [{ address: 'a@example.com' }],
              subject: 's',
            },
          },
        ])
      );
      m.search.mockResolvedValue([]);
      m.messageMove.mockRejectedValue(
        new Error('AUTHENTICATIONFAILED: bad password')
      );

      let caught: unknown;
      try {
        await client.moveMessages(['1'], 'INBOX', 'Archive', {
          verifyCounts: false,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(IcloudMailError);
      expect((caught as IcloudMailError).kind).toBe('auth');
      // Mock was called only once — no rebuild + retry path triggered.
      expect(m.messageMove).toHaveBeenCalledTimes(1);
    });
  });

  describe('count verification (bug #20)', () => {
    it('returns counts and no warning when source/dest deltas match expected', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              messageId: '<a@example.com>',
              from: [{ address: 'a@example.com' }],
              subject: 's',
            },
          },
          {
            uid: 2,
            envelope: {
              messageId: '<b@example.com>',
              from: [{ address: 'b@example.com' }],
              subject: 's',
            },
          },
        ])
      );
      m.search.mockResolvedValue([]); // dest empty
      // Sequence of 4 status calls: source-before, dest-before, source-after, dest-after.
      m.status
        .mockResolvedValueOnce({ messages: 100, unseen: 0, recent: 0 })
        .mockResolvedValueOnce({ messages: 0, unseen: 0, recent: 0 })
        .mockResolvedValueOnce({ messages: 98, unseen: 0, recent: 0 })
        .mockResolvedValueOnce({ messages: 2, unseen: 0, recent: 0 });

      const result = await client.moveMessages(['1', '2'], 'INBOX', 'Archive');
      expect(result.counts).toEqual({
        expected: 2,
        sourceBefore: 100,
        sourceAfter: 98,
        sourceDelta: 2,
        destBefore: 0,
        destAfter: 2,
        destDelta: 2,
      });
      expect(result.countWarning).toBeUndefined();
    });

    it('surfaces countWarning when destination grows by more than expected', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              messageId: '<a@example.com>',
              from: [{ address: 'a@example.com' }],
              subject: 's',
            },
          },
        ])
      );
      m.search.mockResolvedValue([]);
      // Destination grew by 50 even though we only attempted 1 move.
      m.status
        .mockResolvedValueOnce({ messages: 100, unseen: 0, recent: 0 })
        .mockResolvedValueOnce({ messages: 0, unseen: 0, recent: 0 })
        .mockResolvedValueOnce({ messages: 99, unseen: 0, recent: 0 })
        .mockResolvedValueOnce({ messages: 50, unseen: 0, recent: 0 });

      const result = await client.moveMessages(['1'], 'INBOX', 'Archive');
      expect(result.countWarning).toBeDefined();
      expect(result.countWarning).toMatch(/destination/i);
      expect(result.counts?.destDelta).toBe(50);
    });

    it('skips count verification when verifyCounts: false', async () => {
      const m = lastClient!;
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              messageId: '<a@example.com>',
              from: [{ address: 'a@example.com' }],
              subject: 's',
            },
          },
        ])
      );
      m.search.mockResolvedValue([]);

      const result = await client.moveMessages(['1'], 'INBOX', 'Archive', {
        verifyCounts: false,
      });
      expect(m.status).not.toHaveBeenCalled();
      expect(result.counts).toBeUndefined();
      expect(result.countWarning).toBeUndefined();
    });

    it('deleteMessages count verification produces sourceDelta', async () => {
      const m = lastClient!;
      m.status
        .mockResolvedValueOnce({ messages: 50, unseen: 0, recent: 0 })
        .mockResolvedValueOnce({ messages: 49, unseen: 0, recent: 0 });

      const result = await client.deleteMessages(['7'], 'INBOX');
      expect(result.counts).toEqual({
        expected: 1,
        sourceBefore: 50,
        sourceAfter: 49,
        sourceDelta: 1,
      });
      expect(result.countWarning).toBeUndefined();
    });
  });

  describe('autoOrganize time budget + partial progress', () => {
    it('marks rules as pending when budget is already exhausted', async () => {
      // Use timeBudgetMs: -1 for deterministic exhaustion: any elapsed time
      // (including 0) exceeds -1, so every rule with matches gets flagged
      // pending. This tests the partial-progress reporting machinery without
      // fighting real-time clocks under vitest.
      const m = lastClient!;
      m.search.mockResolvedValue([1, 2]);
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              from: [{ address: 'foo@example.com' }],
              subject: 'sub1',
              messageId: '<1@example.com>',
            },
            flags: new Set(),
          },
          {
            uid: 2,
            envelope: {
              from: [{ address: 'bar@example.com' }],
              subject: 'sub2',
              messageId: '<2@example.com>',
            },
            flags: new Set(),
          },
        ])
      );

      const result = await client.autoOrganize(
        [
          {
            name: 'rule-1',
            condition: { fromContains: 'foo@example.com' },
            action: { moveToMailbox: 'A' },
          },
          {
            name: 'rule-2',
            condition: { fromContains: 'bar@example.com' },
            action: { moveToMailbox: 'B' },
          },
        ],
        'INBOX',
        false,
        100,
        -1 // already-exhausted budget
      );

      expect(result.progress.rulesTotal).toBe(2);
      expect(result.progress.rulesPending).toBe(2);
      expect(result.progress.rulesCompleted).toBe(0);
      expect(result.progress.stoppedReason).toBeDefined();
      expect(result.progress.stoppedReason).toMatch(/budget/i);
      // Critical: the destructive operation must NOT have run on any pending rule.
      expect(m.messageMove).not.toHaveBeenCalled();
      expect(result.results.every((r) => r.ruleStatus === 'pending')).toBe(
        true
      );
    });

    it('marks rules as completed when within budget', async () => {
      const m = lastClient!;
      m.search.mockResolvedValue([1]);
      m.fetch.mockImplementation(() =>
        asyncFromArray([
          {
            uid: 1,
            envelope: {
              from: [{ address: 'foo@example.com' }],
              subject: 's',
              messageId: '<1@example.com>',
            },
            flags: new Set(),
          },
        ])
      );

      const result = await client.autoOrganize(
        [
          {
            name: 'rule-1',
            condition: { fromContains: 'foo@example.com' },
            action: { moveToMailbox: 'A' },
          },
        ],
        'INBOX',
        true, // dryRun — instant
        100,
        5000
      );
      expect(result.progress.rulesPending).toBe(0);
      expect(result.progress.rulesCompleted).toBe(1);
      expect(result.progress.stoppedReason).toBeUndefined();
    });
  });
});
