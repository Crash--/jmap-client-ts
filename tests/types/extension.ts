/**
 * Declares a fictitious `Note/get` method through declaration merging, the
 * way an app or a companion package would. Every type test in this folder
 * shares this augmentation.
 */
import type { GetArgs, GetResponse, Id } from '../../src/index.js';

export interface Note {
  id: Id;
  displayName: string;
  keyword: string;
  color: string | null;
}

declare module '../../src/index.js' {
  interface JmapMethods {
    'Note/get': {
      capability: 'urn:example:params:jmap:notes';
      args: GetArgs<Note>;
      response: GetResponse<Note>;
    };
  }
}
