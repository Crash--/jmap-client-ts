import type {
  JmapMethodName,
  MethodArgs,
  MethodPropertyName,
  MissingArgs,
  NarrowedMethodResponse,
  ResultPath,
  ResultPathValue,
  WithPropertyList,
} from './methods.js';
import { isRecord } from './guards.js';
import type { ResultReference } from './types/core.js';
import type { WithResultReferences } from './types/generic.js';

/**
 * Arguments accepted by {@link RequestBuilder.call}: any argument may be
 * given as a `#name` back-reference instead.
 */
export type BuilderArgs<
  M extends JmapMethodName,
  Property extends string = never,
> = WithPropertyList<M, WithResultReferences<MethodArgs<M>>, Property>;

/**
 * Required arguments missing from the keys actually given, typed so that
 * the compiler reports them (each may be given directly or as `#name`).
 */
export type RequiredArgs<M extends JmapMethodName, GivenKey extends PropertyKey> = {
  [
    K in MissingArgs<MethodArgs<M>, Record<GivenKey, unknown>> & keyof MethodArgs<M>
  ]: MethodArgs<M>[K];
};

/** Result reference value type for a path of a response. */
export type RefValue<Response, Path extends string> =
  Path extends ResultPath<Response> ? ResultPathValue<Response, Path> : never;

/**
 * Handle on one call of a request. Await it (after the request was sent) to
 * get this call's response, or use {@link CallHandle.ref} to feed its result
 * to a later call of the same request.
 */
export interface CallHandle<M extends string, Response> extends PromiseLike<Response> {
  readonly method: M;
  readonly callId: string;
  /**
   * Back-reference to this call's result (RFC 8620 §3.7). Known paths are
   * suggested and typed; other paths are accepted unchecked.
   */
  ref<Path extends ResultPath<Response> | (string & {})>(
    path: Path,
  ): ResultReference<RefValue<Response, Path>>;
}

/** Any handle, whatever its method and response. */
export interface AnyCallHandle extends PromiseLike<unknown> {
  readonly method: string;
  readonly callId: string;
}

/** Collects the calls of one request. */
export interface RequestBuilder {
  call<
    M extends JmapMethodName,
    const Property extends MethodPropertyName<M> = never,
    GivenKey extends keyof BuilderArgs<M, Property> = never,
  >(
    method: M,
    args: BuilderArgs<M, Property> & Record<GivenKey, unknown> & RequiredArgs<M, GivenKey>,
  ): CallHandle<M, NarrowedMethodResponse<M, Property>>;
}

/** @internal what the client needs to settle a handle. */
export interface SettleableHandle {
  readonly method: string;
  readonly callId: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

type Settlement = { ok: true; value: unknown } | { ok: false; error: unknown };

/** @internal runtime handle; settled by the client once the response arrives. */
export class CallHandleImpl<M extends string, Response>
  implements CallHandle<M, Response>, SettleableHandle
{
  readonly method: M;
  readonly callId: string;
  readonly owner: RequestBuilderImpl;
  readonly #settled: Promise<Settlement>;
  #settle: (settlement: Settlement) => void = () => undefined;

  constructor(method: M, callId: string, owner: RequestBuilderImpl) {
    this.method = method;
    this.callId = callId;
    this.owner = owner;
    // Never rejects: a call nobody awaits must not cause an unhandled rejection.
    this.#settled = new Promise<Settlement>(resolve => {
      this.#settle = resolve;
    });
  }

  ref<Path extends ResultPath<Response> | (string & {})>(
    path: Path,
  ): ResultReference<RefValue<Response, Path>> {
    const reference: ResultReference<RefValue<Response, Path>> = {
      resultOf: this.callId,
      name: this.method,
      path,
    };
    REFERENCE_OWNERS.set(reference, this.owner);
    return reference;
  }

  /** Settles the handle with the raw (unvalidated) response arguments. */
  resolve(value: unknown): void {
    this.#settle({ ok: true, value });
  }

  reject(error: unknown): void {
    this.#settle({ ok: false, error });
  }

  then<Result1 = Response, Result2 = never>(
    onFulfilled?: ((value: Response) => Result1 | PromiseLike<Result1>) | null,
    onRejected?: ((reason: unknown) => Result2 | PromiseLike<Result2>) | null,
  ): Promise<Result1 | Result2> {
    return this.#settled
      .then(settlement => {
        if (settlement.ok) {
          // The server is trusted to answer with the declared response shape.
          return settlement.value as Response;
        }
        throw settlement.error;
      })
      .then(onFulfilled, onRejected);
  }
}

const REFERENCE_OWNERS = new WeakMap<object, RequestBuilderImpl>();

/** @internal invocation as sent; arguments are already in JMAP form. */
export type OutgoingInvocation = [name: string, arguments: object, id: string];

/** @internal */
export class RequestBuilderImpl implements RequestBuilder {
  readonly handles: SettleableHandle[] = [];
  readonly invocations: OutgoingInvocation[] = [];

  readonly call: RequestBuilder['call'] = (method, args) => {
    if (!isRecord(args)) {
      throw new TypeError(`${method}: arguments must be an object`);
    }
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith('#')) {
        continue;
      }
      if (key.slice(1) in args) {
        throw new TypeError(`${method}: both "${key.slice(1)}" and "${key}" are set`);
      }
      const owner = isRecord(value) ? REFERENCE_OWNERS.get(value) : undefined;
      if (owner !== undefined && owner !== this) {
        throw new TypeError(`${method}: "${key}" references a call of another request`);
      }
    }
    return this.register(method, args);
  };

  /** Adds an invocation and returns its handle. */
  register<M extends string, Response>(method: M, args: object): CallHandleImpl<M, Response> {
    const callId = `c${this.handles.length}`;
    const handle = new CallHandleImpl<M, Response>(method, callId, this);
    this.handles.push(handle);
    this.invocations.push([method, args, callId]);
    return handle;
  }
}
