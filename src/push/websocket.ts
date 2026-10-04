/**
 * Push over WebSocket (RFC 8887 §4.3.5) with automatic reconnection.
 */
import { JmapError, JmapRequestError } from '../errors.js';
import { emitSafely } from '../emit.js';
import { isRecord } from '../guards.js';
import type { ProblemDetails, StateChange } from '../types/core.js';

/** Raised when the server cannot push over WebSocket; no reconnection is attempted. */
export class JmapPushNotSupportedError extends JmapError {
  override name = 'JmapPushNotSupportedError';
}

/** Subset of the WebSocket API the client relies on. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

export type PushStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface PushEvents {
  stateChange: StateChange;
  status: PushStatus;
  /** Transient errors (ticket, socket, server `RequestError`); reconnection goes on. */
  error: unknown;
}

export type PushListener<E extends keyof PushEvents> = (payload: PushEvents[E]) => void;

export interface ReconnectOptions {
  /** First delay, doubled on each failed attempt. Default 1 000 ms. */
  initialDelayMs?: number;
  /** Upper bound of the delay. Default 30 000 ms. */
  maxDelayMs?: number;
}

export interface WebSocketPushOptions {
  /** Type names to receive (`Email`, `Mailbox`, …), or `null` for all. Default `null`. */
  dataTypes?: readonly string[] | null;
  /** Resume from this push state (RFC 8887 §4.3.5.2). */
  pushState?: string | null;
  /** Sends `Core/echo` every `intervalMs`; reconnects if the previous one got no answer. */
  ping?: { intervalMs: number } | null;
  /** Reconnection with exponential backoff and jitter; `false` disables it. */
  reconnect?: ReconnectOptions | false;
  /** WebSocket implementation. Default `globalThis.WebSocket`. */
  WebSocket?: WebSocketConstructor;
}

export interface PushConnection {
  readonly status: PushStatus;
  /** Last `pushState` received, to resume after a restart. */
  readonly pushState: string | null;
  /** Subscribes to an event; returns the unsubscribe function. */
  on<E extends keyof PushEvents>(event: E, listener: PushListener<E>): () => void;
  /** Closes the socket for good. */
  close(): void;
}

/** @internal what the client provides to the push connection. */
export interface WebSocketPushDependencies {
  /** Resolves the URL to open, fetching a fresh ticket each time. */
  resolveUrl: () => Promise<string>;
  options: WebSocketPushOptions;
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

type ListenerSets = { [E in keyof PushEvents]: Set<PushListener<E>> };

/** @internal */
export class WebSocketPush implements PushConnection {
  readonly #resolveUrl: () => Promise<string>;
  readonly #options: WebSocketPushOptions;
  readonly #WebSocket: WebSocketConstructor;
  readonly #listeners: ListenerSets = {
    stateChange: new Set(),
    status: new Set(),
    error: new Set(),
  };
  #status: PushStatus = 'connecting';
  #pushState: string | null;
  #socket: WebSocketLike | null = null;
  #failedAttempts = 0;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #awaitingPong = false;
  #pingCounter = 0;

  constructor(dependencies: WebSocketPushDependencies) {
    this.#resolveUrl = dependencies.resolveUrl;
    this.#options = dependencies.options;
    this.#pushState = dependencies.options.pushState ?? null;
    const webSocketConstructor =
      dependencies.options.WebSocket ?? ('WebSocket' in globalThis ? globalThis.WebSocket : null);
    if (webSocketConstructor === null) {
      throw new TypeError('No WebSocket implementation: pass connectWebSocket({ WebSocket })');
    }
    this.#WebSocket = webSocketConstructor;
    // Defer so callers can subscribe to the first `status` event.
    queueMicrotask(() => {
      if (this.#closed) {
        return;
      }
      this.#emit('status', 'connecting');
      this.#connectAndForget();
    });
  }

  get status(): PushStatus {
    return this.#status;
  }

  get pushState(): string | null {
    return this.#pushState;
  }

  on<E extends keyof PushEvents>(event: E, listener: PushListener<E>): () => void {
    const listeners: Set<PushListener<E>> = this.#listeners[event];
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      detach(socket);
      socket.close(1000, 'Client closed');
    }
    this.#setStatus('closed');
  }

  #connectAndForget(): void {
    this.#connect().catch((error: unknown) => {
      this.#emit('error', error);
    });
  }

  async #connect(): Promise<void> {
    if (this.#closed) {
      return;
    }
    let url: string;
    try {
      url = await this.#resolveUrl();
    } catch (error: unknown) {
      if (this.#isClosed()) {
        return;
      }
      this.#emit('error', error);
      if (error instanceof JmapPushNotSupportedError) {
        this.#closed = true;
        this.#setStatus('closed');
        return;
      }
      this.#scheduleReconnect();
      return;
    }
    // close() may have been called while the URL was being resolved.
    if (this.#isClosed()) {
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = new this.#WebSocket(url, 'jmap');
    } catch (error: unknown) {
      this.#emit('error', error);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#failedAttempts = 0;
      this.#setStatus('open');
      this.#sendPushEnable(socket);
      this.#startPing(socket);
    };
    socket.onmessage = event => {
      this.#awaitingPong = false;
      this.#handleMessage(event.data);
    };
    socket.onerror = event => {
      this.#emit('error', event);
    };
    socket.onclose = () => {
      if (this.#socket === socket) {
        this.#dropSocket();
      }
    };
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #sendPushEnable(socket: WebSocketLike): void {
    const message: Record<string, unknown> = {
      '@type': 'WebSocketPushEnable',
      dataTypes: this.#options.dataTypes ?? null,
    };
    if (this.#pushState !== null) {
      message.pushState = this.#pushState;
    }
    socket.send(JSON.stringify(message));
  }

  #startPing(socket: WebSocketLike): void {
    const intervalMs = this.#options.ping?.intervalMs;
    if (intervalMs === undefined) {
      return;
    }
    this.#awaitingPong = false;
    this.#pingTimer = setInterval(() => {
      if (this.#awaitingPong) {
        this.#emit('error', new JmapError('WebSocket ping timed out'));
        this.#dropSocket();
        return;
      }
      this.#awaitingPong = true;
      this.#pingCounter += 1;
      socket.send(
        JSON.stringify({
          '@type': 'Request',
          id: `ping-${this.#pingCounter}`,
          using: ['urn:ietf:params:jmap:core'],
          methodCalls: [['Core/echo', {}, 'ping']],
        }),
      );
    }, intervalMs);
  }

  #handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch (error: unknown) {
      this.#emit('error', new JmapError('Invalid JSON pushed over WebSocket', { cause: error }));
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (message['@type'] === 'StateChange' && isRecord(message.changed)) {
      const change: StateChange = {
        '@type': 'StateChange',
        changed: normalizeChanged(message.changed),
      };
      if (typeof message.pushState === 'string') {
        change.pushState = message.pushState;
        this.#pushState = message.pushState;
      }
      this.#emit('stateChange', change);
      return;
    }
    if (message['@type'] === 'RequestError' && typeof message.type === 'string') {
      const problem: ProblemDetails = { ...message, type: message.type };
      this.#emit('error', new JmapRequestError(problem, 0));
    }
  }

  /** Forgets the current socket and plans the next attempt. */
  #dropSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#stopPing();
    if (socket !== null) {
      detach(socket);
      try {
        socket.close(4000, 'Reconnecting');
      } catch {
        // Already closed.
      }
    }
    if (!this.#closed) {
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#options.reconnect === false) {
      this.#closed = true;
      this.#setStatus('closed');
      return;
    }
    const initial = this.#options.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const max = this.#options.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const delay = computeBackoffDelay(this.#failedAttempts, initial, max);
    this.#failedAttempts += 1;
    this.#setStatus('reconnecting');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connectAndForget();
    }, delay);
  }

  #stopPing(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    this.#awaitingPong = false;
  }

  #clearTimers(): void {
    this.#stopPing();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #setStatus(status: PushStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#emit('status', status);
  }

  #emit<E extends keyof PushEvents>(event: E, payload: PushEvents[E]): void {
    const listeners: Set<PushListener<E>> = this.#listeners[event];
    emitSafely(listeners, payload);
  }
}

/** Exponential backoff with "equal jitter": between half and all of the capped delay. */
export function computeBackoffDelay(attempt: number, initialMs: number, maxMs: number): number {
  const capped = Math.min(maxMs, initialMs * 2 ** attempt);
  return capped / 2 + Math.random() * (capped / 2);
}

function detach(socket: WebSocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

function normalizeChanged(
  changed: Record<string, unknown>,
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [accountId, types] of Object.entries(changed)) {
    if (!isRecord(types)) {
      continue;
    }
    const states: Record<string, string> = {};
    for (const [typeName, state] of Object.entries(types)) {
      if (typeof state === 'string') {
        states[typeName] = state;
      }
    }
    result[accountId] = states;
  }
  return result;
}
