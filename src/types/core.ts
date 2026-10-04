/**
 * JMAP core data types (RFC 8620).
 *
 * Payload types follow the RFC exactly (optional members stay optional,
 * `null` is used where the RFC says so).
 */

/** RFC 8620 §1.2: an opaque server-assigned identifier. */
export type Id = string;

/** RFC 8620 §1.4: `YYYY-MM-DDTHH:MM:SSZ`, always UTC. */
export type UTCDate = string;

/** RFC 8620 §1.4: a date with a time zone offset. */
export type JmapDate = string;

/** Unsigned integer, 0 <= value <= 2^53 - 1. */
export type UnsignedInt = number;

/** RFC 8620 §2: one entry of `Session.capabilities` or `Account.accountCapabilities`. */
export type CapabilityObject = Record<string, unknown>;

/** RFC 8620 §2: `urn:ietf:params:jmap:core` capability object. */
export interface CoreCapability {
  maxSizeUpload: UnsignedInt;
  maxConcurrentUpload: UnsignedInt;
  maxSizeRequest: UnsignedInt;
  maxConcurrentRequests: UnsignedInt;
  maxCallsInRequest: UnsignedInt;
  maxObjectsInGet: UnsignedInt;
  maxObjectsInSet: UnsignedInt;
  collationAlgorithms: string[];
}

/** RFC 8887 §4: `urn:ietf:params:jmap:websocket` capability object. */
export interface WebSocketCapability {
  url: string;
  supportsPush: boolean;
}

/** Linagora `com:linagora:params:jmap:ws:ticket` capability object. */
export interface WebSocketTicketCapability {
  generationEndpoint?: string;
  revocationEndpoint?: string;
}

/** RFC 8620 §2: an account the user has access to. */
export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, CapabilityObject>;
}

/** RFC 8620 §2: the JMAP Session resource. */
export interface Session {
  capabilities: Record<string, CapabilityObject>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

/** RFC 8620 §3.2: `[name, arguments, methodCallId]`. */
export type Invocation<Args = Record<string, unknown>> = [
  name: string,
  arguments: Args,
  id: string,
];

/** RFC 8620 §3.3: the Request object. */
export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<Id, Id>;
}

/** RFC 8620 §3.4: the Response object. */
export interface JmapResponse {
  methodResponses: Invocation[];
  createdIds?: Record<Id, Id>;
  sessionState: string;
}

/**
 * RFC 8620 §3.7: a back-reference to the result of a previous call.
 *
 * `Value` is a phantom type describing what the reference resolves to; it
 * lets the request builder check that a reference fits the argument it is
 * assigned to. It never exists at runtime.
 */
export interface ResultReference<Value = unknown> {
  resultOf: string;
  name: string;
  path: string;
  /** @internal phantom member, never set */
  readonly __value?: Value;
}

/** RFC 8620 §3.6.1 / RFC 7807: request-level error document. */
export interface ProblemDetails {
  type: string;
  status?: number;
  detail?: string;
  title?: string;
  limit?: string;
  [extra: string]: unknown;
}

/** RFC 8620 §3.6.2: method-level error arguments. */
export interface MethodErrorArguments {
  type: string;
  description?: string;
  [extra: string]: unknown;
}

/** RFC 8620 §5.3: why a create/update/destroy failed. */
export interface SetError {
  type: string;
  description?: string | null;
  properties?: string[];
  existingId?: Id;
  [extra: string]: unknown;
}

/** RFC 8620 §5.5: a filter operator combining conditions. */
export interface FilterOperator<Condition> {
  operator: 'AND' | 'OR' | 'NOT';
  conditions: Array<FilterOperator<Condition> | Condition>;
}

/** A filter: a single condition or an operator tree. */
export type Filter<Condition> = FilterOperator<Condition> | Condition;

/** RFC 8620 §5.5: sort comparator. */
export interface Comparator<Property extends string = string> {
  property: Property;
  isAscending?: boolean;
  collation?: string;
}

/** RFC 8620 §5.6: an item added to a query result. */
export interface AddedItem {
  id: Id;
  index: UnsignedInt;
}

/** RFC 8620 §7.1: StateChange push object. */
export interface StateChange {
  '@type': 'StateChange';
  /** accountId -> type name -> state */
  changed: Record<Id, Record<string, string>>;
  /** RFC 8887 §4.3.5: present over WebSocket when the server supports it. */
  pushState?: string;
}

/** RFC 8620 §6.1: upload response. */
export interface UploadResponse {
  accountId: Id;
  blobId: Id;
  type: string;
  size: UnsignedInt;
}
