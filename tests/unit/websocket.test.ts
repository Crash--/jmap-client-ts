import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, JmapPushNotSupportedError } from '../../src/index.js';
import type { PushStatus, StateChange, WebSocketLike } from '../../src/index.js';
import { jsonResponse, makeFakeServer, makeSession, SESSION_URL } from './helpers.js';

const TICKET_URL = 'POST https://jmap.example.com/jmap/ws/ticket';

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly sent: unknown[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  // Test controls -----------------------------------------------------------

  open(): void {
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  serverClose(): void {
    this.onclose?.(new CloseEvent('close', { code: 1006 }));
  }
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error('no socket opened');
  }
  return socket;
}

function makeClient(handlers: Parameters<typeof makeFakeServer>[0] = {}) {
  let ticketCount = 0;
  const server = makeFakeServer({
    [TICKET_URL]: () => {
      ticketCount += 1;
      return jsonResponse({ value: `ticket-${ticketCount}`, username: 'alice@example.com' });
    },
    ...handlers,
  });
  const client = createClient({
    sessionUrl: SESSION_URL,
    fetch: server.fetch,
    auth: { getAuthorizationHeader: () => 'Bearer t' },
  });
  return { server, client };
}

const STATE_CHANGE: StateChange = {
  '@type': 'StateChange',
  changed: { a1: { Email: 'e2', Mailbox: 'm2' } },
  pushState: 'p2',
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('connectWebSocket', () => {
  it('opens the session WebSocket URL with a ticket and the jmap protocol', async () => {
    const { server, client } = makeClient();

    client.connectWebSocket({ WebSocket: FakeWebSocket });
    await vi.advanceTimersByTimeAsync(0);

    const socket = lastSocket();
    expect(socket.url).toBe('wss://jmap.example.com/jmap/ws?ticket=ticket-1');
    expect(socket.protocols).toBe('jmap');
    const ticketRequest = server.requests.find(request => request.url.endsWith('/ws/ticket'));
    expect(ticketRequest?.method).toBe('POST');
    expect(ticketRequest?.headers.get('Authorization')).toBe('Bearer t');
  });

  it('opens without ticket when the server has no ticket capability', async () => {
    const { server, client } = makeClient();
    const session = makeSession();
    delete session.capabilities['com:linagora:params:jmap:ws:ticket'];
    server.setSession(session);

    client.connectWebSocket({ WebSocket: FakeWebSocket });
    await vi.advanceTimersByTimeAsync(0);

    expect(lastSocket().url).toBe('wss://jmap.example.com/jmap/ws');
  });

  it('finds the ticket capability in the primary account', async () => {
    const { server, client } = makeClient();
    const session = makeSession();
    const ticket = session.capabilities['com:linagora:params:jmap:ws:ticket']!;
    delete session.capabilities['com:linagora:params:jmap:ws:ticket'];
    session.accounts.a1!.accountCapabilities['com:linagora:params:jmap:ws:ticket'] = ticket;
    server.setSession(session);

    client.connectWebSocket({ WebSocket: FakeWebSocket });
    await vi.advanceTimersByTimeAsync(0);

    expect(lastSocket().url).toBe('wss://jmap.example.com/jmap/ws?ticket=ticket-1');
  });

  it('enables push on open, emits state changes and keeps the push state', async () => {
    const { client } = makeClient();
    const push = client.connectWebSocket({
      WebSocket: FakeWebSocket,
      dataTypes: ['Email', 'Mailbox'],
      pushState: 'p1',
    });
    const statuses: PushStatus[] = [];
    const changes: StateChange[] = [];
    push.on('status', status => statuses.push(status));
    push.on('stateChange', change => changes.push(change));
    await vi.advanceTimersByTimeAsync(0);

    const socket = lastSocket();
    socket.open();
    socket.receive(STATE_CHANGE);

    expect(socket.sent).toEqual([
      { '@type': 'WebSocketPushEnable', dataTypes: ['Email', 'Mailbox'], pushState: 'p1' },
    ]);
    expect(changes).toEqual([STATE_CHANGE]);
    expect(push.pushState).toBe('p2');
    expect(statuses).toEqual(['connecting', 'open']);
    expect(push.status).toBe('open');
  });

  it('sends dataTypes null when not restricted', async () => {
    const { client } = makeClient();
    client.connectWebSocket({ WebSocket: FakeWebSocket });
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().open();

    expect(lastSocket().sent).toEqual([{ '@type': 'WebSocketPushEnable', dataTypes: null }]);
  });

  it('reconnects with backoff, a fresh ticket and the last push state', async () => {
    const { client } = makeClient();
    const push = client.connectWebSocket({
      WebSocket: FakeWebSocket,
      reconnect: { initialDelayMs: 1_000, maxDelayMs: 4_000 },
    });
    const statuses: PushStatus[] = [];
    push.on('status', status => statuses.push(status));
    await vi.advanceTimersByTimeAsync(0);
    lastSocket().open();
    lastSocket().receive(STATE_CHANGE);

    lastSocket().serverClose();
    expect(push.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(lastSocket().url).toContain('ticket=ticket-2');

    // Failing attempts double the delay up to the maximum.
    lastSocket().serverClose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    lastSocket().serverClose();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
    lastSocket().serverClose();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeWebSocket.instances).toHaveLength(5);

    lastSocket().open();
    expect(lastSocket().sent).toEqual([
      { '@type': 'WebSocketPushEnable', dataTypes: null, pushState: 'p2' },
    ]);
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
  });

  it('applies jitter between half and all of the delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { client } = makeClient();
    client.connectWebSocket({ WebSocket: FakeWebSocket, reconnect: { initialDelayMs: 1_000 } });
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().serverClose();
    await vi.advanceTimersByTimeAsync(500);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('retries when the ticket request fails', async () => {
    let attempts = 0;
    const { client } = makeClient({
      [TICKET_URL]: () => {
        attempts += 1;
        return attempts === 1
          ? new Response('down', { status: 503 })
          : jsonResponse({ value: 'late-ticket' });
      },
    });
    const push = client.connectWebSocket({ WebSocket: FakeWebSocket });
    const errors: unknown[] = [];
    push.on('error', error => errors.push(error));

    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(push.status).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(lastSocket().url).toContain('ticket=late-ticket');
  });

  it('stops for good when the server does not support push', async () => {
    const { server, client } = makeClient();
    const session = makeSession();
    delete session.capabilities['urn:ietf:params:jmap:websocket'];
    server.setSession(session);
    const push = client.connectWebSocket({ WebSocket: FakeWebSocket });
    const errors: unknown[] = [];
    push.on('error', error => errors.push(error));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(JmapPushNotSupportedError);
    expect(push.status).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('pings with Core/echo and reconnects when a ping gets no answer', async () => {
    const { client } = makeClient();
    client.connectWebSocket({ WebSocket: FakeWebSocket, ping: { intervalMs: 10_000 } });
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.open();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent[1]).toEqual({
      '@type': 'Request',
      id: 'ping-1',
      using: ['urn:ietf:params:jmap:core'],
      methodCalls: [['Core/echo', {}, 'ping']],
    });
    socket.receive({ '@type': 'Response', requestId: 'ping-1', methodResponses: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent).toHaveLength(3);
    expect(socket.closedWith).toBeNull();

    // No answer to ping-2: the next tick drops the socket.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'Reconnecting' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('does not reconnect when reconnect is disabled', async () => {
    const { client } = makeClient();
    const push = client.connectWebSocket({ WebSocket: FakeWebSocket, reconnect: false });
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().serverClose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(push.status).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() closes the socket and cancels reconnection', async () => {
    const { client } = makeClient();
    const push = client.connectWebSocket({ WebSocket: FakeWebSocket });
    const statuses: PushStatus[] = [];
    push.on('status', status => statuses.push(status));
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.open();

    push.close();
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.closedWith).toEqual({ code: 1000, reason: 'Client closed' });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
  });

  it('reports server RequestError messages and ignores unknown ones', async () => {
    const { client } = makeClient();
    const push = client.connectWebSocket({ WebSocket: FakeWebSocket });
    const errors: unknown[] = [];
    const unsubscribe = push.on('error', error => errors.push(error));
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.open();

    socket.receive({ '@type': 'Unknown' });
    socket.receive({ '@type': 'RequestError', type: 'urn:ietf:params:jmap:error:notRequest' });
    unsubscribe();
    socket.receive({ '@type': 'RequestError', type: 'urn:ietf:params:jmap:error:notJSON' });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: 'urn:ietf:params:jmap:error:notRequest' });
  });
});
