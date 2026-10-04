# jmap-client-ts v2 — API contract

Status: draft, agreed before implementation. The Twake Mail React frontend
(`Crash--/twake-mail-frontend`) is written against this contract in parallel;
changes to the public surface must be reflected here first.

## Goals

- JMAP core (RFC 8620), mail (RFC 8621), WebSocket push (RFC 8887), quotas
  (RFC 9425), MDN (RFC 9007).
- Several method calls per request, with typed result references
  (`#ids` → `ResultReference`).
- **Extensible**: apps and companion packages declare extra methods
  (Linagora / James extensions) through TypeScript declaration merging, without
  forking.
- Auth-agnostic: the caller provides the `Authorization` header (Bearer from
  OIDC with refresh, or Basic) and is told when the server answers 401.
- Runtime-agnostic: browser and Node 20+, ESM only, `fetch` injectable.
- No runtime dependency besides type-only `jmap-rfc-types` (MIT) if its types
  are accurate enough; otherwise our own types in `src/types/`.

## Toolchain

ESM only, TypeScript 5 strict, tsdown (or tsup) build to `dist/` with `.d.ts`,
vitest, ESLint 9 flat + Prettier 3, Node 24 (`.nvmrc`), GitHub Actions CI.
Integration tests run against `linagora/tmail-backend:memory-1.0.21.2`.

## Creating a client

```ts
import { createClient } from 'jmap-client-ts'

const client = createClient({
  sessionUrl: 'https://jmap.example.com/jmap/session',
  auth: {
    // Called before every HTTP request (JMAP API, upload, download, ticket).
    getAuthorizationHeader: async () => `Bearer ${await tokens.getAccessToken()}`,
    // Optional. Called once on HTTP 401. Resolve true if credentials were
    // refreshed: the request is then retried once.
    onUnauthorized: async () => tokens.refresh()
  },
  fetch: globalThis.fetch, // optional
  overrideApiUrl: undefined // optional, e.g. when the session advertises an internal host
})
```

## Session

```ts
const session = await client.getSession()      // fetched once, cached
await client.refreshSession()                  // forced re-fetch
client.getPrimaryAccountId('urn:ietf:params:jmap:mail') // string, throws if absent
client.hasCapability('com:linagora:params:jmap:labels')  // boolean
client.onSessionChange(listener)               // fires when a response's sessionState differs; client re-fetches first
```

## Calling methods

```ts
// One call
const mailboxes = await client.call('Mailbox/get', { accountId, ids: null })

// Several calls in one request, with back-references
const [query, emails] = await client.request(b => {
  const q = b.call('Email/query', { accountId, filter: { inMailbox }, sort, limit: 50 })
  const g = b.call('Email/get', {
    accountId,
    '#ids': q.ref('/ids'),
    properties: ['id', 'subject', 'from', 'receivedAt', 'keywords', 'preview']
  })
  return [q, g] as const
})
```

- `b.call()` returns a handle whose `ref(path)` builds a typed
  `ResultReference`. The awaited tuple holds each call's typed response.
- `using` is computed from the methods present in the request (each method
  declares its capability), plus `extraCapabilities?: string[]` passed to
  `client.request(build, { extraCapabilities })`.
- `createdIds` is supported via `client.request(build, { createdIds })` and
  returned on the result object (`result.createdIds`).

## Typing and extensions

All method signatures live in one interface that callers can extend:

```ts
export interface JmapMethods {
  'Mailbox/get': { capability: 'urn:ietf:params:jmap:mail'; args: GetArgs<Mailbox>; response: GetResponse<Mailbox> }
  // ...
}

// In an app or a companion package:
declare module 'jmap-client-ts' {
  interface JmapMethods {
    'Label/get': { capability: 'com:linagora:params:jmap:labels'; args: GetArgs<Label>; response: GetResponse<Label> }
  }
}
```

Generic helpers `GetArgs<T>`, `GetResponse<T>`, `SetArgs<T>`, `SetResponse<T>`,
`QueryArgs<Filter, Comparator>`, `QueryResponse`, `ChangesArgs`,
`ChangesResponse`, `QueryChangesArgs`, `QueryChangesResponse` are exported so
extension methods are one-liners. When `properties` is given, `get` responses
narrow `list` to those properties.

Built-in methods (v2.0):
Core/echo; Mailbox get/changes/query/queryChanges/set; Thread get/changes;
Email get/changes/query/queryChanges/set/copy/import/parse; SearchSnippet/get;
Identity get/changes/set; EmailSubmission get/changes/query/queryChanges/set;
VacationResponse get/set; Quota get/changes/query (RFC 9425); MDN send/parse
(RFC 9007).

Keywords are `Record<string, true>` (custom keywords allowed: labels use them).
`Email` covers every RFC 8621 property, including header forms
(`header:X:asText`, …) through a template literal index signature.

## Errors

- `JmapMethodError` — a method answered `["error", {type, description}, id]`.
  Carries `type`, `description`, `methodName`, `callId`. Thrown when awaiting
  that call's handle (other calls in the same request still resolve).
- `JmapRequestError` — request-level problem (RFC 7807 JSON): `type`, `status`,
  `detail`, `limit`.
- `JmapHttpError` — any other non-2xx: `status`, `statusText`, `body` (text).
- `/set` partial failures stay in the response (`notCreated`, `notUpdated`,
  `notDestroyed`); helper `assertSetSucceeded(response)` throws
  `JmapSetError` listing them.

## Blobs

```ts
const { blobId, type, size } = await client.upload(accountId, fileOrBlob, contentType?)
const url = client.getDownloadUrl({ accountId, blobId, name, type })   // template expanded
const blob = await client.download({ accountId, blobId, name, type })  // fetch with auth
```

Upload accepts 200 and 201, sends the body untouched (no JSON encoding).

## Push (WebSocket, RFC 8887)

```ts
const push = client.connectWebSocket({
  dataTypes: ['Email', 'Mailbox', 'Thread', 'EmailDelivery'], // or null for all
  pushState,                    // optional, resume
  ping: { intervalMs: 30_000 }  // optional, echo-based keepalive (Core/echo)
})
push.on('stateChange', change => { /* change.changed[accountId].Email = 'newState' */ })
push.on('status', s => { /* 'connecting' | 'open' | 'closed' | 'reconnecting' */ })
push.close()
```

- Authentication: if the session has `com:linagora:params:jmap:ws:ticket`
  (verify the exact URN and endpoint in jmap-dart-client / tmail-flutter), get
  a ticket with the auth header and pass it as `?ticket=` in the WebSocket URL
  (browsers cannot set headers on WebSocket). Otherwise rely on cookies / same
  origin.
- Reconnects with exponential backoff and jitter, fetching a fresh ticket each
  time. Exposes the last `pushState`.
- Requests over the WebSocket are out of scope for v2.0 (HTTP is used for API
  calls).

## Not in v2.0

EventSource push, PushSubscription, Blob/copy, Sieve. The Linagora extensions
(Label, Forward, Filter, Settings, EmailRecoveryAction, TMailContact,
CalendarEvent, PublicAsset, Mailbox/clear, Quota James) ship as a separate
entry point `jmap-client-ts/linagora` using the extension mechanism above, in a
later step.
