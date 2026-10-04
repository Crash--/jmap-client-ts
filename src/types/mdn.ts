/**
 * JMAP for Message Disposition Notification (RFC 9007).
 */
import type { Id, SetError } from './core.js';
import type { Email } from './mail.js';
import type { PatchObject } from './generic.js';

/** §2 */
export interface MdnDisposition {
  actionMode: 'manual-action' | 'automatic-action';
  sendingMode: 'mdn-sent-manually' | 'mdn-sent-automatically';
  type: 'deleted' | 'dispatched' | 'displayed' | 'processed';
}

/** §2: the MDN object. */
export interface Mdn {
  forEmailId: Id | null;
  subject: string | null;
  textBody: string | null;
  includeOriginalMessage: boolean;
  reportingUA: string | null;
  disposition: MdnDisposition;
  mdnGateway: string | null;
  originalRecipient: string | null;
  finalRecipient: string | null;
  originalMessageId: string | null;
  error: string[] | null;
  extensionFields: Record<string, string> | null;
}

/** MDN sent with `MDN/send`: only `forEmailId` and `disposition` are required. */
export type MdnSend = Pick<Mdn, 'forEmailId' | 'disposition'> &
  Partial<
    Pick<Mdn, 'subject' | 'textBody' | 'includeOriginalMessage' | 'reportingUA' | 'extensionFields'>
  >;

/** §2.1 */
export interface MdnSendArgs {
  accountId: Id;
  identityId: Id;
  send: Record<Id, MdnSend>;
  /** Keys are creation ids of `send`, prefixed with `#`. */
  onSuccessUpdateEmail?: Record<string, PatchObject<Email>> | null;
}

/** §2.1 */
export interface MdnSendResponse {
  accountId: Id;
  sent: Record<Id, Partial<Mdn>> | null;
  notSent: Record<Id, SetError> | null;
}

/** §2.2 */
export interface MdnParseArgs {
  accountId: Id;
  blobIds: readonly Id[];
}

/** §2.2 */
export interface MdnParseResponse {
  accountId: Id;
  parsed: Record<Id, Mdn> | null;
  notParsable: Id[] | null;
  notFound: Id[] | null;
}
