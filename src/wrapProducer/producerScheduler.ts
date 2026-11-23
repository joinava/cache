/**
 * @fileoverview How a producer client shares and sends its producer work. It
 * composes three parts of `@zingage/scheduling`:
 *
 * - A dispatcher runs the producer calls. Its waiting set decides which work
 *   shares a call: `fifoBatches` accumulates work for a producer that takes
 *   batches (`produceMany`). Without a waiting set, each unit is its own
 *   call, ready at once, for a producer that takes one request (`produce`).
 * - An optional `concurrencyLimit` admission limits the producer calls that
 *   run at one time.
 * - A `Sharing` in front of the dispatcher lets requests with the same key
 *   share one unit of work. {@link createProducerScheduler} holds the one
 *   rule for that.
 *
 * @module
 */
import {
  concurrencyLimit,
  createDispatcher,
  fifoBatches,
  Sharing,
  type BatchOptions,
  type Item,
  type SharedOutcome,
} from "@zingage/scheduling";

/** One request for producer work. */
export type ProducerRequest<Work> = {
  readonly work: Work;
  /**
   * The public call that makes the request. It is compared by identity: a
   * request always joins work that its own call started.
   */
  readonly call: {
    /**
     * `false` keeps the call's requests from joining work whose producer
     * call has already started. They still join work that waits, in a batch
     * or for a slot, because that producer call starts after the request.
     */
    readonly joinInFlight?: false | undefined;
  };
};

/**
 * One unit of producer work. Its `input` is the request that STARTED it.
 * Requests that join it never replace that, so per-request labels such as a
 * producer trigger keep the starting request's value.
 */
export type ProducerItem<Work, Produced> = Item<
  ProducerRequest<Work>,
  Produced
>;

/**
 * Runs one producer call for the given items. It resolves with one result or
 * Error per item, in order. A rejection fails every item of the call.
 */
export type InvokeProducer<Work, Produced> = (
  items: readonly ProducerItem<Work, Produced>[],
  info: {
    /**
     * True when at least one item of the call came from automatic
     * accumulation. False when every item was expedited, and always false
     * for a producer that takes one request per call.
     */
    readonly autoBatched: boolean;
  },
) => Promise<readonly (Produced | Error)[]>;

export type ProducerSchedulerOptions<Work, Produced> = {
  /**
   * A request joins work whose producer call has started only if that call
   * started no more than this many milliseconds ago.
   */
  sharingWindowMs: number;
  /**
   * Converts a request's work into the key that decides which pending work
   * it may join. `undefined` means the request must not share work with any
   * other: it then starts its own.
   */
  keyOf: (work: Work) => string | undefined;
  /**
   * The most producer calls that run at one time. Undefined or `Infinity`
   * for no limit. Work that waits for a slot stays joinable, and leaves the
   * queue when every request on it is cancelled.
   */
  maxConcurrentCalls: number | undefined;
  /**
   * The accumulation settings of a producer that takes batches. Undefined
   * for a producer that takes one request per call: its work never
   * accumulates.
   */
  batching: BatchOptions | undefined;
  invoke: InvokeProducer<Work, Produced>;
};

/**
 * Shares pending producer work between independent requests, and sends it.
 * Work whose producer call has started always completes.
 */
export type ProducerScheduler<Work, Produced> = {
  /**
   * Joins pending work for the request's key, or starts some. `signal`
   * cancels the request. A request without a signal can never be cancelled,
   * so the work that it joins or starts can never be cancelled either.
   *
   * New work waits for its producer call as the scheduler's batching and
   * call limit say. The returned `item.expedite()` skips the accumulation
   * wait.
   */
  request(
    request: ProducerRequest<Work>,
    signal: AbortSignal | undefined,
  ): SharedOutcome<ProducerRequest<Work>, Produced>;
  /**
   * The number of requests that joined `item` without starting it, so far.
   * Each one is a request that sharing served without new work. A request
   * that was cancelled later still counts. Read it when the producer call
   * settles, so that requests that joined while it ran count too.
   */
  joinedCount(item: ProducerItem<Work, Produced>): number;
  /**
   * Makes all accumulated work ready for its producer call now. It also
   * drops `batching.batchScheduleFn` for good, because an owner can stop
   * that schedule during a shutdown: work that is requested later
   * accumulates on the default schedule.
   */
  flush(): void;
  /**
   * Flushes, then resolves when no work waits or runs. The client calls it
   * once, after it stops making requests: it does not wait for work that is
   * requested after it resolves.
   */
  close(): Promise<void>;
};

/** Builds a {@link ProducerScheduler}. */
export function createProducerScheduler<Work, Produced>({
  sharingWindowMs,
  keyOf,
  maxConcurrentCalls,
  batching,
  invoke,
}: ProducerSchedulerOptions<Work, Produced>): ProducerScheduler<
  Work,
  Produced
> {
  type Request = ProducerRequest<Work>;

  const accumulates = batching !== undefined;
  const dispatcher = createDispatcher({
    waiting: batching === undefined ? undefined : fifoBatches(batching),
    admission:
      maxConcurrentCalls === undefined || maxConcurrentCalls === Infinity
        ? undefined
        : concurrencyLimit(maxConcurrentCalls),
    invoke: (items: readonly Item<Request, Produced>[]) =>
      invoke(items, {
        autoBatched: accumulates && items.some((item) => !item.expedited),
      }),
  });

  const sharing = new Sharing<Request, Request, Produced>({
    keyOf: ({ work }) => keyOf(work),
    // The one rule for sharing. Requests with equal keys ask for the same
    // producer result, so the only question is whether the pending work is
    // recent enough for the new request.
    canJoin: (item, request, now) => {
      // Work that still waits, in a batch or for a slot, starts its producer
      // call after this request. So does every producer call for work that
      // the request's own call started.
      if (item.state === "waiting" || item.input.call === request.call) {
        return true;
      }
      if (request.call.joinInFlight === false) return "inFlight";
      // The window runs from the start of the producer call, not from the
      // request that started the work: time that work spends waiting does
      // not make the producer's answer older.
      return now - (item.startedAt ?? now) <= sharingWindowMs
        ? true
        : "outsideWindow";
    },
    start: (requests) => dispatcher.submitMany(requests),
  });

  return {
    request: (request, signal) => sharing.request(request, signal),
    joinedCount: (item) => sharing.joinedCount(item),
    flush: () => {
      dispatcher.flush();
    },
    // Repeated calls share the dispatcher's one close promise.
    close: () => dispatcher.close(),
  };
}
