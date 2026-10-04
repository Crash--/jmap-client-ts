/**
 * JMAP for Quotas (RFC 9425).
 */
import type { Comparator, Id, UnsignedInt } from './core.js';

/** §4.1 */
export type QuotaResourceType = 'count' | 'octets' | (string & {});

/** §4.1 */
export type QuotaScope = 'account' | 'domain' | 'global' | (string & {});

/** §4 */
export interface Quota {
  id: Id;
  resourceType: QuotaResourceType;
  used: UnsignedInt;
  hardLimit: UnsignedInt;
  scope: QuotaScope;
  name: string;
  /** Data types (`Mail`, `Calendar`, …) the quota applies to. */
  types: string[];
  warnLimit?: UnsignedInt | null;
  softLimit?: UnsignedInt | null;
  description?: string | null;
}

/** §4.3 */
export interface QuotaFilterCondition {
  name?: string;
  scope?: QuotaScope;
  resourceType?: QuotaResourceType;
  type?: string;
}

/** §4.3 */
export type QuotaComparator = Comparator<'name' | 'used' | (string & {})>;
