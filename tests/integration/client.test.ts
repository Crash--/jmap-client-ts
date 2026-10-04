import { beforeAll, describe, expect, it } from 'vitest';

import {
  assertSetSucceeded,
  CAPABILITIES,
  createClient,
  JmapMethodError,
} from '../../src/index.js';
import type { JmapClient, Mailbox, PushStatus, StateChange } from '../../src/index.js';
import { ALICE, basicAuth, BOB, SESSION_URL } from './environment.js';

function makeClient(user: { username: string; password: string }): JmapClient {
  return createClient({
    sessionUrl: SESSION_URL,
    auth: { getAuthorizationHeader: () => basicAuth(user) },
  });
}

async function waitUntil<T>(
  description: string,
  probe: () => Promise<T | null>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function findMailboxId(mailboxes: Pick<Mailbox, 'id' | 'role'>[], role: string): string {
  const mailbox = mailboxes.find(candidate => candidate.role === role);
  if (mailbox === undefined) {
    throw new Error(`No ${role} mailbox`);
  }
  return mailbox.id;
}

const alice = makeClient(ALICE);
const bob = makeClient(BOB);
let aliceAccountId = '';
let bobAccountId = '';

beforeAll(async () => {
  await Promise.all([alice.getSession(), bob.getSession()]);
  aliceAccountId = alice.getPrimaryAccountId();
  bobAccountId = bob.getPrimaryAccountId();
});

describe('tmail-backend', () => {
  it('loads the session', async () => {
    const session = await alice.getSession();

    expect(session.username).toBe(ALICE.username);
    expect(alice.hasCapability(CAPABILITIES.mail)).toBe(true);
    expect(alice.hasCapability(CAPABILITIES.webSocketTicket)).toBe(true);
    expect(aliceAccountId).not.toBe(bobAccountId);
  });

  it('lists mailboxes with narrowed properties', async () => {
    const response = await alice.call('Mailbox/get', {
      accountId: aliceAccountId,
      ids: null,
      properties: ['name', 'role', 'totalEmails'],
    });

    expect(findMailboxId(response.list, 'inbox')).toEqual(expect.any(String));
    expect(response.list[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      role: expect.toBeOneOf([expect.any(String), null]),
      totalEmails: expect.any(Number),
    });
  });

  it('reads identities', async () => {
    const response = await alice.call('Identity/get', { accountId: aliceAccountId, ids: null });

    expect(response.list.map(identity => identity.email)).toContain(ALICE.username);
  });

  it('reads quotas when the server supports RFC 9425', async () => {
    if (!alice.hasCapability(CAPABILITIES.quota)) {
      return;
    }
    const response = await alice.call('Quota/get', { accountId: aliceAccountId, ids: null });

    expect(response.list.length).toBeGreaterThan(0);
    expect(response.list[0]).toMatchObject({
      resourceType: expect.any(String),
      used: expect.any(Number),
    });
  });

  it('reports method errors', async () => {
    const error = await alice
      .call('Mailbox/get', { accountId: 'not-an-account', ids: null })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JmapMethodError);
    expect(error).toMatchObject({ type: 'accountNotFound', methodName: 'Mailbox/get' });
  });

  it('uploads and downloads a blob', async () => {
    const content = `blob ${Date.now()} é`;

    const uploaded = await alice.upload(
      aliceAccountId,
      new Blob([content], { type: 'text/plain' }),
    );
    const downloaded = await alice.download({
      accountId: aliceAccountId,
      blobId: uploaded.blobId,
      name: 'note.txt',
      type: 'text/plain',
    });

    expect(uploaded.size).toBe(new TextEncoder().encode(content).length);
    expect(await downloaded.text()).toBe(content);
    expect(alice.getDownloadUrl({ accountId: aliceAccountId, blobId: uploaded.blobId })).toContain(
      uploaded.blobId,
    );
  });

  it('sends a mail from bob to alice and pushes the change over WebSocket', async () => {
    const subject = `Integration ${Date.now()}`;
    const push = alice.connectWebSocket({ dataTypes: ['Email', 'Mailbox'] });
    const changes: StateChange[] = [];
    const statuses: PushStatus[] = [];
    const errors: unknown[] = [];
    push.on('stateChange', change => changes.push(change));
    push.on('status', status => statuses.push(status));
    push.on('error', error => errors.push(error));

    try {
      await waitUntil('WebSocket open', () =>
        Promise.resolve(push.status === 'open' ? true : null),
      );

      // Bob drafts and sends in one request.
      const [mailboxes, identities] = await bob.request(b => [
        b.call('Mailbox/get', { accountId: bobAccountId, ids: null, properties: ['role'] }),
        b.call('Identity/get', { accountId: bobAccountId, ids: null }),
      ]);
      const draftsId = findMailboxId(mailboxes.list, 'drafts');
      const sentId = findMailboxId(mailboxes.list, 'sent');
      const identity = identities.list.find(candidate => candidate.email === BOB.username);
      if (identity === undefined) {
        throw new Error('No identity for bob');
      }
      const [created, submitted] = await bob.request(b => [
        b.call('Email/set', {
          accountId: bobAccountId,
          create: {
            draft: {
              mailboxIds: { [draftsId]: true },
              keywords: { $draft: true, $seen: true },
              from: [{ name: 'Bob', email: BOB.username }],
              to: [{ name: 'Alice', email: ALICE.username }],
              subject,
              bodyValues: { body: { value: 'Hello Alice' } },
              textBody: [{ partId: 'body', type: 'text/plain' }],
            },
          },
        }),
        b.call('EmailSubmission/set', {
          accountId: bobAccountId,
          create: { send: { identityId: identity.id, emailId: '#draft' } },
          onSuccessUpdateEmail: {
            '#send': {
              [`mailboxIds/${draftsId}`]: null,
              [`mailboxIds/${sentId}`]: true,
              'keywords/$draft': null,
            },
          },
        }),
      ]);
      assertSetSucceeded(created);
      assertSetSucceeded(submitted);
      expect(created.created?.draft?.id).toEqual(expect.any(String));

      // Alice finds it with a query and a back-referenced get.
      const emails = await waitUntil('delivery to alice', async () => {
        const [, found] = await alice.request(b => {
          const query = b.call('Email/query', {
            accountId: aliceAccountId,
            filter: { subject },
            sort: [{ property: 'receivedAt', isAscending: false }],
          });
          const get = b.call('Email/get', {
            accountId: aliceAccountId,
            '#ids': query.ref('/ids'),
            properties: ['subject', 'from', 'preview', 'mailboxIds'],
          });
          return [query, get];
        });
        return found.list.length > 0 ? found.list : null;
      });
      expect(emails[0]).toMatchObject({
        subject,
        from: [{ email: BOB.username }],
        preview: expect.stringContaining('Hello Alice'),
      });

      const change = await waitUntil('Email state change', () =>
        Promise.resolve(
          changes.find(candidate => candidate.changed[aliceAccountId]?.Email !== undefined) ?? null,
        ),
      );
      expect(change['@type']).toBe('StateChange');
      expect(errors).toEqual([]);
      expect(statuses).toContain('open');
    } finally {
      push.close();
    }
  });
});
