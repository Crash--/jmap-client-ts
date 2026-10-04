import { CAPABILITIES } from './capabilities.js';
import { emitSafely } from './emit.js';
import { JmapError, JmapInvalidResponseError, JmapMethodError } from './errors.js';
import { isRecord } from './guards.js';
import { AuthenticatedHttp, readJson } from './http.js';
import type { AuthOptions, FetchFunction } from './http.js';
import { BUILTIN_METHOD_CAPABILITIES } from './methods.js';
import type {
  CallArgs,
  ExtensionMethodCapabilities,
  ExtensionMethodName,
  JmapMethodName,
  MethodPropertyName,
  NarrowedMethodResponse,
} from './methods.js';
import { JmapPushNotSupportedError, WebSocketPush } from './push/websocket.js';
import type { PushConnection, WebSocketPushOptions } from './push/websocket.js';
import { CallHandleImpl, RequestBuilderImpl } from './request-builder.js';
import type {
  AnyCallHandle,
  OutgoingInvocation,
  RequestBuilder,
  SettleableHandle,
} from './request-builder.js';
import type { Account, CapabilityObject, Id, Session, UploadResponse } from './types/core.js';
import { expandUriTemplate } from './uri-template.js';

/** RFC 8620 §3.3 Request as sent (arguments already serializable). */
interface OutgoingRequest {
  using: string[];
  methodCalls: OutgoingInvocation[];
  createdIds?: Record<Id, Id>;
}

interface BaseClientOptions {
  /** URL of the JMAP Session resource (e.g. `https://host/jmap/session`). */
  sessionUrl: string;
  /** Authentication; omit to rely on cookies. */
  auth?: AuthOptions;
  /** `fetch` implementation. Default `globalThis.fetch`. */
  fetch?: FetchFunction;
  /** Replaces the `apiUrl` advertised by the session. */
  overrideApiUrl?: string;
}

/**
 * Options of {@link createClient}. `methodCapabilities` becomes required
 * as soon as methods are added to `JmapMethods` by declaration merging.
 */
export type ClientOptions = BaseClientOptions &
  ([ExtensionMethodName] extends [never]
    ? { methodCapabilities?: ExtensionMethodCapabilities }
    : { methodCapabilities: ExtensionMethodCapabilities });

export interface CallOptions {
  /** Capabilities to add to `using`, besides the ones of the methods called. */
  extraCapabilities?: readonly string[];
  signal?: AbortSignal;
}

export interface RequestOptions extends CallOptions {
  /** RFC 8620 §3.3 `createdIds`, to reference ids created by an earlier request. */
  createdIds?: Record<Id, Id>;
}

export interface RequestMeta {
  /** `createdIds` of the response, `null` if the server sent none. */
  createdIds: Record<Id, Id> | null;
  sessionState: string;
}

/** Responses of the calls returned by the builder, in order, plus {@link RequestMeta}. */
export type RequestResult<Handles extends readonly AnyCallHandle[]> = {
  -readonly [K in keyof Handles]: Awaited<Handles[K]>;
} & RequestMeta;

/** Outcome of one call in {@link JmapClient.requestSettled}. */
export type CallResult<Response> =
  { ok: true; value: Response } | { ok: false; error: JmapMethodError };

/** Results of the calls returned by the builder, in order, plus {@link RequestMeta}. */
export type SettledRequestResult<Handles extends readonly AnyCallHandle[]> = {
  -readonly [K in keyof Handles]: CallResult<Awaited<Handles[K]>>;
} & RequestMeta;

export interface DownloadParams {
  accountId: Id;
  blobId: Id;
  /** File name to download as. Default: the blob id. */
  name?: string;
  /** Media type to serve. Default `application/octet-stream`. */
  type?: string;
}

/** Body accepted by {@link JmapClient.upload}; sent as is. */
export type UploadData = Blob | BufferSource;

export type SessionChangeListener = (session: Session) => void;

export interface JmapClient {
  /** The session, fetched on first use then cached. */
  getSession(): Promise<Session>;
  /** Re-fetches the session. */
  refreshSession(): Promise<Session>;
  /**
   * Primary account for a capability (default mail). Needs the session to
   * be loaded; throws if it is not, or if there is no such account.
   */
  getPrimaryAccountId(capability?: string): Id;
  /**
   * Whether the session (or, with `accountId`, that account) has a
   * capability. Needs the session to be loaded.
   */
  hasCapability(capability: string, accountId?: Id): boolean;
  /**
   * Called with the new session when it changed: an API response carried a
   * different `sessionState` (the client re-fetches first) or a refresh
   * returned a new state. Returns the unsubscribe function.
   */
  onSessionChange(listener: SessionChangeListener): () => void;
  /** Sends a request with a single method call and returns its response. */
  call<M extends JmapMethodName, const Property extends MethodPropertyName<M> = never>(
    method: M,
    args: CallArgs<M, Property>,
    options?: CallOptions,
  ): Promise<NarrowedMethodResponse<M, Property>>;
  /**
   * Sends several calls in one request. Resolves to the responses of the
   * handles returned by `build`, or rejects with the first
   * {@link JmapMethodError} among them; each handle can also be awaited on
   * its own.
   */
  request<const Handles extends readonly AnyCallHandle[]>(
    build: (builder: RequestBuilder) => Handles,
    options?: RequestOptions,
  ): Promise<RequestResult<Handles>>;
  /**
   * Like {@link JmapClient.request}, but a failing call does not reject:
   * each entry is `{ ok: true, value }` or `{ ok: false, error }`. Request
   * level failures (HTTP, auth, invalid JSON) still reject.
   */
  requestSettled<const Handles extends readonly AnyCallHandle[]>(
    build: (builder: RequestBuilder) => Handles,
    options?: RequestOptions,
  ): Promise<SettledRequestResult<Handles>>;
  /** Uploads a blob (RFC 8620 §6.1). */
  upload(
    accountId: Id,
    data: UploadData,
    contentType?: string,
    options?: { signal?: AbortSignal },
  ): Promise<UploadResponse>;
  /** Download URL from the session template. Needs the session to be loaded. */
  getDownloadUrl(params: DownloadParams): string;
  /** Downloads a blob with authentication. */
  download(params: DownloadParams, options?: { signal?: AbortSignal }): Promise<Blob>;
  /** Opens a push channel over WebSocket (RFC 8887). */
  connectWebSocket(options?: WebSocketPushOptions): PushConnection;
}

/** Creates a JMAP client. No network request is made until it is used. */
export function createClient(options: ClientOptions): JmapClient {
  return new Client(options);
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  // Called on globalThis so browsers do not throw "Illegal invocation".
  return globalThis.fetch(input, init);
}

function toCapabilityList(value: unknown): readonly string[] | null {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value;
  }
  return null;
}

function hasLocation(): boolean {
  return 'location' in globalThis;
}

/** Resolves `url` against `base`, also when `base` is relative to the page. */
function resolveUrl(url: string, base: string): string {
  try {
    const absoluteBase = hasLocation() ? new URL(base, globalThis.location.href) : new URL(base);
    return new URL(url, absoluteBase).toString();
  } catch {
    return url;
  }
}

function toWebSocketUrl(url: string): string {
  return url.replace(/^http(s?):/i, 'ws$1:');
}

function toRecordOfRecords(value: Record<string, unknown>): Record<string, CapabilityObject> {
  const result: Record<string, CapabilityObject> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) {
      result[key] = item;
    }
  }
  return result;
}

function toAccounts(value: Record<string, unknown>): Record<Id, Account> {
  const result: Record<Id, Account> = {};
  for (const [accountId, account] of Object.entries(value)) {
    if (!isRecord(account)) {
      continue;
    }
    result[accountId] = {
      name: typeof account.name === 'string' ? account.name : '',
      isPersonal: account.isPersonal === true,
      isReadOnly: account.isReadOnly === true,
      accountCapabilities: isRecord(account.accountCapabilities)
        ? toRecordOfRecords(account.accountCapabilities)
        : {},
    };
  }
  return result;
}

function parseSession(value: unknown, sessionUrl: string): Session {
  if (
    !isRecord(value) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.accounts) ||
    !isRecord(value.primaryAccounts) ||
    typeof value.apiUrl !== 'string' ||
    typeof value.downloadUrl !== 'string' ||
    typeof value.uploadUrl !== 'string' ||
    typeof value.state !== 'string'
  ) {
    throw new JmapInvalidResponseError(`Invalid JMAP session from ${sessionUrl}`);
  }
  return {
    capabilities: toRecordOfRecords(value.capabilities),
    accounts: toAccounts(value.accounts),
    primaryAccounts: toIdMap(value.primaryAccounts),
    username: typeof value.username === 'string' ? value.username : '',
    apiUrl: value.apiUrl,
    downloadUrl: value.downloadUrl,
    uploadUrl: value.uploadUrl,
    eventSourceUrl: typeof value.eventSourceUrl === 'string' ? value.eventSourceUrl : '',
    state: value.state,
  };
}

class Client implements JmapClient {
  readonly #sessionUrl: string;
  readonly #overrideApiUrl: string | null;
  readonly #http: AuthenticatedHttp;
  readonly #methodCapabilities = new Map<string, readonly string[]>();
  readonly #sessionListeners = new Set<SessionChangeListener>();
  #session: Session | null = null;
  #sessionRequest: Promise<Session> | null = null;

  constructor(options: ClientOptions) {
    this.#sessionUrl = options.sessionUrl;
    this.#overrideApiUrl = options.overrideApiUrl ?? null;
    this.#http = new AuthenticatedHttp(options.fetch ?? defaultFetch, options.auth ?? null);
    for (const [method, capabilities] of Object.entries(BUILTIN_METHOD_CAPABILITIES)) {
      this.#methodCapabilities.set(method, capabilities);
    }
    const extensionCapabilities: Record<string, unknown> = options.methodCapabilities ?? {};
    for (const [method, capability] of Object.entries(extensionCapabilities)) {
      const list = toCapabilityList(capability);
      if (list === null) {
        throw new TypeError(`methodCapabilities["${method}"] must be a string or string[]`);
      }
      this.#methodCapabilities.set(method, list);
    }
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  async getSession(): Promise<Session> {
    if (this.#session !== null) {
      return this.#session;
    }
    return this.#loadSession();
  }

  async refreshSession(): Promise<Session> {
    return this.#loadSession();
  }

  getPrimaryAccountId(capability: string = CAPABILITIES.mail): Id {
    const session = this.#requireSession();
    const accountId = session.primaryAccounts[capability];
    if (accountId === undefined) {
      throw new JmapError(`No primary account for ${capability}`);
    }
    return accountId;
  }

  hasCapability(capability: string, accountId?: Id): boolean {
    const session = this.#requireSession();
    if (accountId === undefined) {
      return capability in session.capabilities;
    }
    const account = session.accounts[accountId];
    return account !== undefined && capability in account.accountCapabilities;
  }

  onSessionChange(listener: SessionChangeListener): () => void {
    this.#sessionListeners.add(listener);
    return () => {
      this.#sessionListeners.delete(listener);
    };
  }

  #requireSession(): Session {
    if (this.#session === null) {
      throw new JmapError('Session not loaded yet: await client.getSession() first');
    }
    return this.#session;
  }

  /** Fetches the session; concurrent callers share one request. */
  async #loadSession(): Promise<Session> {
    if (this.#sessionRequest !== null) {
      return this.#sessionRequest;
    }
    this.#sessionRequest = this.#fetchSession().finally(() => {
      this.#sessionRequest = null;
    });
    return this.#sessionRequest;
  }

  async #fetchSession(): Promise<Session> {
    const response = await this.#http.fetchOk(this.#sessionUrl, {
      headers: { Accept: 'application/json' },
    });
    const raw = parseSession(await readJson(response, this.#sessionUrl), this.#sessionUrl);
    const session: Session = {
      ...raw,
      apiUrl: resolveUrl(this.#overrideApiUrl ?? raw.apiUrl, this.#sessionUrl),
    };
    const previous = this.#session;
    this.#session = session;
    if (previous !== null && previous.state !== session.state) {
      emitSafely(this.#sessionListeners, session);
    }
    return session;
  }

  async #onResponseSessionState(sessionState: string): Promise<void> {
    if (this.#session === null || this.#session.state === sessionState) {
      return;
    }
    try {
      await this.#loadSession();
    } catch {
      // The API call itself succeeded; a failed refresh is retried on the
      // next response that still carries a different session state.
    }
  }

  // -------------------------------------------------------------------------
  // Method calls
  // -------------------------------------------------------------------------

  async call<M extends JmapMethodName, const Property extends MethodPropertyName<M> = never>(
    method: M,
    args: CallArgs<M, Property>,
    options: CallOptions = {},
  ): Promise<NarrowedMethodResponse<M, Property>> {
    const builder = new RequestBuilderImpl();
    const handle = builder.register<M, NarrowedMethodResponse<M, Property>>(method, args);
    await this.#send(builder, options);
    return handle;
  }

  async request<const Handles extends readonly AnyCallHandle[]>(
    build: (builder: RequestBuilder) => Handles,
    options: RequestOptions = {},
  ): Promise<RequestResult<Handles>> {
    const { handles, meta } = await this.#buildAndSend(build, options);
    const responses: unknown[] = [];
    for (const handle of handles) {
      responses.push(await handle);
    }
    // The tuple type is computed from Handles; values come in the same order.
    return Object.assign(responses, meta) as RequestResult<Handles>;
  }

  async requestSettled<const Handles extends readonly AnyCallHandle[]>(
    build: (builder: RequestBuilder) => Handles,
    options: RequestOptions = {},
  ): Promise<SettledRequestResult<Handles>> {
    const { handles, meta } = await this.#buildAndSend(build, options);
    const results: Array<CallResult<unknown>> = [];
    for (const handle of handles) {
      try {
        results.push({ ok: true, value: await handle });
      } catch (error: unknown) {
        if (!(error instanceof JmapMethodError)) {
          throw error;
        }
        results.push({ ok: false, error });
      }
    }
    // The tuple type is computed from Handles; values come in the same order.
    return Object.assign(results, meta) as SettledRequestResult<Handles>;
  }

  async #buildAndSend(
    build: (builder: RequestBuilder) => readonly AnyCallHandle[],
    options: RequestOptions,
  ): Promise<{ handles: AnyCallHandle[]; meta: RequestMeta }> {
    const builder = new RequestBuilderImpl();
    const returned = build(builder);
    if (!Array.isArray(returned)) {
      throw new TypeError('request(): the builder must return an array of call handles');
    }
    const handles: AnyCallHandle[] = [];
    for (const handle of returned) {
      if (!(handle instanceof CallHandleImpl) || handle.owner !== builder) {
        throw new TypeError('request(): the builder returned a handle of another request');
      }
      handles.push(handle);
    }
    const meta = await this.#send(builder, options);
    return { handles, meta };
  }

  #computeUsing(invocations: readonly OutgoingInvocation[], extra: readonly string[]): string[] {
    const using = new Set<string>([CAPABILITIES.core]);
    for (const [method] of invocations) {
      const capabilities = this.#methodCapabilities.get(method);
      if (capabilities === undefined) {
        throw new TypeError(
          `Unknown capability for ${method}: declare it in createClient({ methodCapabilities })`,
        );
      }
      for (const capability of capabilities) {
        using.add(capability);
      }
    }
    for (const capability of extra) {
      using.add(capability);
    }
    return [...using];
  }

  async #send(builder: RequestBuilderImpl, options: RequestOptions): Promise<RequestMeta> {
    try {
      if (builder.invocations.length === 0) {
        throw new TypeError('request(): no method call');
      }
      const body: OutgoingRequest = {
        using: this.#computeUsing(builder.invocations, options.extraCapabilities ?? []),
        methodCalls: [...builder.invocations],
      };
      if (options.createdIds !== undefined) {
        body.createdIds = options.createdIds;
      }
      const session = await this.getSession();
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      };
      if (options.signal !== undefined) {
        init.signal = options.signal;
      }
      const response = await this.#http.fetchOk(session.apiUrl, init);
      const json = await readJson(response, session.apiUrl);
      if (
        !isRecord(json) ||
        !Array.isArray(json.methodResponses) ||
        typeof json.sessionState !== 'string'
      ) {
        throw new JmapInvalidResponseError(`Invalid JMAP response from ${session.apiUrl}`);
      }
      settleHandles(builder.handles, json.methodResponses);
      await this.#onResponseSessionState(json.sessionState);
      return {
        createdIds: isRecord(json.createdIds) ? toIdMap(json.createdIds) : null,
        sessionState: json.sessionState,
      };
    } catch (error: unknown) {
      for (const handle of builder.handles) {
        handle.reject(error);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Blobs
  // -------------------------------------------------------------------------

  async upload(
    accountId: Id,
    data: UploadData,
    contentType?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<UploadResponse> {
    const session = await this.getSession();
    const url = resolveUrl(expandUriTemplate(session.uploadUrl, { accountId }), this.#sessionUrl);
    const blobType = data instanceof Blob && data.type !== '' ? data.type : null;
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': contentType ?? blobType ?? 'application/octet-stream',
        Accept: 'application/json',
      },
      body: data,
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }
    const response = await this.#http.fetchOk(url, init);
    const json = await readJson(response, url);
    if (
      !isRecord(json) ||
      typeof json.blobId !== 'string' ||
      typeof json.size !== 'number' ||
      typeof json.type !== 'string'
    ) {
      throw new JmapInvalidResponseError(`Invalid upload response from ${url}`);
    }
    return {
      accountId: typeof json.accountId === 'string' ? json.accountId : accountId,
      blobId: json.blobId,
      type: json.type,
      size: json.size,
    };
  }

  getDownloadUrl(params: DownloadParams): string {
    const session = this.#requireSession();
    return this.#expandDownloadUrl(session, params);
  }

  async download(params: DownloadParams, options: { signal?: AbortSignal } = {}): Promise<Blob> {
    const session = await this.getSession();
    const url = this.#expandDownloadUrl(session, params);
    const init: RequestInit = {};
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }
    const response = await this.#http.fetchOk(url, init);
    return response.blob();
  }

  #expandDownloadUrl(session: Session, params: DownloadParams): string {
    const expanded = expandUriTemplate(session.downloadUrl, {
      accountId: params.accountId,
      blobId: params.blobId,
      name: params.name ?? params.blobId,
      type: params.type ?? 'application/octet-stream',
    });
    return resolveUrl(expanded, this.#sessionUrl);
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  connectWebSocket(options: WebSocketPushOptions = {}): PushConnection {
    return new WebSocketPush({
      options,
      resolveUrl: () => this.#makeWebSocketUrl(),
    });
  }

  async #makeWebSocketUrl(): Promise<string> {
    const session = await this.getSession();
    const capability = session.capabilities[CAPABILITIES.webSocket];
    if (!isRecord(capability) || typeof capability.url !== 'string') {
      throw new JmapPushNotSupportedError('The server does not support JMAP over WebSocket');
    }
    if (capability.supportsPush !== true) {
      throw new JmapPushNotSupportedError('The server does not support push over WebSocket');
    }
    const url = new URL(toWebSocketUrl(resolveUrl(capability.url, this.#sessionUrl)));
    const ticketEndpoint = findTicketEndpoint(session);
    if (ticketEndpoint !== null) {
      const ticket = await this.#fetchWebSocketTicket(resolveUrl(ticketEndpoint, this.#sessionUrl));
      url.searchParams.set('ticket', ticket);
    }
    return url.toString();
  }

  async #fetchWebSocketTicket(endpoint: string): Promise<string> {
    const response = await this.#http.fetchOk(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const json = await readJson(response, endpoint);
    if (!isRecord(json) || typeof json.value !== 'string') {
      throw new JmapInvalidResponseError(`Invalid WebSocket ticket from ${endpoint}`);
    }
    return json.value;
  }
}

/** Ticket generation endpoint, at session level or in the primary account. */
function findTicketEndpoint(session: Session): string | null {
  const fromSession = session.capabilities[CAPABILITIES.webSocketTicket];
  if (isRecord(fromSession) && typeof fromSession.generationEndpoint === 'string') {
    return fromSession.generationEndpoint;
  }
  const accountId =
    session.primaryAccounts[CAPABILITIES.webSocketTicket] ??
    session.primaryAccounts[CAPABILITIES.mail];
  const fromAccount =
    accountId === undefined
      ? undefined
      : session.accounts[accountId]?.accountCapabilities[CAPABILITIES.webSocketTicket];
  if (isRecord(fromAccount) && typeof fromAccount.generationEndpoint === 'string') {
    return fromAccount.generationEndpoint;
  }
  return null;
}

function toIdMap(value: Record<string, unknown>): Record<Id, Id> {
  const result: Record<Id, Id> = {};
  for (const [key, id] of Object.entries(value)) {
    if (typeof id === 'string') {
      result[key] = id;
    }
  }
  return result;
}

/** Dispatches method responses to their handles (first response per call id wins). */
function settleHandles(
  handles: readonly SettleableHandle[],
  methodResponses: readonly unknown[],
): void {
  const byCallId = new Map<string, [string, Record<string, unknown>]>();
  for (const entry of methodResponses) {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== 'string' ||
      !isRecord(entry[1]) ||
      typeof entry[2] !== 'string'
    ) {
      throw new JmapInvalidResponseError('Invalid invocation in methodResponses');
    }
    // EmailSubmission/set may add an implicit Email/set response with the same id.
    if (!byCallId.has(entry[2])) {
      byCallId.set(entry[2], [entry[0], entry[1]]);
    }
  }
  for (const handle of handles) {
    const response = byCallId.get(handle.callId);
    if (response === undefined) {
      handle.reject(
        new JmapInvalidResponseError(`No response for ${handle.method} (${handle.callId})`),
      );
      continue;
    }
    const [name, args] = response;
    if (name === 'error') {
      handle.reject(
        new JmapMethodError({
          arguments: { ...args, type: typeof args.type === 'string' ? args.type : 'unknown' },
          methodName: handle.method,
          callId: handle.callId,
        }),
      );
    } else {
      handle.resolve(args);
    }
  }
}
