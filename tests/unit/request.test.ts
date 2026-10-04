import { describe, expect, it } from 'vitest';

import {
  createClient,
  JmapHttpError,
  JmapInvalidResponseError,
  JmapMethodError,
  JmapRequestError,
} from '../../src/index.js';
import { ACCOUNT_ID, apiHandler, jsonResponse, makeFakeServer, SESSION_URL } from './helpers.js';

const API_URL = 'POST https://jmap.example.com/jmap';

function makeClient(handler: Parameters<typeof makeFakeServer>[0] = {}) {
  const server = makeFakeServer(handler);
  return { server, client: createClient({ sessionUrl: SESSION_URL, fetch: server.fetch }) };
}

describe('call', () => {
  it('sends one invocation with the method capability in using', async () => {
    const { server, client } = makeClient({
      [API_URL]: apiHandler({
        'Mailbox/get': () => ({ accountId: ACCOUNT_ID, state: 'm1', list: [], notFound: [] }),
      }),
    });

    const response = await client.call('Mailbox/get', { accountId: ACCOUNT_ID, ids: null });

    expect(response.state).toBe('m1');
    const request = server.apiRequests()[0]!;
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(request.json()).toEqual({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Mailbox/get', { accountId: ACCOUNT_ID, ids: null }, 'c0']],
    });
  });

  it('adds extra capabilities to using', async () => {
    const { server, client } = makeClient({ [API_URL]: apiHandler({ 'Core/echo': a => a }) });

    await client.call('Core/echo', {}, { extraCapabilities: ['urn:example:extra'] });

    expect(server.apiRequests()[0]!.json()).toMatchObject({
      using: ['urn:ietf:params:jmap:core', 'urn:example:extra'],
    });
  });

  it('throws JmapMethodError on a method error', async () => {
    const { client } = makeClient({
      [API_URL]: () =>
        jsonResponse({
          methodResponses: [
            [
              'error',
              { type: 'invalidArguments', description: 'bad ids', arguments: ['ids'] },
              'c0',
            ],
          ],
          sessionState: 's1',
        }),
    });

    const error = await client
      .call('Mailbox/get', { accountId: ACCOUNT_ID })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JmapMethodError);
    expect(error).toMatchObject({
      type: 'invalidArguments',
      description: 'bad ids',
      methodName: 'Mailbox/get',
      callId: 'c0',
      details: { arguments: ['ids'] },
    });
  });

  it('fails at runtime on a method without known capability', async () => {
    const { client } = makeClient();
    // @ts-expect-error simulating an untyped caller
    await expect(client.call('Unknown/get', {})).rejects.toThrow(/methodCapabilities/);
  });

  it('uses methodCapabilities for extension methods', async () => {
    const server = makeFakeServer({ [API_URL]: apiHandler({ 'Label/get': () => ({ list: [] }) }) });
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      methodCapabilities: { 'Label/get': 'com:linagora:params:jmap:labels' },
    });

    // @ts-expect-error Label/get is not declared in this compilation unit
    await client.call('Label/get', { accountId: ACCOUNT_ID });

    expect(server.apiRequests()[0]!.json()).toMatchObject({
      using: ['urn:ietf:params:jmap:core', 'com:linagora:params:jmap:labels'],
    });
  });
});

describe('request', () => {
  it('sends several calls with back-references and returns their responses', async () => {
    const { server, client } = makeClient({
      [API_URL]: apiHandler({
        'Email/query': () => ({ accountId: ACCOUNT_ID, ids: ['e1', 'e2'], queryState: 'q' }),
        'Email/get': () => ({
          accountId: ACCOUNT_ID,
          state: 'e',
          list: [{ id: 'e1' }],
          notFound: [],
        }),
      }),
    });

    const [query, emails] = await client.request(b => {
      const q = b.call('Email/query', { accountId: ACCOUNT_ID, limit: 2 });
      const g = b.call('Email/get', {
        accountId: ACCOUNT_ID,
        '#ids': q.ref('/ids'),
        properties: ['subject'],
      });
      return [q, g];
    });

    expect(query.ids).toEqual(['e1', 'e2']);
    expect(emails.list).toEqual([{ id: 'e1' }]);
    expect(server.apiRequests()[0]!.json()).toEqual({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', { accountId: ACCOUNT_ID, limit: 2 }, 'c0'],
        [
          'Email/get',
          {
            accountId: ACCOUNT_ID,
            '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' },
            properties: ['subject'],
          },
          'c1',
        ],
      ],
    });
  });

  it('computes using from every method of the request', async () => {
    const { server, client } = makeClient({
      [API_URL]: apiHandler({
        'Email/set': () => ({ created: { draft: { id: 'e1' } } }),
        'EmailSubmission/set': () => ({ created: { send: { id: 's1' } } }),
      }),
    });

    await client.request(b => [
      b.call('Email/set', {
        accountId: ACCOUNT_ID,
        create: { draft: { mailboxIds: { m: true } } },
      }),
      b.call('EmailSubmission/set', {
        accountId: ACCOUNT_ID,
        create: { send: { identityId: 'i1', emailId: '#draft' } },
      }),
    ]);

    expect(server.apiRequests()[0]!.json()).toMatchObject({
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:mail',
        'urn:ietf:params:jmap:submission',
      ],
    });
  });

  it('passes createdIds and returns the response createdIds and sessionState', async () => {
    const { server, client } = makeClient({
      [API_URL]: () =>
        jsonResponse({
          methodResponses: [['Core/echo', {}, 'c0']],
          createdIds: { k1: 'id1', k2: 'id2' },
          sessionState: 's1',
        }),
    });

    const result = await client.request(b => [b.call('Core/echo', {})], {
      createdIds: { k1: 'id1' },
    });

    expect(server.apiRequests()[0]!.json()).toMatchObject({ createdIds: { k1: 'id1' } });
    expect(result.createdIds).toEqual({ k1: 'id1', k2: 'id2' });
    expect(result.sessionState).toBe('s1');
    expect(result).toHaveLength(1);
  });

  it('returns null createdIds when the server sends none', async () => {
    const { client } = makeClient({ [API_URL]: apiHandler({ 'Core/echo': a => a }) });

    const result = await client.request(b => [b.call('Core/echo', {})]);

    expect(result.createdIds).toBeNull();
  });

  it('rejects with the method error but still resolves the other handles', async () => {
    const { client } = makeClient({
      [API_URL]: () =>
        jsonResponse({
          methodResponses: [
            ['Mailbox/get', { list: [] }, 'c0'],
            ['error', { type: 'unknownMethod' }, 'c1'],
          ],
          sessionState: 's1',
        }),
    });
    let mailboxes: PromiseLike<unknown> | null = null;

    const result = client.request(b => {
      const handle = b.call('Mailbox/get', { accountId: ACCOUNT_ID });
      mailboxes = handle;
      return [handle, b.call('Thread/get', { accountId: ACCOUNT_ID })];
    });

    await expect(result).rejects.toMatchObject({ type: 'unknownMethod', callId: 'c1' });
    await expect(mailboxes!).resolves.toEqual({ list: [] });
  });

  it('keeps the first response of a call id (implicit Email/set after a submission)', async () => {
    const { client } = makeClient({
      [API_URL]: () =>
        jsonResponse({
          methodResponses: [
            ['EmailSubmission/set', { created: { s: { id: 'sub1' } } }, 'c0'],
            ['Email/set', { updated: { e1: null } }, 'c0'],
          ],
          sessionState: 's1',
        }),
    });

    const response = await client.call('EmailSubmission/set', {
      accountId: ACCOUNT_ID,
      create: { s: { identityId: 'i', emailId: 'e1' } },
      onSuccessUpdateEmail: { '#s': { 'keywords/$draft': null } },
    });

    expect(response.created).toEqual({ s: { id: 'sub1' } });
  });

  it('rejects a missing response as invalid', async () => {
    const { client } = makeClient({
      [API_URL]: () => jsonResponse({ methodResponses: [], sessionState: 's1' }),
    });

    await expect(client.call('Core/echo', {})).rejects.toThrow(JmapInvalidResponseError);
  });

  it('rejects a response that is not JSON', async () => {
    const { client } = makeClient({ [API_URL]: () => new Response('<html>') });

    await expect(client.call('Core/echo', {})).rejects.toThrow(JmapInvalidResponseError);
  });

  it('rejects references to another request and duplicated arguments', async () => {
    const { client } = makeClient({ [API_URL]: apiHandler({ 'Email/query': () => ({}) }) });
    let foreign: unknown = null;
    await client.request(b => {
      const query = b.call('Email/query', { accountId: ACCOUNT_ID });
      foreign = query.ref('/ids');
      return [query];
    });

    await expect(
      client.request(b => [
        // @ts-expect-error the foreign reference is typed unknown on purpose
        b.call('Email/get', { accountId: ACCOUNT_ID, '#ids': foreign }),
      ]),
    ).rejects.toThrow(/another request/);
    await expect(
      client.request(b => {
        const query = b.call('Email/query', { accountId: ACCOUNT_ID });
        return [b.call('Email/get', { accountId: ACCOUNT_ID, ids: [], '#ids': query.ref('/ids') })];
      }),
    ).rejects.toThrow(/both "ids" and "#ids"/);
  });

  it('rejects handles that do not come from the builder', async () => {
    const { client } = makeClient();
    const notAHandle = Object.assign(Promise.resolve(1), { method: 'x', callId: 'c0' });

    await expect(client.request(() => [notAHandle])).rejects.toThrow(TypeError);
  });
});

describe('request errors', () => {
  it('maps a problem document to JmapRequestError', async () => {
    const { client } = makeClient({
      [API_URL]: () =>
        new Response(
          JSON.stringify({
            type: 'urn:ietf:params:jmap:error:limit',
            limit: 'maxCallsInRequest',
            status: 400,
            detail: 'Too many calls',
          }),
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    });

    const error = await client.call('Core/echo', {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JmapRequestError);
    expect(error).toMatchObject({
      type: 'urn:ietf:params:jmap:error:limit',
      status: 400,
      detail: 'Too many calls',
      limit: 'maxCallsInRequest',
    });
  });

  it('maps other failures to JmapHttpError with the body', async () => {
    const { client } = makeClient({
      [API_URL]: () => new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
    });

    const error = await client.call('Core/echo', {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JmapHttpError);
    expect(error).toMatchObject({ status: 503, statusText: 'Service Unavailable', body: 'boom' });
  });
});

describe('requestSettled', () => {
  it('returns each call outcome without rejecting on method errors', async () => {
    const { client } = makeClient({
      [API_URL]: () =>
        jsonResponse({
          methodResponses: [
            ['Email/query', { ids: ['e1'] }, 'c0'],
            ['error', { type: 'unsupportedFilter' }, 'c1'],
          ],
          sessionState: 's1',
        }),
    });

    const [query, snippets] = await client.requestSettled(b => {
      const q = b.call('Email/query', { accountId: ACCOUNT_ID });
      return [
        q,
        b.call('SearchSnippet/get', { accountId: ACCOUNT_ID, '#emailIds': q.ref('/ids') }),
      ];
    });

    expect(query).toEqual({ ok: true, value: { ids: ['e1'] } });
    expect(snippets.ok).toBe(false);
    expect(!snippets.ok && snippets.error).toBeInstanceOf(JmapMethodError);
  });

  it('still rejects on request-level failures', async () => {
    const { client } = makeClient({ [API_URL]: () => new Response('down', { status: 502 }) });

    await expect(client.requestSettled(b => [b.call('Core/echo', {})])).rejects.toThrow(
      JmapHttpError,
    );
  });
});
