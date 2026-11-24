/** The signal for work that several callers share. See {@link allAborted}. */
export type AllAborted = {
  /**
   * Aborts once every caller's signal has aborted. Undefined when the work
   * can never be cancelled: a caller has no signal, or there is no caller.
   */
  readonly signal: AbortSignal | undefined;
  /**
   * Stops listening to the callers' signals. Call it when the work is done.
   * Otherwise a signal that outlives the work keeps a listener.
   */
  readonly stop: () => void;
};

const stopNothing = (): void => {};

/** The answer for work that can never be cancelled. */
const NEVER: AllAborted = { signal: undefined, stop: stopNothing };

/**
 * Listens to several signals, and aborts its own signal when the last of
 * them aborts. One object is the listener of every signal, so a signal costs
 * no function.
 */
class LastAbort {
  readonly #controller = new AbortController();
  readonly #signals: Set<AbortSignal>;
  /** The number of signals that have not aborted yet. */
  #pendingCount = 0;

  /** @param signals At least one of them must not have aborted yet. */
  constructor(signals: Set<AbortSignal>) {
    this.#signals = signals;
    for (const signal of signals) {
      if (signal.aborted) continue;
      this.#pendingCount += 1;
      signal.addEventListener("abort", this, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** A signal calls this function when it aborts. */
  handleEvent(event: Event): void {
    this.#pendingCount -= 1;
    if (this.#pendingCount > 0) return;
    // SAFETY: this object only listens to AbortSignals.
    this.#controller.abort((event.target as AbortSignal).reason);
  }

  /** An arrow function, so that a caller can pass it on without `this`. */
  readonly stop = (): void => {
    for (const signal of this.#signals) {
      signal.removeEventListener("abort", this);
    }
  };
}

/**
 * Makes the signal for one piece of work that several callers share, from
 * the signal of each caller. The work must stop only when no caller wants
 * its result any more, so the returned signal aborts when every caller's
 * signal has aborted. Its reason is the reason of the signal that aborted
 * last. `AbortSignal.any` is the opposite: it aborts on the first abort.
 *
 * The usual cases cost nothing: they add no listener, and make no signal.
 *
 * - No caller has a signal, or only some callers have one: the result has
 *   no signal, because the work can never be cancelled.
 * - Every caller has the same signal: the result is that signal.
 *
 * - Every caller's signal has aborted already: the result is a signal that
 *   has aborted.
 *
 * Other callers with different signals get a new signal that listens to
 * theirs. A signal that occurs more than once counts once. A signal that has
 * aborted already counts as aborted.
 *
 * @param signals The signal of each caller, or undefined for a caller that
 *   has none.
 */
export function allAborted(
  signals: readonly (AbortSignal | undefined)[],
): AllAborted {
  const [first] = signals;
  if (first === undefined) return NEVER;

  // One pass finds every case that needs no listener.
  let allSame = true;
  let allHaveAborted = true;
  for (const signal of signals) {
    if (signal === undefined) return NEVER;
    if (signal !== first) allSame = false;
    if (!signal.aborted) allHaveAborted = false;
  }
  if (allSame) return { signal: first, stop: stopNothing };
  if (allHaveAborted) {
    // The time of each abort is unknown, so the reason is the reason of the
    // last signal in the list.
    return {
      signal: AbortSignal.abort(signals.at(-1)?.reason),
      stop: stopNothing,
    };
  }

  // SAFETY: the loop above returned for any undefined element.
  return new LastAbort(new Set(signals as readonly AbortSignal[]));
}
