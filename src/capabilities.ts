/** Capability URNs used by the built-in methods and the push channel. */
export const CAPABILITIES = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  vacationResponse: 'urn:ietf:params:jmap:vacationresponse',
  quota: 'urn:ietf:params:jmap:quota',
  mdn: 'urn:ietf:params:jmap:mdn',
  webSocket: 'urn:ietf:params:jmap:websocket',
  /** Linagora (TMail) WebSocket authentication tickets. */
  webSocketTicket: 'com:linagora:params:jmap:ws:ticket',
} as const;

export type KnownCapability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];
