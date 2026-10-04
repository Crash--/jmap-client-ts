import { JmapHttpError, JmapInvalidResponseError, JmapRequestError } from './errors.js';
import type { JmapError } from './errors.js';
import { isRecord } from './guards.js';
import type { ProblemDetails } from './types/core.js';

/** `fetch`-compatible function. */
export type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

/** How the client authenticates its HTTP requests. */
export interface AuthOptions {
  /**
   * Value of the `Authorization` header (`Bearer …`, `Basic …`), or `null`
   * to send none. Called before every HTTP request.
   */
  getAuthorizationHeader: () => string | null | Promise<string | null>;
  /**
   * Called once when the server answers 401. Resolve `true` if credentials
   * were refreshed: the request is then retried once.
   */
  onUnauthorized?: () => boolean | Promise<boolean>;
}

function isProblemDetails(value: unknown): value is ProblemDetails {
  return isRecord(value) && typeof value.type === 'string';
}

/** Builds the error matching a non-2xx response (consumes its body). */
export async function makeHttpError(response: Response, url: string): Promise<JmapError> {
  const body = await response.text().catch(() => '');
  const contentType = response.headers.get('content-type') ?? '';
  if (body !== '' && (contentType.includes('json') || body.startsWith('{'))) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        isProblemDetails(parsed) &&
        (contentType.includes('problem+json') || parsed.type.startsWith('urn:ietf:params:jmap:'))
      ) {
        return new JmapRequestError(parsed, response.status);
      }
    } catch {
      // Not JSON after all: fall through to a plain HTTP error.
    }
  }
  return new JmapHttpError({ status: response.status, statusText: response.statusText, body, url });
}

/** Reads a JSON body, throwing {@link JmapInvalidResponseError} if it is not JSON. */
export async function readJson(response: Response, url: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new JmapInvalidResponseError(`Invalid JSON from ${url}`, { cause: error });
  }
}

/** Sends HTTP requests with the `Authorization` header and a single retry on 401. */
export class AuthenticatedHttp {
  readonly #fetch: FetchFunction;
  readonly #auth: AuthOptions | null;
  #pendingRefresh: Promise<boolean> | null = null;

  constructor(fetchFunction: FetchFunction, auth: AuthOptions | null) {
    this.#fetch = fetchFunction;
    this.#auth = auth;
  }

  /**
   * Fetches `url`. `init.body` must be replayable (string, Blob, buffer):
   * it is sent again on the retry that follows a successful refresh.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#send(url, init);
    if (response.status !== 401 || this.#auth?.onUnauthorized === undefined) {
      return response;
    }
    const refreshed = await this.#refreshOnce(this.#auth.onUnauthorized);
    if (!refreshed) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    return this.#send(url, init);
  }

  /** Fetches and throws the matching error on any non-2xx status. */
  async fetchOk(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetch(url, init);
    if (!response.ok) {
      throw await makeHttpError(response, url);
    }
    return response;
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const authorization = this.#auth === null ? null : await this.#auth.getAuthorizationHeader();
    if (authorization !== null) {
      headers.set('Authorization', authorization);
    }
    const fetchFunction = this.#fetch;
    return fetchFunction(url, { ...init, headers });
  }

  /** Concurrent 401s share one refresh. */
  async #refreshOnce(onUnauthorized: () => boolean | Promise<boolean>): Promise<boolean> {
    if (this.#pendingRefresh === null) {
      this.#pendingRefresh = Promise.resolve()
        .then(onUnauthorized)
        .finally(() => {
          this.#pendingRefresh = null;
        });
    }
    return this.#pendingRefresh;
  }
}
