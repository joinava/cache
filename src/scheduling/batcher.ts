import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "../types/index.js";
import {
  asError,
  assertResultCount,
  defaultLoggersByComponent,
} from "../utils/utils.js";
import { partition } from "es-toolkit";

/**
 * Accumulation settings for a bulk target. `Cache` exposes them as
 * `readBatching`, and the producer wrappers as `producerBatching`.
 */
export type BatchOptions = {
  /**
   * The most requests one automatic dispatch takes. Defaults to 20. A direct
   * (non-automatic) dispatch is never split.
   */
  maxBatchSize?: number;
  /**
   * Schedules the dispatch of each new automatic batch. It receives the
   * batch's dispatch callback. Defaults to the next tick after the current
   * microtasks, so requests from one event-loop turn share a batch.
   */
  batchScheduleFn?: (dispatch: () => void) => void;
  /**
   * Runs each automatic batch in the async context of the `enqueue` call
   * that opened it. Off by default, because the default schedule, and a
   * `batchScheduleFn` built on Node's timers or promises, already run the
   * batch in that context. Turn it on when `batchScheduleFn` runs its
   * callbacks from an unrelated context, or when a batch that `flush` or
   * `close` sends early must keep its first request's context instead of
   * the closer's. It costs one `AsyncResource` per batch.
   */
  preserveAsyncContext?: boolean;
};

/** One unit of work that a caller gives to {@link Batcher.enqueue}. */
export type BatchItem<Input> = {
  readonly input: Input;
  /**
   * Cancels the item while it is queued. When it aborts, the item leaves the
   * queue and its result rejects with the signal's reason. Omit it for work
   * that can never be cancelled.
   */
  readonly signal?: AbortSignal | undefined;
};

/** One item as the batcher's `dispatch` receives it. */
export type DispatchedItem<Input> = {
  readonly input: Input;
  /** Milliseconds from enqueue to dispatch. */
  readonly queueWaitMs: number;
};

/** Facts about one dispatch call, the same for every item in it. */
export type DispatchInfo = {
  /**
   * True when an automatic batch sent the items, false when `dispatchNow`
   * sent them.
   */
  readonly autoBatched: boolean;
};

/**
 * One automatic batch. Like a DataLoader batch, it gets its own scheduled
 * dispatch when it is created, and it takes entries until it holds
 * `maxBatchSize` queued entries or dispatches.
 */
type Batch<Input, Result> = {
  /**
   * Every entry that joined the batch, so the batch's dispatch can find the
   * ones still queued. Emptied once the batch dispatches, so that a
   * long-lived handle does not keep its settled siblings alive.
   */
  readonly entries: Entry<Input, Result>[];
  /**
   * The number of `entries` whose state is still `"queued"`. Until dispatch
   * empties `entries`, it equals
   * `entries.filter((e) => e.state === "queued").length`: an entry joins
   * `entries` only in `#makeEntryInBatch`, which counts it, and it leaves the
   * queued state only through `#setEntryState`, which uncounts it.
   *
   * It decides whether the open batch has room, so a cancelled entry, or one
   * that `dispatchNow` sent, frees its slot for a new entry. The count is
   * stored rather than computed because `enqueue` checks it once per entry.
   * Computing it would cost one pass over the batch per entry, which is
   * quadratic for a large batch, such as one with `maxBatchSize: Infinity`.
   */
  queuedCount: number;
  /**
   * Dispatches the batch. `batchScheduleFn` receives it, and `flush` and
   * `#drain` call it, so every path that dispatches the batch runs in the
   * same async context. With `preserveAsyncContext`, it is bound to the
   * context of the `enqueue` call that opened the batch.
   */
  readonly dispatch: () => void;
};

/**
 * One queued unit of work. `Batcher.enqueue` returns it as an opaque handle,
 * which a caller passes back to `Batcher.dispatchNow`.
 */
type Entry<Input, Result> = {
  readonly item: BatchItem<Input>;
  /**
   * The automatic batch that holds the entry. When the entry leaves the
   * queued state, by cancellation or by `dispatchNow`, `#setEntryState`
   * uses it to free the entry's slot in that batch.
   */
  readonly batch: Batch<Input, Result>;
  /** `performance.now()` at enqueue, for the dispatch's queue wait. */
  readonly enqueuedAt: number;
  /**
   * Makes each entry dispatch and settle at most once. An entry can be
   * reached by its batch's dispatch, by `dispatchNow`, and by its signal's
   * abort, in any order; each acts only on a `"queued"` entry.
   */
  state: "queued" | "running" | "settled";
  readonly result: PromiseWithResolvers<Result>;
  /**
   * Removes the listener attached to the abort of the item's signal, if the
   * item has a signal. Runs once, at settle.
   */
  cleanup: (() => void) | undefined;
};

/**
 * One unit of work that `#send` sends: a queued entry, or a new item of
 * `dispatchNow`. A new item never waits in a batch, so it has no entry, only
 * the result that `dispatchNow` returned for it.
 */
type Sendable<Input, Result> =
  | { readonly kind: "entry"; readonly entry: Entry<Input, Result> }
  | {
      readonly kind: "immediate";
      readonly input: Input;
      readonly result: PromiseWithResolvers<Result>;
    };

export type Outcome<Result> =
  | { ok: true; value: Result }
  | { ok: false; error: unknown };

/** Settles `result` with `outcome`. */
export function settleResult<Result>(
  result: PromiseWithResolvers<Result>,
  outcome: Outcome<Result>,
) {
  if (outcome.ok) {
    result.resolve(outcome.value);
  } else {
    // Cancellation can reject the result before anyone awaits it.
    void result.promise.catch(() => {});
    result.reject(outcome.error);
  }
}

/** The handle that {@link Batcher.enqueue} returns for one entry. */
export type BatchHandle<Input, Result> = Entry<Input, Result>;

/** What {@link Batcher.enqueue} returns for one item. */
export type Enqueued<Input, Result> = {
  readonly result: Promise<Result>;
  /**
   * The handle to pass to `dispatchNow`. Undefined only when `result` is
   * already rejected: the item's signal had aborted before `enqueue`, so
   * the item was never queued.
   */
  readonly handle: BatchHandle<Input, Result> | undefined;
};

/** The default `maxBatchSize`. The Cache passes its own default for Store reads. */
export const DEFAULT_PRODUCER_BATCH_SIZE = 20;

/**
 * Queues work and dispatches it in batches. `BulkProducerScheduler` composes it
 * with `TaskSharer`, which shares work. The batcher does not share work, and
 * it knows nothing of `TaskSharer`. To share work, a sharer's `schedule`
 * enqueues one item per started task, for example
 * `batcher.enqueue(toStart.map((view) => ({input: view, signal:
 * view.signal})))`. Then `dispatch` receives each live view, and can read
 * its `collapsedRequestCount` at dispatch time. `Cache` uses a batcher
 * directly for Store reads, which never share work, so each read gets its
 * own entry.
 *
 * Entries wait in automatic batches, which follow DataLoader's rules. A new
 * batch schedules its own dispatch with `batchScheduleFn` when it gets its
 * first entry. Once it holds `maxBatchSize` queued entries, the next entry
 * opens a new batch with its own scheduled dispatch. A full batch does not
 * dispatch early: it waits for its own callback. A caller that wants its
 * work run at once calls `dispatchNow` with its new items, and with the
 * handles of queued entries it also waits for, such as entries from other
 * callers' enqueues. That dispatch is never split, and its new items never
 * wait in a batch.
 *
 * Cancellation removes a queued entry: when its item's signal aborts, the
 * entry leaves the queue and its result rejects with the signal's reason.
 * Dispatched work always completes.
 *
 * Shutdown has two steps, because an owner can still accept work after its
 * shutdown starts:
 *
 * 1. `flush` sends every pending batch at once, and drops `batchScheduleFn`,
 *    so later batches use the default schedule, which always fires. An owner
 *    calls it when its shutdown starts, because its `batchScheduleFn` may
 *    stop firing then.
 * 2. `close` flushes too, and resolves once the batcher is idle. Then the
 *    batcher is closed. An owner calls it after it stops accepting work. An
 *    enqueue after that is a bug in the owner, so it logs a warning, but the
 *    work still runs.
 *
 * Every entry's result settles, including on cancellation. So a caller that
 * must hold a resource for an item's whole life, such as a lease on the
 * item's inputs, acquires it before `enqueue` and releases it in a
 * `.finally` on the item's result. The batcher has no hook for this.
 *
 * @internal
 */
export class Batcher<Input, Result> {
  readonly #maxBatchSize: number;
  readonly #preserveAsyncContext: boolean;
  /** Set to undefined by {@link flush}. */
  #batchScheduleFn: BatchOptions["batchScheduleFn"];
  readonly #logger: Logger;
  readonly #dispatch: (
    items: readonly DispatchedItem<Input>[],
    info: DispatchInfo,
  ) => Promise<readonly (Result | Error)[]>;

  /**
   * The batch that new entries join while it has room. Undefined before the
   * first enqueue, and after the open batch dispatches.
   */
  #openBatch: Batch<Input, Result> | undefined;
  /**
   * Batches whose dispatch is scheduled and has not run, so `flush` and
   * `#drain` can dispatch them early.
   */
  readonly #pendingBatches = new Set<Batch<Input, Result>>();
  /** Dispatches that have not settled, so `#drain` can wait for them. */
  readonly #running = new Set<Promise<unknown>>();
  /**
   * `"closing"` from the call to `close` until the batcher is idle. Then
   * `"closed"`, and `enqueue` warns.
   */
  #status: "open" | "closing" | "closed" = "open";
  /** The promise that `close` returns, so repeated calls share it. */
  #closed: Promise<void> | undefined;

  constructor(
    options: BatchOptions & {
      /**
       * Runs one call for the given items. It resolves with one result or
       * Error per item, in order. A rejection fails every item in the call.
       */
      dispatch: (
        items: readonly DispatchedItem<Input>[],
        info: DispatchInfo,
      ) => Promise<readonly (Result | Error)[]>;
      /** Receives the warning for an enqueue after close. */
      logger?: Logger;
    },
  ) {
    const maxBatchSize = options.maxBatchSize ?? DEFAULT_PRODUCER_BATCH_SIZE;
    if (
      maxBatchSize !== Infinity &&
      (!Number.isInteger(maxBatchSize) || maxBatchSize < 1)
    ) {
      throw new TypeError("maxBatchSize must be a positive integer");
    }

    this.#maxBatchSize = maxBatchSize;
    this.#preserveAsyncContext = options.preserveAsyncContext ?? false;
    this.#batchScheduleFn = options.batchScheduleFn;
    this.#logger = options.logger ?? defaultLoggersByComponent.batcher;
    this.#dispatch = options.dispatch;
  }

  /**
   * Queues one entry per item, in order, and returns each item's result and
   * handle.
   *
   * Each entry joins the open automatic batch, or opens a new one when that
   * batch is full. An item whose signal already aborted is not queued: its
   * result is rejected with the signal's reason, and it has no handle. The
   * other items are not affected. After the batcher has closed, it also logs
   * a warning.
   */
  enqueue(items: readonly BatchItem<Input>[]): Enqueued<Input, Result>[] {
    if (this.#status === "closed") {
      this.#logger("batcher", "warn", "enqueue called after close", {
        itemCount: items.length,
      });
    }

    // Batches that this call opens. Their dispatches are scheduled only once
    // every entry is in place: a `batchScheduleFn` that runs its callback
    // synchronously would otherwise dispatch a batch before its entries
    // joined, and strand them in a dispatched batch.
    const opened: Batch<Input, Result>[] = [];
    // One call runs at one time, so its entries share it.
    const enqueuedAt = performance.now();
    const enqueued = items.map((item): Enqueued<Input, Result> => {
      // Like a queued entry that is cancelled, an item that is already
      // cancelled is rejected, not sent.
      if (item.signal?.aborted) {
        const result = Promise.withResolvers<Result>();
        settleResult(result, { ok: false, error: item.signal.reason });
        return { result: result.promise, handle: undefined };
      }

      const { isNew: batchIsNew, batch } = this.#joinableBatch();
      if (batchIsNew) {
        opened.push(batch);
      }
      const entry = this.#makeEntryInBatch(item, batch, enqueuedAt);
      return { result: entry.result.promise, handle: entry };
    });

    opened.forEach((batch) => this.#scheduleDispatch(batch));
    return enqueued;
  }

  #makeEntryInBatch(
    item: BatchItem<Input>,
    batch: Batch<Input, Result>,
    enqueuedAt: number,
  ): Entry<Input, Result> {
    const entry: Entry<Input, Result> = {
      item,
      batch,
      enqueuedAt,
      state: "queued",
      result: Promise.withResolvers<Result>(),
      cleanup: (() => {
        const { signal } = item;
        if (!signal) return undefined;

        const onAbort = () => {
          if (entry.state !== "queued") return;
          this.#settle(entry, { ok: false, error: signal.reason });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        return () => signal.removeEventListener("abort", onAbort);
      })(),
    };

    // Each entry joins its batch here, so that `batch.entries` and
    // `batch.queuedCount` agree from the moment `entry.batch` is set. A
    // separate placement pass would leave a window in which a queued entry has
    // no batch.
    batch.entries.push(entry);
    batch.queuedCount += 1;

    return entry;
  }

  /**
   * Dispatches the still-queued entries among `handles`, plus the new
   * `items`, as one call, which is never split. It skips entries that are
   * running or settled. A caller can pass handles from other callers'
   * enqueues, so one dispatch covers all of the work it waits for.
   *
   * The new items never wait in a batch, so a `batchScheduleFn` cannot send
   * them early. An item whose signal already aborted is rejected and not
   * sent. Returns each item's result, in order. After close, it logs a
   * warning when it gets items, as `enqueue` does.
   *
   * It drops repeated handles, because one call can hold the same handle
   * more than once: two requests of a call that share one task get the same
   * handle, and the entry must be sent once.
   */
  dispatchNow(
    handles: Iterable<BatchHandle<Input, Result>>,
    items: readonly BatchItem<Input>[] = [],
  ): Promise<Result>[] {
    if (this.#status === "closed" && items.length > 0) {
      this.#logger("batcher", "warn", "dispatchNow called after close", {
        itemCount: items.length,
      });
    }

    const results = items.map((it) => ({
      result: Promise.withResolvers<Result>(),
      signal: it.signal,
      input: it.input,
    }));

    const [immediateItems, abortedItems] = partition(
      results,
      ({ signal }) => !signal?.aborted,
    );

    abortedItems.forEach(({ signal, result }) => {
      settleResult(result, { ok: false, error: signal!.reason });
    });

    this.#send(
      [
        ...[...new Set(handles)].map((entry) => ({
          kind: "entry" as const,
          entry,
        })),
        ...immediateItems.map(({ input, result }) => ({
          kind: "immediate" as const,
          input,
          result,
        })),
      ],
      false,
    );
    return results.map((r) => r.result.promise);
  }

  /**
   * Dispatches every pending batch now, and drops `batchScheduleFn`, which
   * the owner may stop during shutdown. Later batches use the default
   * schedule. The batcher stays open: later enqueues do not warn.
   */
  flush(): void {
    this.#batchScheduleFn = undefined;
    this.#pendingBatches.forEach((batch) => batch.dispatch());
  }

  /**
   * Flushes, then resolves when the batcher is idle. Then the batcher is
   * closed, and later enqueues log a warning. Repeated calls return the same
   * promise.
   */
  close(): Promise<void> {
    if (this.#closed) return this.#closed;

    this.#status = "closing";
    this.flush();
    this.#closed = this.#drain().then(() => {
      this.#status = "closed";
    });
    return this.#closed;
  }

  /**
   * Waits until no batch is pending and no dispatch is running. It loops
   * because a dispatch can enqueue more work into this batcher before it
   * settles, for example a producer that requests other keys from its own
   * wrapper.
   */
  async #drain(): Promise<void> {
    while (this.#running.size > 0 || this.#pendingBatches.size > 0) {
      this.#pendingBatches.forEach((batch) => batch.dispatch());
      await Promise.allSettled(this.#running);
    }
  }

  /**
   * Returns the open batch when it has room, as DataLoader's
   * `getCurrentBatch` does. Otherwise it opens a new batch, and reports it as
   * new: the caller schedules a new batch's dispatch.
   */
  #joinableBatch() {
    const open = this.#openBatch;
    if (open && open.queuedCount < this.#maxBatchSize) {
      return { batch: open, isNew: false };
    }

    const dispatch = () => this.#dispatchBatch(batch);
    const batch: Batch<Input, Result> = {
      entries: [],
      queuedCount: 0,
      dispatch: this.#preserveAsyncContext
        ? AsyncLocalStorage.bind(dispatch)
        : dispatch,
    };
    this.#openBatch = batch;
    this.#pendingBatches.add(batch);
    return { batch, isNew: true };
  }

  /** Schedules a batch's dispatch with `batchScheduleFn`, or the default. */
  #scheduleDispatch(batch: Batch<Input, Result>) {
    const { dispatch } = batch;
    if (this.#batchScheduleFn) this.#batchScheduleFn(dispatch);
    else void Promise.resolve().then(() => process.nextTick(dispatch));
  }

  /**
   * The only code that changes `entry.state` after `enqueue` creates the
   * entry. Keep it that way: it keeps `Batch.queuedCount` correct. When the
   * entry leaves the queued state, it frees the entry's slot in its batch.
   * From any other state, it only sets the new state.
   */
  #setEntryState(entry: Entry<Input, Result>, state: "running" | "settled") {
    if (entry.state === "queued") entry.batch.queuedCount -= 1;
    entry.state = state;
  }

  /**
   * Marks an entry settled, runs its cleanup, and settles its result with
   * `outcome`. The outcome is explicit because an error can be any value,
   * such as an abort reason that is a string.
   */
  #settle(entry: Entry<Input, Result>, outcome: Outcome<Result>) {
    this.#setEntryState(entry, "settled");
    entry.cleanup?.();
    entry.cleanup = undefined;
    settleResult(entry.result, outcome);
  }

  /**
   * Sends a batch's still-queued entries, once. A batch leaves
   * `#pendingBatches` only here, so membership marks it undispatched.
   */
  #dispatchBatch(batch: Batch<Input, Result>) {
    if (!this.#pendingBatches.delete(batch)) return;
    if (this.#openBatch === batch) this.#openBatch = undefined;
    this.#send(
      batch.entries.map((entry) => ({ kind: "entry", entry })),
      true,
    );
    batch.entries.length = 0;
  }

  /**
   * Sends `selected` as one call, in the current async context. It skips
   * entries that are no longer queued, and sends every immediate item.
   * `autoBatched` says whether an automatic batch sends them.
   */
  #send(selected: readonly Sendable<Input, Result>[], autoBatched: boolean) {
    const toSend = selected.filter(
      (it) => it.kind === "immediate" || it.entry.state === "queued",
    );
    if (toSend.length === 0) return;

    toSend.forEach((it) => {
      if (it.kind === "entry") this.#setEntryState(it.entry, "running");
    });

    const settle = (it: Sendable<Input, Result>, outcome: Outcome<Result>) => {
      if (it.kind === "entry") this.#settle(it.entry, outcome);
      else settleResult(it.result, outcome);
    };

    const now = performance.now();
    const run = () =>
      this.#dispatch(
        toSend.map((it) =>
          it.kind === "entry"
            ? {
                input: it.entry.item.input,
                queueWaitMs: now - it.entry.enqueuedAt,
              }
            : { input: it.input, queueWaitMs: 0 },
        ),
        { autoBatched },
      );
    const operation = Promise.try(run)
      .then((results) => {
        assertResultCount(results, toSend.length);
        toSend.forEach((it, index) => {
          const result = results[index]!;
          settle(
            it,
            result instanceof Error
              ? { ok: false, error: result }
              : { ok: true, value: result },
          );
        });
      })
      .catch((error: unknown) => {
        const failure = asError(error);
        toSend.forEach((it) => {
          settle(it, { ok: false, error: failure });
        });
      });

    this.#running.add(operation);
    void operation.finally(() => this.#running.delete(operation));
  }
}
