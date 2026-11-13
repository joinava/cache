/**
 * Tracks promises until they settle, so that an owner's `close` can wait for
 * the work it accepted.
 *
 * Each tracked promise leaves the tracker when it settles. Tracking never
 * creates an unhandled rejection: the tracker observes a rejection, but the
 * caller still owns the promise and its rejection.
 *
 * The tracker has no closed state. Each owner decides what new work does
 * after its own `close` starts, and in what order it drains its trackers.
 */
export class PendingPromisesTracker {
  readonly #pending = new Set<Promise<unknown>>();

  /** The number of tracked promises that have not settled yet. */
  get size(): number {
    return this.#pending.size;
  }

  /** Tracks `promise` until it settles, and returns it unchanged. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    const untrack = () => {
      this.#pending.delete(promise);
    };
    void promise.then(untrack, untrack);
    return promise;
  }

  /**
   * Calls `start` and tracks its result. The promise is tracked before
   * `start` runs, so a `drain` that `start` itself triggers synchronously
   * still waits for it. A synchronous throw from `start` becomes a rejection.
   */
  run<T>(start: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    void this.track(promise);
    try {
      resolve(start());
    } catch (error) {
      reject(error);
    }
    return promise;
  }

  /**
   * Resolves once no tracked promise is pending, including promises tracked
   * while it waits. It loops because settling work can start more work, for
   * example a producer that reads other keys from its own wrapper. It never
   * rejects.
   */
  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled(this.#pending);
    }
  }
}
