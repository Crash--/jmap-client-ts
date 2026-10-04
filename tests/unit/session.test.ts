import { describe, expect, it, vi } from 'vitest';

import { createClient, JmapError, JmapInvalidResponseError } from '../../src/index.js';
import type { Session } from '../../src/index.js';
import {
  ACCOUNT_ID,
  apiHandler,
  jsonResponse,
  makeFakeServer,
  makeSession,
  SESSION_URL,
} from './helpers.js';

describe('session', () => {
  it('fetches the session once and caches it', async () => {
    const server = makeFakeServer();
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    const [first, second] = await Promise.all([client.getSession(), client.getSession()]);
    const third = await client.getSession();

    expect(first.username).toBe('alice@example.com');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(server.fetch).toHaveBeenCalledTimes(1);
    expect(server.requests[0]!.headers.get('Accept')).toBe('application/json');
  });

  it('re-fetches on refreshSession', async () => {
    const server = makeFakeServer();
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });
    await client.getSession();
    server.setSession(makeSession({ state: 's2' }));

    const refreshed = await client.refreshSession();

    expect(refreshed.state).toBe('s2');
    expect(await client.getSession()).toBe(refreshed);
  });

  it('answers capability and account questions once loaded', async () => {
    const server = makeFakeServer();
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    expect(() => client.hasCapability('urn:ietf:params:jmap:mail')).toThrow(JmapError);
    expect(() => client.getPrimaryAccountId()).toThrow(/not loaded/);
    await client.getSession();

    expect(client.getPrimaryAccountId()).toBe(ACCOUNT_ID);
    expect(client.getPrimaryAccountId('urn:ietf:params:jmap:submission')).toBe(ACCOUNT_ID);
    expect(() => client.getPrimaryAccountId('urn:example:nothing')).toThrow(JmapError);
    expect(client.hasCapability('urn:ietf:params:jmap:websocket')).toBe(true);
    expect(client.hasCapability('urn:ietf:params:jmap:quota')).toBe(false);
    expect(client.hasCapability('urn:ietf:params:jmap:quota', ACCOUNT_ID)).toBe(true);
    expect(client.hasCapability('urn:ietf:params:jmap:quota', 'other')).toBe(false);
  });

  it('rejects an invalid session document', async () => {
    const server = makeFakeServer({ [SESSION_URL]: () => jsonResponse({ apiUrl: 42 }) });
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    await expect(client.getSession()).rejects.toThrow(JmapInvalidResponseError);
  });

  it('uses overrideApiUrl for method calls', async () => {
    const server = makeFakeServer({
      'POST https://public.example.com/jmap': apiHandler({ 'Core/echo': args => args }),
    });
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      overrideApiUrl: 'https://public.example.com/jmap',
    });

    await client.call('Core/echo', { hello: true });

    expect((await client.getSession()).apiUrl).toBe('https://public.example.com/jmap');
    expect(server.requests.at(-1)!.url).toBe('https://public.example.com/jmap');
  });

  it('resolves a relative apiUrl against the session URL', async () => {
    const server = makeFakeServer({
      'POST https://jmap.example.com/api': apiHandler({ 'Core/echo': args => args }),
    });
    server.setSession(makeSession({ apiUrl: '/api' }));
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    await client.call('Core/echo', {});

    expect(server.requests.at(-1)!.url).toBe('https://jmap.example.com/api');
  });

  it('re-fetches the session and notifies when sessionState changes', async () => {
    const server = makeFakeServer({
      'POST https://jmap.example.com/jmap': apiHandler({ 'Core/echo': args => args }, 's2'),
    });
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });
    await client.getSession();
    server.setSession(makeSession({ state: 's2', username: 'renamed@example.com' }));
    const listener = vi.fn<(session: Session) => void>();
    const unsubscribe = client.onSessionChange(listener);

    await client.call('Core/echo', {});

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].username).toBe('renamed@example.com');
    expect((await client.getSession()).state).toBe('s2');

    unsubscribe();
    server.setSession(makeSession({ state: 's3' }));
    await client.refreshSession();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when sessionState is unchanged', async () => {
    const server = makeFakeServer({
      'POST https://jmap.example.com/jmap': apiHandler({ 'Core/echo': args => args }, 's1'),
    });
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });
    const listener = vi.fn();
    client.onSessionChange(listener);

    await client.call('Core/echo', {});
    await client.call('Core/echo', {});

    expect(listener).not.toHaveBeenCalled();
    expect(server.requests.filter(request => request.url === SESSION_URL)).toHaveLength(1);
  });
});
