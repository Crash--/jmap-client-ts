import { vi } from 'vitest';

import type { FetchFunction, Session } from '../../src/index.js';

export const SESSION_URL = 'https://jmap.example.com/jmap/session';
export const ACCOUNT_ID = 'a1';

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': { maxSizeUpload: 50_000_000, maxCallsInRequest: 32 },
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': {},
      'urn:ietf:params:jmap:websocket': {
        url: 'https://jmap.example.com/jmap/ws',
        supportsPush: true,
      },
      'com:linagora:params:jmap:ws:ticket': {
        generationEndpoint: 'https://jmap.example.com/jmap/ws/ticket',
        revocationEndpoint: 'https://jmap.example.com/jmap/ws/ticket',
      },
    },
    accounts: {
      [ACCOUNT_ID]: {
        name: 'alice@example.com',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:quota': {},
        },
      },
    },
    primaryAccounts: {
      'urn:ietf:params:jmap:mail': ACCOUNT_ID,
      'urn:ietf:params:jmap:submission': ACCOUNT_ID,
    },
    username: 'alice@example.com',
    apiUrl: 'https://jmap.example.com/jmap',
    downloadUrl: 'https://jmap.example.com/download/{accountId}/{blobId}?type={type}&name={name}',
    uploadUrl: 'https://jmap.example.com/upload/{accountId}',
    eventSourceUrl: 'https://jmap.example.com/eventSource',
    state: 's1',
    ...overrides,
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
  json: () => unknown;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/**
 * Fake `fetch`: the session URL answers `session` (mutable through
 * `setSession`), other URLs are routed to `handlers` by `METHOD url`
 * (query string excluded) or by url alone.
 */
export function makeFakeServer(handlers: Record<string, Handler> = {}) {
  let session = makeSession();
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn<FetchFunction>(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const recorded: RecordedRequest = {
      url,
      method,
      headers: new Headers(init.headers),
      body: init.body,
      json: (): unknown => JSON.parse(typeof init.body === 'string' ? init.body : 'null'),
    };
    requests.push(recorded);
    const path = url.split('?')[0]!;
    const handler = handlers[`${method} ${path}`] ?? handlers[path];
    if (handler !== undefined) {
      return handler(recorded);
    }
    if (path === SESSION_URL && method === 'GET') {
      return jsonResponse(session);
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  });
  return {
    fetch,
    requests,
    setSession(next: Session) {
      session = next;
    },
    apiRequests: () => requests.filter(request => request.url === session.apiUrl),
  };
}

/** API handler answering each method call with `responses[method]`. */
export function apiHandler(
  responses: Record<string, (args: Record<string, unknown>) => unknown>,
  sessionState = 's1',
): Handler {
  return request => {
    const body = request.json() as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, callId]) => {
      const respond = responses[name];
      return respond === undefined
        ? ['error', { type: 'unknownMethod' }, callId]
        : [name, respond(args), callId];
    });
    return jsonResponse({ methodResponses, sessionState });
  };
}
