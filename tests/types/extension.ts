/**
 * Declares a fictitious `Label/get` method through declaration merging, the
 * way an app or a companion package would. Every type test in this folder
 * shares this augmentation.
 */
import type { GetArgs, GetResponse, Id } from '../../src/index.js';

export interface Label {
  id: Id;
  displayName: string;
  keyword: string;
  color: string | null;
}

declare module '../../src/index.js' {
  interface JmapMethods {
    'Label/get': {
      capability: 'com:linagora:params:jmap:labels';
      args: GetArgs<Label>;
      response: GetResponse<Label>;
    };
  }
}
