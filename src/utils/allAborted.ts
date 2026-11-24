import type { NonEmptyArray } from "type-party";

/** The signal for work that several callers share. See {@link allAborted}. */
export type AllAborted = {
  /** Aborts once every one of the signals has aborted. */
  readonly signal: AbortSignal;
  /**
   * Stops listening to the callers' signals. Call it when the work is done.
   * Otherwise a signal that outlives the work keeps a listener.
   */
  readonly stop: () => void;
};

const stopNothing = (): void => {};

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
 * Makes a signal that aborts when every one of `signals` has aborted. Its
 * reason is the reason of the signal that aborted last. `AbortSignal.any` is
 * the opposite: it aborts on the first abort.
 *
 * It is for one piece of work that several callers share, where each signal
 * is one caller's. Such work must stop only when no caller wants its result
 * any more. A caller without a signal can never cancel, so the code that
 * shares the work must not ask for a signal at all when it has such a
 * caller: this function knows only the signals that it gets.
 *
 * The usual cases cost nothing: they add no listener, and make no signal.
 *
 * - Every element is the same signal: the result is that signal.
 * - Every signal has aborted already: the result is a signal that has
 *   aborted.
 *
 * Other lists get a new signal that listens to theirs. A signal that occurs
 * more than once counts once. A signal that has aborted already counts as
 * aborted.
 *
 * @param signals At least one signal. For an empty list, "every signal has
 *   aborted" would be true at once, although nothing asked for a cancel. So
 *   the types do not allow it, and the caller decides what no signal means.
 */
export function allAborted(
  signals: Readonly<NonEmptyArray<AbortSignal>>,
): AllAborted {
  const [first] = signals;

  // One pass finds every case that needs no listener.
  let allSame = true;
  let allHaveAborted = true;
  for (const signal of signals) {
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

  return new LastAbort(new Set(signals));
}
