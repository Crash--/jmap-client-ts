/** Snippets of the README, kept compiling. */
import { describe, it } from 'vitest';

import { assertSetSucceeded, createClient } from '../../src/index.js';

declare const tokens: { getAccessToken(): Promise<string>; refresh(): Promise<boolean> };
declare function render(emails: unknown[], snippets: unknown[]): void;

describe('README', () => {
  it('quick start compiles', async () => {
    const client = createClient({
      sessionUrl: 'https://jmap.example.com/jmap/session',
      auth: {
        getAuthorizationHeader: async () => `Bearer ${await tokens.getAccessToken()}`,
        onUnauthorized: async () => tokens.refresh(),
      },
      methodCapabilities: { 'Label/get': 'com:linagora:params:jmap:labels' },
    });
    await client.getSession();
    const accountId = client.getPrimaryAccountId();
    const { list: mailboxes } = await client.call('Mailbox/get', { accountId, ids: null });
    const inbox = mailboxes.find(mailbox => mailbox.role === 'inbox');
    const [query, emails] = await client.request(b => {
      const q = b.call('Email/query', {
        accountId,
        filter: { inMailbox: inbox?.id },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 50,
        calculateTotal: true,
      });
      const g = b.call('Email/get', {
        accountId,
        '#ids': q.ref('/ids'),
        properties: ['subject', 'from', 'receivedAt', 'keywords', 'preview'],
      });
      return [q, g];
    });
    console.log(query.total, emails.list[0]?.subject);

    const draftsId = 'd';
    const sentId = 's';
    const identityId = 'i';
    const [created, submitted] = await client.request(b => [
      b.call('Email/set', {
        accountId,
        create: {
          draft: {
            mailboxIds: { [draftsId]: true },
            keywords: { $draft: true, $seen: true },
            from: [{ name: 'Bob', email: 'bob@example.com' }],
            to: [{ name: 'Alice', email: 'alice@example.com' }],
            subject: 'Hello',
            bodyValues: { body: { value: 'Hi Alice' } },
            textBody: [{ partId: 'body', type: 'text/plain' }],
          },
        },
      }),
      b.call('EmailSubmission/set', {
        accountId,
        create: { send: { identityId, emailId: '#draft' } },
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

    const [found, snippets] = await client.requestSettled(b => {
      const q = b.call('Email/query', { accountId, filter: { text: 'invoice' } });
      return [
        b.call('Email/get', { accountId, '#ids': q.ref('/ids'), properties: ['subject'] }),
        b.call('SearchSnippet/get', {
          accountId,
          filter: { text: 'invoice' },
          '#emailIds': q.ref('/ids'),
        }),
      ];
    });
    if (found.ok) render(found.value.list, snippets.ok ? snippets.value.list : []);

    const push = client.connectWebSocket({
      dataTypes: ['Email', 'Mailbox', 'Thread', 'EmailDelivery'],
      ping: { intervalMs: 30_000 },
    });
    push.on('stateChange', change => {
      console.log(change.changed[accountId]?.Email);
    });
    push.close();
  });
});
