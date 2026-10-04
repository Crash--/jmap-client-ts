/**
 * Calls every listener with `payload`. A throwing listener does not stop the
 * others nor the caller: its error is rethrown asynchronously so it still
 * shows up as an uncaught error.
 */
export function emitSafely<Payload>(
  listeners: Iterable<(payload: Payload) => void>,
  payload: Payload,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch (error: unknown) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
