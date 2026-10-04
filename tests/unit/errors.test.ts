import { describe, expect, it } from 'vitest';

import { assertSetSucceeded, JmapError, JmapSetError } from '../../src/index.js';
import type { Mailbox, SetResponse } from '../../src/index.js';

function makeSetResponse(overrides: Partial<SetResponse<Mailbox>> = {}): SetResponse<Mailbox> {
  return {
    accountId: 'a1',
    oldState: 's1',
    newState: 's2',
    created: null,
    updated: null,
    destroyed: null,
    notCreated: null,
    notUpdated: null,
    notDestroyed: null,
    ...overrides,
  };
}

describe('assertSetSucceeded', () => {
  it('returns the response when nothing failed', () => {
    const response = makeSetResponse({ created: { k: { id: 'm1' } }, notCreated: {} });

    expect(assertSetSucceeded(response)).toBe(response);
  });

  it('throws JmapSetError listing every failure', () => {
    const response = makeSetResponse({
      notCreated: { k1: { type: 'invalidProperties', properties: ['name'] } },
      notDestroyed: { m9: { type: 'notFound' } },
    });

    let error: unknown = null;
    try {
      assertSetSucceeded(response);
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(JmapSetError);
    expect(error).toBeInstanceOf(JmapError);
    expect(error).toMatchObject({
      notCreated: { k1: { type: 'invalidProperties' } },
      notUpdated: {},
      notDestroyed: { m9: { type: 'notFound' } },
      message: 'create k1: invalidProperties, destroy m9: notFound',
    });
  });
});
