/**
 * JMAP for Mail data types (RFC 8621).
 */
import type { Comparator, Filter, Id, JmapDate, SetError, UnsignedInt, UTCDate } from './core.js';
import type { PatchObject, PropertyOf } from './generic.js';

// ---------------------------------------------------------------------------
// Mailbox (§2)
// ---------------------------------------------------------------------------

/** RFC 8621 §2 / RFC 8457 roles; servers may use others. */
export type MailboxRole =
  | 'all'
  | 'archive'
  | 'drafts'
  | 'flagged'
  | 'important'
  | 'inbox'
  | 'junk'
  | 'sent'
  | 'subscribed'
  | 'trash'
  | (string & {});

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: MailboxRole | null;
  sortOrder: UnsignedInt;
  totalEmails: UnsignedInt;
  unreadEmails: UnsignedInt;
  totalThreads: UnsignedInt;
  unreadThreads: UnsignedInt;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

/** Properties a client may send when creating a Mailbox. */
export interface MailboxCreate {
  name: string;
  parentId?: Id | null;
  role?: MailboxRole | null;
  sortOrder?: UnsignedInt;
  isSubscribed?: boolean;
}

export interface MailboxFilterCondition {
  parentId?: Id | null;
  name?: string;
  role?: MailboxRole | null;
  hasAnyRole?: boolean;
  isSubscribed?: boolean;
}

export type MailboxComparator = Comparator<'sortOrder' | 'name' | (string & {})>;

// ---------------------------------------------------------------------------
// Thread (§3)
// ---------------------------------------------------------------------------

export interface Thread {
  id: Id;
  emailIds: Id[];
}

// ---------------------------------------------------------------------------
// Email (§4)
// ---------------------------------------------------------------------------

/** §4.1.2.3 */
export interface EmailAddress {
  name: string | null;
  email: string;
}

/** §4.1.2.4 */
export interface EmailAddressGroup {
  name: string | null;
  addresses: EmailAddress[];
}

/** §4.1.3: a raw header field. */
export interface EmailHeader {
  name: string;
  value: string;
}

/** §4.1.4 */
export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

/** Value type of each parsed header form (§4.1.2). */
export interface HeaderForms {
  Raw: string;
  Text: string;
  Addresses: EmailAddress[];
  GroupedAddresses: EmailAddressGroup[];
  MessageIds: string[] | null;
  Date: JmapDate | null;
  URLs: string[] | null;
}

export type HeaderForm = keyof HeaderForms;

/**
 * `header:{name}`, `header:{name}:as{Form}`, optionally suffixed with `:all`
 * (§4.1.3).
 */
export type HeaderProperty = `header:${string}`;

/** Union of every value a header property may hold. */
export type HeaderPropertyValue =
  HeaderForms[HeaderForm] | null | Array<HeaderForms[HeaderForm]> | string[];

/** Exact value type of a given header property name. */
export type HeaderValueOf<Property extends string> =
  Property extends `header:${string}:as${infer Form extends HeaderForm}:all`
    ? Array<HeaderForms[Form]>
    : Property extends `header:${string}:as${infer Form extends HeaderForm}`
      ? HeaderForms[Form] | null
      : Property extends `header:${string}:all`
        ? string[]
        : Property extends `header:${string}`
          ? string | null
          : never;

/** §4.1.4 */
export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: UnsignedInt;
  headers: EmailHeader[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts: EmailBodyPart[] | null;
  [header: HeaderProperty]: HeaderPropertyValue;
}

/**
 * The Email object (§4.1), all properties. Header properties in any parsed
 * form (`header:List-Id:asText`, `header:From:asAddresses:all`, …) are
 * covered by the index signature; requesting one in `Email/get` narrows it
 * to its exact type.
 */
export interface Email {
  // Metadata (§4.1.1)
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, true>;
  /** System (`$seen`, `$flagged`, …) and custom keywords. */
  keywords: Record<string, true>;
  size: UnsignedInt;
  receivedAt: UTCDate;
  // Header fields (§4.1.2, §4.1.3)
  headers: EmailHeader[];
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: EmailAddress[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: JmapDate | null;
  // Body parts (§4.1.4)
  bodyStructure: EmailBodyPart;
  bodyValues: Record<string, EmailBodyValue>;
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  hasAttachment: boolean;
  preview: string;
  [header: HeaderProperty]: HeaderPropertyValue;
}

export type EmailProperty = PropertyOf<Email>;

/** Body part sent when creating an Email (§4.6). */
export interface EmailBodyPartCreate {
  partId?: string;
  blobId?: Id;
  size?: UnsignedInt;
  headers?: EmailHeader[];
  name?: string | null;
  type?: string;
  charset?: string | null;
  disposition?: string | null;
  cid?: string | null;
  language?: string[] | null;
  location?: string | null;
  subParts?: EmailBodyPartCreate[] | null;
  [header: HeaderProperty]: HeaderPropertyValue | undefined;
}

/** Email creation object (§4.6). */
export interface EmailCreate {
  mailboxIds: Record<Id, true>;
  keywords?: Record<string, true>;
  receivedAt?: UTCDate;
  headers?: EmailHeader[];
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  sender?: EmailAddress[] | null;
  from?: EmailAddress[] | null;
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  subject?: string | null;
  sentAt?: JmapDate | null;
  bodyStructure?: EmailBodyPartCreate;
  bodyValues?: Record<string, Partial<EmailBodyValue> & { value: string }>;
  textBody?: EmailBodyPartCreate[];
  htmlBody?: EmailBodyPartCreate[];
  attachments?: EmailBodyPartCreate[];
  [header: HeaderProperty]: HeaderPropertyValue | undefined;
}

export interface EmailFilterCondition {
  inMailbox?: Id;
  inMailboxOtherThan?: readonly Id[];
  before?: UTCDate;
  after?: UTCDate;
  minSize?: UnsignedInt;
  maxSize?: UnsignedInt;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: readonly [name: string] | readonly [name: string, value: string];
}

export interface EmailComparator extends Comparator<
  | 'receivedAt'
  | 'size'
  | 'from'
  | 'to'
  | 'subject'
  | 'sentAt'
  | 'hasKeyword'
  | 'allInThreadHaveKeyword'
  | 'someInThreadHaveKeyword'
  | (string & {})
> {
  keyword?: string;
}

/** Extra `Email/get` and `Email/parse` arguments (§4.2, §4.9). */
export interface EmailBodyFetchOptions {
  bodyProperties?: readonly (PropertyOf<EmailBodyPart> | HeaderProperty)[];
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: UnsignedInt;
}

/** `Email/copy` creation object (§4.7). */
export interface EmailCopy {
  id: Id;
  mailboxIds: Record<Id, true>;
  keywords?: Record<string, true>;
  receivedAt?: UTCDate;
}

/** `Email/import` creation object (§4.8). */
export interface EmailImport {
  blobId: Id;
  mailboxIds: Record<Id, true>;
  keywords?: Record<string, true>;
  receivedAt?: UTCDate;
}

export interface EmailImportArgs {
  accountId: Id;
  ifInState?: string | null;
  emails: Record<Id, EmailImport>;
}

export interface EmailImportResponse {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Pick<Email, 'id' | 'blobId' | 'threadId' | 'size'>> | null;
  notCreated: Record<Id, SetError> | null;
}

export interface EmailParseArgs extends EmailBodyFetchOptions {
  accountId: Id;
  blobIds: readonly Id[];
  properties?: readonly EmailProperty[] | null;
}

export interface EmailParseResponse {
  accountId: Id;
  parsed: Record<Id, Email> | null;
  notParsable: Id[] | null;
  notFound: Id[] | null;
}

// ---------------------------------------------------------------------------
// SearchSnippet (§5)
// ---------------------------------------------------------------------------

export interface SearchSnippet {
  emailId: Id;
  subject: string | null;
  preview: string | null;
}

export interface SearchSnippetGetArgs {
  accountId: Id;
  filter?: Filter<EmailFilterCondition> | null;
  emailIds: readonly Id[];
}

export interface SearchSnippetGetResponse {
  accountId: Id;
  list: SearchSnippet[];
  notFound: Id[] | null;
}

// ---------------------------------------------------------------------------
// Identity (§6)
// ---------------------------------------------------------------------------

export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

export interface IdentityCreate {
  email: string;
  name?: string;
  replyTo?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  textSignature?: string;
  htmlSignature?: string;
}

// ---------------------------------------------------------------------------
// EmailSubmission (§7)
// ---------------------------------------------------------------------------

export interface EmailSubmissionAddress {
  email: string;
  parameters: Record<string, string | null> | null;
}

export interface Envelope {
  mailFrom: EmailSubmissionAddress;
  rcptTo: EmailSubmissionAddress[];
}

export interface DeliveryStatus {
  smtpReply: string;
  delivered: 'queued' | 'yes' | 'no' | 'unknown';
  displayed: 'unknown' | 'yes';
}

export type UndoStatus = 'pending' | 'final' | 'canceled';

export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  envelope: Envelope | null;
  sendAt: UTCDate;
  undoStatus: UndoStatus;
  deliveryStatus: Record<string, DeliveryStatus> | null;
  dsnBlobIds: Id[];
  mdnBlobIds: Id[];
}

export interface EmailSubmissionCreate {
  identityId: Id;
  /** An Email id, or `#creationId` of an Email created in the same request. */
  emailId: Id;
  envelope?: Envelope | null;
  sendAt?: UTCDate;
}

export interface EmailSubmissionFilterCondition {
  identityIds?: readonly Id[];
  emailIds?: readonly Id[];
  threadIds?: readonly Id[];
  undoStatus?: UndoStatus;
  before?: UTCDate;
  after?: UTCDate;
}

export type EmailSubmissionComparator = Comparator<
  'emailId' | 'threadId' | 'sentAt' | (string & {})
>;

/** Extra `EmailSubmission/set` arguments (§7.5). */
export interface EmailSubmissionSetExtraArgs {
  /** Keys are EmailSubmission ids or `#creationId`. */
  onSuccessUpdateEmail?: Record<string, PatchObject<Email>> | null;
  /** EmailSubmission ids or `#creationId`. */
  onSuccessDestroyEmail?: readonly string[] | null;
}

// ---------------------------------------------------------------------------
// VacationResponse (§8)
// ---------------------------------------------------------------------------

export interface VacationResponse {
  /** Always `singleton`. */
  id: Id;
  isEnabled: boolean;
  fromDate: UTCDate | null;
  toDate: UTCDate | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}
