import { describe, expectTypeOf, it } from 'vitest';

import { createClient } from '../../src/index.js';
import type {
  EmailAddress,
  Id,
  JmapMethodName,
  Mailbox,
  MethodResponse,
  ResultReference,
} from '../../src/index.js';
import type { Label } from './extension.js';

const client = createClient({
  sessionUrl: 'https://jmap.example.com/jmap/session',
  methodCapabilities: { 'Label/get': 'com:linagora:params:jmap:labels' },
});
const accountId: Id = 'a1';

describe('call', () => {
  it('returns the full object type without properties', async () => {
    const response = await client.call('Mailbox/get', { accountId, ids: null });
    expectTypeOf(response.list).toEqualTypeOf<Mailbox[]>();
    expectTypeOf(response.state).toEqualTypeOf<string>();
  });

  it('narrows get responses to the requested properties, id included', async () => {
    const response = await client.call('Email/get', {
      accountId,
      ids: ['e1'],
      properties: ['subject', 'from', 'receivedAt'],
    });
    expectTypeOf(response.list[0]!).toEqualTypeOf<{
      id: string;
      subject: string | null;
      from: EmailAddress[] | null;
      receivedAt: string;
    }>();
  });

  it('types header properties by their form', async () => {
    const response = await client.call('Email/get', {
      accountId,
      properties: [
        'header:List-Id:asText',
        'header:From:asAddresses:all',
        'header:X-Spam',
        'header:Received:all',
      ],
    });
    const email = response.list[0]!;
    expectTypeOf(email['header:List-Id:asText']).toEqualTypeOf<string | null>();
    expectTypeOf(email['header:From:asAddresses:all']).toEqualTypeOf<EmailAddress[][]>();
    expectTypeOf(email['header:X-Spam']).toEqualTypeOf<string | null>();
    expectTypeOf(email['header:Received:all']).toEqualTypeOf<string[]>();
  });

  it('accepts custom keywords', async () => {
    await client.call('Email/set', {
      accountId,
      update: { e1: { keywords: { $seen: true, '$label:work': true }, 'keywords/$flagged': true } },
    });
  });

  it('rejects unknown methods, missing and unknown arguments', async () => {
    // @ts-expect-error unknown method
    await client.call('Nope/get', { accountId });
    // @ts-expect-error accountId is required
    await client.call('Mailbox/get', { ids: null });
    // @ts-expect-error unknown argument
    await client.call('Mailbox/get', { accountId, idz: null });
    // @ts-expect-error not an Email property
    await client.call('Email/get', { accountId, properties: ['subjectt'] });
  });
});

describe('request builder', () => {
  it('types back-references and the result tuple', async () => {
    const result = await client.request(b => {
      const query = b.call('Email/query', {
        accountId,
        filter: { inMailbox: 'inbox' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 50,
      });
      const ids = query.ref('/ids');
      expectTypeOf(ids).toEqualTypeOf<ResultReference<string[]>>();
      const emails = b.call('Email/get', {
        accountId,
        '#ids': ids,
        properties: ['id', 'threadId', 'subject'],
      });
      expectTypeOf(emails.ref('/list/*/threadId')).toEqualTypeOf<ResultReference<string[]>>();
      const threads = b.call('Thread/get', { accountId, '#ids': emails.ref('/list/*/threadId') });
      return [query, emails, threads];
    });
    const [query, emails, threads] = result;
    expectTypeOf(query.ids).toEqualTypeOf<Id[]>();
    expectTypeOf(emails.list[0]!).toEqualTypeOf<{
      id: string;
      threadId: string;
      subject: string | null;
    }>();
    expectTypeOf(threads.list[0]!.emailIds).toEqualTypeOf<Id[]>();
    expectTypeOf(result.createdIds).toEqualTypeOf<Record<Id, Id> | null>();
    expectTypeOf(result.sessionState).toEqualTypeOf<string>();
  });

  it('flattens nested arrays under the * wildcard', async () => {
    await client.request(b => {
      const threads = b.call('Thread/get', { accountId, ids: ['t1'] });
      expectTypeOf(threads.ref('/list/*/emailIds')).toEqualTypeOf<ResultReference<string[]>>();
      return [threads];
    });
  });

  it('accepts a back-reference in place of a required argument', async () => {
    await client.request(b => {
      const query = b.call('Email/query', { accountId });
      return [b.call('SearchSnippet/get', { accountId, '#emailIds': query.ref('/ids') })];
    });
  });

  it('rejects references whose type does not fit', async () => {
    await client.request(b => {
      const query = b.call('Email/query', { accountId, calculateTotal: true });
      // @ts-expect-error /total is a number, ids expects Id[]
      const emails = b.call('Email/get', { accountId, '#ids': query.ref('/total') });
      return [emails];
    });
  });

  it('rejects missing required arguments and unknown ones', async () => {
    await client.request(b => {
      // @ts-expect-error emailIds (or #emailIds) is required
      const snippets = b.call('SearchSnippet/get', { accountId });
      // @ts-expect-error unknown argument
      const mailboxes = b.call('Mailbox/get', { accountId, foo: 1 });
      return [snippets, mailboxes];
    });
  });

  it('only references paths of the narrowed response', async () => {
    await client.request(b => {
      const emails = b.call('Email/get', { accountId, properties: ['subject'] });
      expectTypeOf(emails.ref('/list/*/subject')).toEqualTypeOf<
        ResultReference<(string | null)[]>
      >();
      // Not requested, so not a known path: accepted but unchecked.
      expectTypeOf(emails.ref('/list/*/threadId')).toEqualTypeOf<ResultReference<never>>();
      return [emails];
    });
  });
});

describe('declaration merging', () => {
  it('adds Label/get to the known methods', async () => {
    expectTypeOf<'Label/get'>().toExtend<JmapMethodName>();
    const response = await client.call('Label/get', { accountId, properties: ['displayName'] });
    expectTypeOf(response.list[0]!).toEqualTypeOf<{ id: string; displayName: string }>();
    expectTypeOf<MethodResponse<'Label/get'>['list']>().toEqualTypeOf<Label[]>();
  });

  it('can be combined with built-in methods in one request', async () => {
    const [labels, mailboxes] = await client.request(b => [
      b.call('Label/get', { accountId, ids: null }),
      b.call('Mailbox/get', { accountId, ids: null }),
    ]);
    expectTypeOf(labels.list).toEqualTypeOf<Label[]>();
    expectTypeOf(mailboxes.list).toEqualTypeOf<Mailbox[]>();
  });

  it('requires the runtime capability of extension methods', () => {
    // @ts-expect-error methodCapabilities must list Label/get
    createClient({ sessionUrl: 'https://jmap.example.com/jmap/session' });
    createClient({
      sessionUrl: 'https://jmap.example.com/jmap/session',
      // @ts-expect-error capability must match the declaration
      methodCapabilities: { 'Label/get': 'urn:ietf:params:jmap:mail' },
    });
  });
});

describe('patch objects', () => {
  it('accepts computed JSON pointer keys and rejects unknown top-level keys', async () => {
    const mailboxId: string = 'm1';
    await client.call('Email/set', {
      accountId,
      update: { e1: { [`mailboxIds/${mailboxId}`]: true, 'keywords/$draft': null } },
    });
    await client.call('Mailbox/set', {
      accountId,
      // @ts-expect-error not a Mailbox property
      update: { m1: { nam: 'x' } },
    });
  });
});

describe('nested arguments', () => {
  it('reports unknown nested properties in calls and builders', async () => {
    await client.call('Email/set', {
      accountId,
      // @ts-expect-error typo in a creation object
      create: { k: { mailboxIds: { m: true }, subjct: 'x' } },
    });
    await client.request(b => [
      b.call('Email/set', {
        accountId,
        // @ts-expect-error typo in a creation object
        create: { k: { mailboxIds: { m: true }, subjct: 'x' } },
      }),
    ]);
  });

  it('only accepts properties on methods that have them', async () => {
    // @ts-expect-error Email/query has no properties argument
    await client.call('Email/query', { accountId, properties: [] });
  });
});

describe('requestSettled', () => {
  it('types each outcome', async () => {
    const [mailboxes] = await client.requestSettled(b => [
      b.call('Mailbox/get', { accountId, properties: ['name'] }),
    ]);
    if (mailboxes.ok) {
      expectTypeOf(mailboxes.value.list[0]!).toEqualTypeOf<{ id: string; name: string }>();
    } else {
      expectTypeOf(mailboxes.error.type).toEqualTypeOf<string>();
    }
  });
});
