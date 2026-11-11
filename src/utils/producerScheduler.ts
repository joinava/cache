import { AsyncLocalStorage } from "node:async_hooks";
import { asError, CacheContractError } from "./utils.js";

/**
 * A live handle on one actual (collapsed) producer invocation, passed to the
 * task function so it can attribute its telemetry to the invocation.
 * @internal
 */
export type CollapsedInvocation = {
  /**
   * Why the invocation was initiated (the label its CREATOR attached). Later
   * callers riding the invocation never re-label it.
   */
  readonly trigger: "miss" | "revalidation" | "bypass";
  /**
   * The number of logical callers attached to this invocation so far
   * (the initiator plus any riders that joined via request collapsing).
   * Live: read it at publish time.
   */
  readonly attachedCallerCount: () => number;
};

/** A shared request remains joinable only while its production is pending. */
export type PendingProduction<Request> = {
  readonly request: Request;
  readonly trigger: CollapsedInvocation["trigger"];
  readonly attachedCallerCount: () => number;
  readonly attachedCallers: () => ReadonlySet<object>;
  readonly queueWaitMs: number;
  /**
   * True when the scheduler dispatched this request from its automatic queue.
   * Reported as the produce message's `autoBatched`.
   */
  readonly autoBatched: boolean;
};

/**
 * Schedules independent producer requests and shares compatible pending work.
 * Cancellation removes queued participation. Dispatched work always completes.
 *
 * The producer wrappers' internal variant of `collapsedTaskCreator`. It
 * keeps the same collapse semantics: same key + pending + within
 * `collapseTasksMs` of the task's start ⇒ reuse. It adds support for
 * producer-invocation telemetry:
 *
 * - Each request is labeled with the trigger that motivated it. The label of
 *   the request that actually CREATES a task is fixed as that task's trigger.
 *   Riders never re-label it.
 * - The dispatch function receives a {@link PendingProduction} per task, so it
 *   can publish invocation-scoped diagnostics (trigger, attached-caller count).
 * - Each attachment says whether it `rode` an already-pending task (true) or
 *   initiated one (false). Settlements that DEPEND on the invocation
 *   (served-from-producer / producer-error / served-stale-after-error /
 *   aborted-while-waiting) report this as the fetch channel's `collapsed`
 *   flag. Cache-served settlements (fresh or stale-while-revalidating) report
 *   `collapsed: false` even when they attached a background revalidation as a
 *   rider, since their settlement never depended on it (see
 *   CacheFetchMessage.collapsed).
 *
 * Not exported from the package: the public `collapsedTaskCreator` remains
 * the general-purpose utility.
 *
 * @param options.bulk True when the producer takes many requests per call
 *   (`produceMany`). Then `dispatch` receives every request of a batch at once,
 *   and requests attached with `automatic: true` accumulate in a queue. False
 *   for a single-request producer (`produce`): each `dispatch` call receives
 *   exactly one request, and nothing accumulates.
 * @param options.maxBatchSize The most requests one automatic dispatch takes.
 *   Defaults to 20. A direct (non-automatic) dispatch is never split. Ignored
 *   when `bulk` is false.
 * @param options.batchScheduleFn Schedules the automatic queue's flush. It
 *   receives the flush callback. Defaults to the next tick after the current
 *   microtasks, so requests from one event-loop turn share a batch.
 * @param options.collapseTasksMs As in `collapsedTaskCreator`: a new
 *   request joins a pending task with the same key only if that task started
 *   less than this many milliseconds ago.
 * @param options.makeKey As in `collapsedTaskCreator`: converts a request
 *   into the key that decides which pending task it may join. Return
 *   `undefined` for a request that must not share work with any other; the
 *   scheduler then gives it a key that matches nothing.
 * @param options.retain Called when a task is created. It returns a release
 *   function that the scheduler calls once the task settles. The wrappers use
 *   it to keep a request's inputs alive while its production is pending.
 * @param options.dispatch Runs one producer invocation for the given tasks. It
 *   resolves with one result or Error per task, in order. A rejection fails
 *   every task in the invocation.
 * @internal
 */
export function createProducerScheduler<Request, Result>(options: {
  bulk: boolean;
  maxBatchSize?: number;
  batchScheduleFn?: (dispatch: () => void) => void;
  collapseTasksMs: number;
  makeKey: (request: Request) => string | undefined;
  retain?: (request: Request) => () => void;
  dispatch: (
    requests: readonly PendingProduction<Request>[],
  ) => Promise<readonly (Result | Error)[]>;
}) {
  type Task = {
    request: Request;
    key: string | symbol;
    trigger: CollapsedInvocation["trigger"];
    createdAt: number;
    enqueuedAt: number;
    /** The task waited in the automatic queue, so it reports queue wait. */
    accumulated: boolean;
    /** Distinct callers, reported as the collapsed caller count. */
    callers: Set<object>;
    /**
     * Live foreground attachments. When this reaches 0, a task that is still
     * queued and has no background request is cancelled.
     */
    participants: number;
    background: boolean;
    state: "queued" | "running" | "settled";
    result: ReturnType<typeof Promise.withResolvers<Result>>;
    release: (() => void) | undefined;
  };

  /** Tasks a new request can join, by key, until they settle. */
  const pending = new Map<string | symbol, Task>();
  /** Tasks not yet dispatched. */
  const queued = new Set<Task>();
  const running = new Set<Promise<unknown>>();

  const maxBatchSize = options.maxBatchSize ?? 20;
  if (
    maxBatchSize !== Infinity &&
    (!Number.isInteger(maxBatchSize) || maxBatchSize < 1)
  ) {
    throw new TypeError(
      "producerBatching.maxBatchSize must be a positive integer",
    );
  }

  let scheduled = false;
  let draining = false;

  const forget = (task: Task) => {
    task.release?.();
    task.release = undefined;
    task.state = "settled";
    queued.delete(task);
    // Only remove this task from `pending` if `pending` still holds this
    // task for its key. It could hold a new one if this task was replaced for
    // taking longer than collapseTasksMs.
    if (pending.get(task.key) === task) pending.delete(task.key);
  };

  const dispatch = (selected: readonly Task[], automatic: boolean) => {
    const tasks = selected.filter((task) => task.state === "queued");

    // Single producers take one request per call. Automatic accumulation
    // splits at maxBatchSize. A direct call is never split.
    const batchSize = !options.bulk ? 1 : automatic ? maxBatchSize : Infinity;
    for (let offset = 0; offset < tasks.length; offset += batchSize) {
      // Producer code can synchronously cancel or flush later queued tasks.
      const batch = tasks
        .slice(offset, offset + batchSize)
        .filter((task) => task.state === "queued");
      if (batch.length === 0) continue;

      const now = performance.now();
      batch.forEach((task) => {
        task.state = "running";
        queued.delete(task);
      });

      const operation = Promise.try(() =>
        options.dispatch(
          batch.map((task) => ({
            request: task.request,
            trigger: task.trigger,
            attachedCallerCount: () => task.callers.size,
            attachedCallers: () => task.callers,
            queueWaitMs: task.accumulated ? now - task.enqueuedAt : 0,
            autoBatched: automatic,
          })),
        ),
      )
        .then((results) => {
          if (results.length !== batch.length) {
            throw new CacheContractError(
              "Producer result count must match request count",
            );
          }

          batch.forEach((task, index) => {
            forget(task);
            const result = results[index]!;
            if (result instanceof Error) task.result.reject(result);
            else task.result.resolve(result);
          });
        })
        .catch((error: unknown) => {
          const failure = asError(error);
          batch.forEach((task) => {
            forget(task);
            task.result.reject(failure);
          });
        });

      running.add(operation);
      void operation.finally(() => running.delete(operation));
    }
  };

  const schedule = () => {
    if (scheduled || queued.size === 0) return;

    scheduled = true;
    const callback = AsyncLocalStorage.bind(() => {
      scheduled = false;
      dispatch([...queued], true);
    });
    if (options.batchScheduleFn) options.batchScheduleFn(callback);
    else void Promise.resolve().then(() => process.nextTick(callback));
  };

  return {
    /**
     * Attaches requests to pending or new tasks. For a bulk producer with
     * `automatic: false`, one call dispatches all of its queued tasks,
     * including shared tasks it joined, as one producer invocation. A direct
     * caller must pass all of its requests in one call to get one invocation.
     */
    attach(
      requests: readonly {
        request: Request;
        trigger: CollapsedInvocation["trigger"];
        background?: boolean;
        signal?: AbortSignal;
        caller: object;
      }[],
      automatic: boolean,
    ) {
      const attached = requests.map(
        ({ request, trigger, background = false, signal, caller }) => {
          signal?.throwIfAborted();
          const key = options.makeKey(request) ?? Symbol();
          signal?.throwIfAborted();

          const existing = pending.get(key);
          const now = Date.now();
          const rode =
            existing !== undefined &&
            now - existing.createdAt <= options.collapseTasksMs;
          const task: Task = rode
            ? existing
            : {
                request,
                key,
                trigger,
                createdAt: now,
                enqueuedAt: performance.now(),
                accumulated: options.bulk && automatic,
                callers: new Set<object>(),
                participants: 0,
                background: false,
                state: "queued",
                result: Promise.withResolvers<Result>(),
                release: options.retain?.(request),
              };

          if (!rode) {
            // This replaces an existing pending task for this key if the
            // other task was too old.
            pending.set(key, task);
            queued.add(task);
            // Cancellation can remove the last participant before anyone awaits.
            void task.result.promise.catch(() => {});
          }

          task.callers.add(caller);
          task.participants += 1;
          task.background ||= background;

          const abort = () => {
            task.participants -= 1;
            if (
              task.state === "queued" &&
              task.participants === 0 &&
              !task.background
            ) {
              forget(task);
              task.result.reject(signal?.reason);
            }
          };

          if (!background && signal) {
            signal.addEventListener("abort", abort, { once: true });
            void task.result.promise
              .finally(() => signal.removeEventListener("abort", abort))
              .catch(() => {});
          }

          return { task, promise: task.result.promise, rode };
        },
      );

      if (!options.bulk || !automatic || draining) {
        // A direct caller also removes shared queued work from accumulation.
        dispatch([...new Set(attached.map(({ task }) => task))], false);
      } else schedule();

      return attached.map(({ promise, rode }) => ({ promise, rode }));
    },
    flush() {
      draining = true;
      dispatch([...queued], true);
    },
    async drain() {
      while (running.size > 0 || queued.size > 0) {
        dispatch([...queued], true);
        await Promise.allSettled(running);
      }
    },
  };
}
