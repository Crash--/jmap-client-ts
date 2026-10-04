/**
 * Generic argument and response shapes of the RFC 8620 standard methods
 * (§5.1 to §5.6). Extension methods are declared with these helpers.
 */
import type {
  AddedItem,
  Comparator,
  Filter,
  Id,
  ResultReference,
  SetError,
  UnsignedInt,
} from './core.js';

/** String property names of an object type. */
export type PropertyOf<T> = Extract<keyof T, string>;

/** RFC 8620 §5.1: `Foo/get` arguments. */
export interface GetArgs<T, Property extends string = PropertyOf<T>> {
  accountId: Id;
  ids?: readonly Id[] | null;
  properties?: readonly Property[] | null;
}

/** RFC 8620 §5.1: `Foo/get` response. */
export interface GetResponse<T> {
  accountId: Id;
  state: string;
  list: T[];
  notFound: Id[];
}

/** RFC 8620 §5.2: `Foo/changes` arguments. */
export interface ChangesArgs {
  accountId: Id;
  sinceState: string;
  maxChanges?: UnsignedInt | null;
}

/** RFC 8620 §5.2: `Foo/changes` response. */
export interface ChangesResponse {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
}

/**
 * RFC 8620 §5.3: a PatchObject. Top-level properties are typed; JSON
 * pointer paths (`keywords/$seen`, `mailboxIds/abc`) accept any value,
 * `null` resets to the default. Index signatures of `T` (header forms) are
 * left out so that computed path keys stay assignable.
 */
export type PatchObject<T> = {
  [K in keyof T as K extends `${string}:${string}` ? never : string extends K ? never : K]?:
    T[K] | null;
} & Record<`${string}/${string}`, unknown>;

/** What the server returns for a created object: the id plus server-set properties. */
export type Created<T> = { id: Id } & Partial<T>;

/** RFC 8620 §5.3: `Foo/set` arguments. `Create` defaults to a partial object. */
export interface SetArgs<T, Create = Partial<T>> {
  accountId: Id;
  ifInState?: string | null;
  create?: Record<Id, Create> | null;
  update?: Record<Id, PatchObject<T>> | null;
  destroy?: readonly Id[] | null;
}

/** RFC 8620 §5.3: `Foo/set` response. */
export interface SetResponse<T> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Created<T>> | null;
  updated: Record<Id, Partial<T> | null> | null;
  destroyed: Id[] | null;
  notCreated: Record<Id, SetError> | null;
  notUpdated: Record<Id, SetError> | null;
  notDestroyed: Record<Id, SetError> | null;
}

/** RFC 8620 §5.4: `Foo/copy` arguments. */
export interface CopyArgs<Create> {
  fromAccountId: Id;
  ifFromInState?: string | null;
  accountId: Id;
  ifInState?: string | null;
  create: Record<Id, Create>;
  onSuccessDestroyOriginal?: boolean;
  destroyFromIfInState?: string | null;
}

/** RFC 8620 §5.4: `Foo/copy` response. */
export interface CopyResponse<T> {
  fromAccountId: Id;
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Created<T>> | null;
  notCreated: Record<Id, SetError> | null;
}

/** RFC 8620 §5.5: `Foo/query` arguments. */
export interface QueryArgs<FilterCondition, Sort extends Comparator = Comparator> {
  accountId: Id;
  filter?: Filter<FilterCondition> | null;
  sort?: readonly Sort[] | null;
  position?: number;
  anchor?: Id | null;
  anchorOffset?: number;
  limit?: UnsignedInt | null;
  calculateTotal?: boolean;
}

/** RFC 8620 §5.5: `Foo/query` response. */
export interface QueryResponse {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: UnsignedInt;
  ids: Id[];
  total?: UnsignedInt;
  limit?: UnsignedInt;
}

/** RFC 8620 §5.6: `Foo/queryChanges` arguments. */
export interface QueryChangesArgs<FilterCondition, Sort extends Comparator = Comparator> {
  accountId: Id;
  filter?: Filter<FilterCondition> | null;
  sort?: readonly Sort[] | null;
  sinceQueryState: string;
  maxChanges?: UnsignedInt | null;
  upToId?: Id | null;
  calculateTotal?: boolean;
}

/** RFC 8620 §5.6: `Foo/queryChanges` response. */
export interface QueryChangesResponse {
  accountId: Id;
  oldQueryState: string;
  newQueryState: string;
  total?: UnsignedInt;
  removed: Id[];
  added: AddedItem[];
}

/** Arguments of a method where any argument may be replaced by a `#name` back-reference. */
export type WithResultReferences<Args> = { [K in keyof Args]?: Args[K] } & {
  [K in keyof Args & string as `#${K}`]?: ResultReference<NonNullable<Args[K]>>;
};
