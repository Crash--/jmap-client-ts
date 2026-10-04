import type { Id, MethodErrorArguments, ProblemDetails, SetError } from './types/core.js';

/** Base class of every error thrown by the client. */
export class JmapError extends Error {
  override name = 'JmapError';
}

/** Any non-2xx HTTP answer that is not a JMAP problem document. */
export class JmapHttpError extends JmapError {
  override name = 'JmapHttpError';
  readonly status: number;
  readonly statusText: string;
  readonly body: string;

  constructor(init: { status: number; statusText: string; body: string; url: string }) {
    super(`HTTP ${init.status} ${init.statusText} on ${init.url}`);
    this.status = init.status;
    this.statusText = init.statusText;
    this.body = init.body;
  }
}

/** Request-level error (RFC 8620 §3.6.1, RFC 7807 problem document). */
export class JmapRequestError extends JmapError {
  override name = 'JmapRequestError';
  readonly type: string;
  readonly status: number;
  readonly detail: string | null;
  readonly limit: string | null;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails, httpStatus: number) {
    super(`${problem.type}${problem.detail === undefined ? '' : `: ${problem.detail}`}`);
    this.type = problem.type;
    this.status = problem.status ?? httpStatus;
    this.detail = problem.detail ?? null;
    this.limit = problem.limit ?? null;
    this.problem = problem;
  }
}

/** A method call answered `["error", {type, description}, callId]` (RFC 8620 §3.6.2). */
export class JmapMethodError extends JmapError {
  override name = 'JmapMethodError';
  readonly type: string;
  readonly description: string | null;
  readonly methodName: string;
  readonly callId: string;
  /** Full error arguments, including type-specific members such as `properties`. */
  readonly details: MethodErrorArguments;

  constructor(init: { arguments: MethodErrorArguments; methodName: string; callId: string }) {
    const description = init.arguments.description ?? null;
    super(
      `${init.methodName} (${init.callId}) failed with ${init.arguments.type}` +
        (description === null ? '' : `: ${description}`),
    );
    this.type = init.arguments.type;
    this.description = description;
    this.methodName = init.methodName;
    this.callId = init.callId;
    this.details = init.arguments;
  }
}

/** Some creations, updates or destructions of a `/set` call failed. */
export class JmapSetError extends JmapError {
  override name = 'JmapSetError';
  readonly notCreated: Record<Id, SetError>;
  readonly notUpdated: Record<Id, SetError>;
  readonly notDestroyed: Record<Id, SetError>;

  constructor(init: {
    notCreated: Record<Id, SetError>;
    notUpdated: Record<Id, SetError>;
    notDestroyed: Record<Id, SetError>;
  }) {
    const describe = (label: string, failures: Record<Id, SetError>): string[] =>
      Object.entries(failures).map(([id, error]) => `${label} ${id}: ${error.type}`);
    super(
      [
        ...describe('create', init.notCreated),
        ...describe('update', init.notUpdated),
        ...describe('destroy', init.notDestroyed),
      ].join(', '),
    );
    this.notCreated = init.notCreated;
    this.notUpdated = init.notUpdated;
    this.notDestroyed = init.notDestroyed;
  }
}

/** The server answered something that is not valid JMAP. */
export class JmapInvalidResponseError extends JmapError {
  override name = 'JmapInvalidResponseError';
}

interface SetLikeResponse {
  notCreated?: Record<Id, SetError> | null;
  notUpdated?: Record<Id, SetError> | null;
  notDestroyed?: Record<Id, SetError> | null;
}

/**
 * Throws a {@link JmapSetError} if a `/set` (or `/copy`, `/import`) response
 * reports any failure, otherwise returns the response unchanged.
 */
export function assertSetSucceeded<Response extends SetLikeResponse>(response: Response): Response {
  const notCreated = response.notCreated ?? {};
  const notUpdated = response.notUpdated ?? {};
  const notDestroyed = response.notDestroyed ?? {};
  const failureCount =
    Object.keys(notCreated).length +
    Object.keys(notUpdated).length +
    Object.keys(notDestroyed).length;
  if (failureCount > 0) {
    throw new JmapSetError({ notCreated, notUpdated, notDestroyed });
  }
  return response;
}
