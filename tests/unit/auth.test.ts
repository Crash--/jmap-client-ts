import { describe, expect, it, vi } from 'vitest';

import { createClient, JmapHttpError } from '../../src/index.js';
import { apiHandler, makeFakeServer, SESSION_URL } from './helpers.js';

const API_URL = 'POST https://jmap.example.com/jmap';

/** Accepts only `Bearer <validToken()>`. */
function makeProtectedServer(validToken: () => string) {
  const echo = apiHandler({ 'Core/echo': args => args });
  const server = makeFakeServer({
    [API_URL]: request =>
      request.headers.get('Authorization') === `Bearer ${validToken()}`
        ? echo(request)
        : new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
  });
  return server;
}

describe('authentication', () => {
  it('sends the Authorization header on every request', async () => {
    const server = makeProtectedServer(() => 't1');
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => 'Bearer t1' },
    });

    await client.call('Core/echo', {});

    expect(server.requests.map(request => request.headers.get('Authorization'))).toEqual([
      'Bearer t1',
      'Bearer t1',
    ]);
  });

  it('sends no header when getAuthorizationHeader resolves null or without auth', async () => {
    const server = makeFakeServer();
    await createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => Promise.resolve(null) },
    }).getSession();
    await createClient({ sessionUrl: SESSION_URL, fetch: server.fetch }).getSession();

    expect(server.requests.every(request => !request.headers.has('Authorization'))).toBe(true);
  });

  it('retries once after onUnauthorized refreshed the credentials', async () => {
    let token = 'expired';
    const server = makeProtectedServer(() => 'fresh');
    const onUnauthorized = vi.fn(() => {
      token = 'fresh';
      return Promise.resolve(true);
    });
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => `Bearer ${token}`, onUnauthorized },
    });

    await expect(client.call('Core/echo', { ping: 1 })).resolves.toEqual({ ping: 1 });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const apiCalls = server.apiRequests();
    expect(apiCalls.map(request => request.headers.get('Authorization'))).toEqual([
      'Bearer expired',
      'Bearer fresh',
    ]);
    expect(apiCalls[1]!.json()).toEqual(apiCalls[0]!.json());
  });

  it('gives up with a 401 JmapHttpError when the refresh fails', async () => {
    const server = makeProtectedServer(() => 'never');
    const onUnauthorized = vi.fn(() => false);
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => 'Bearer x', onUnauthorized },
    });

    await expect(client.call('Core/echo', {})).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(server.apiRequests()).toHaveLength(1);
  });

  it('retries only once even if the server still answers 401', async () => {
    const server = makeProtectedServer(() => 'never');
    const onUnauthorized = vi.fn(() => true);
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => 'Bearer x', onUnauthorized },
    });

    await expect(client.call('Core/echo', {})).rejects.toThrow(JmapHttpError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(server.apiRequests()).toHaveLength(2);
  });

  it('shares one refresh between concurrent 401s', async () => {
    let token = 'expired';
    const server = makeProtectedServer(() => 'fresh');
    const onUnauthorized = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      token = 'fresh';
      return true;
    });
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => `Bearer ${token}`, onUnauthorized },
    });
    await client.getSession();

    await Promise.all([client.call('Core/echo', { n: 1 }), client.call('Core/echo', { n: 2 })]);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('calls the injected fetch without a this binding', async () => {
    const server = makeFakeServer();
    const calls: unknown[] = [];
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: function (this: unknown, input, init) {
        calls.push(this);
        return server.fetch(input, init);
      },
    });

    await client.getSession();

    expect(calls).toEqual([undefined]);
  });
});
