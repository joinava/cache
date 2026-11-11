import { AsyncLocalStorage } from "node:async_hooks";
import { asError, CacheContractError } from "./utils.js";

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
   * Schedules the automatic queue's flush. It receives the flush callback.
   * Defaults to the next tick after the current microtasks, so requests from
   * one event-loop turn share a batch.
   */
  batchScheduleFn?: (dispatch: () => void) => void;
};

/** The scheduler that {@link createRequestScheduler} returns. */
export type RequestScheduler<Request, Result> = ReturnType<
  typeof createRequestScheduler<Request, Result>
>;

/** One task as the scheduler hands it to `dispatch`. */
export type DispatchedRequest<Request> = {
  /**
   * The request of the attachment that CREATED the task. Later attachments
   * that ride the task never replace it, so per-request labels such as a
   * producer trigger keep the creator's value.
   */
  readonly request: Request;
  /**
   * The number of attachments that rode this task so far. Each one is a
   * request that collapsing served without starting new work. The attachment
   * that created the task does not count. Live: read it at publish time, so
   * that riders that attach while the task runs count too.
   */
  readonly collapsedRequestCount: () => number;
  readonly queueWaitMs: number;
  /**
   * True when the scheduler dispatched this request from its automatic queue.
   * Reported as the diagnostics messages' `autoBatched`.
   */
  readonly autoBatched: boolean;
};

/**
 * Schedules independent requests into batched calls, and optionally shares
 * compatible pending work. Cancellation removes queued participation.
 * Dispatched work always completes.
 *
 * The producer wrappers use it for producer invocations, and `Cache` uses it
 * for Store reads. Store reads omit `makeKey`, so they never share work.
 *
 * With `makeKey`, it keeps the collapse semantics of `collapsedTaskCreator`:
 * same key + pending + within `collapseTasksMs` of the task's start ⇒ reuse.
 * It adds support for invocation telemetry:
 *
 * - The dispatch function receives a {@link DispatchedRequest} per task, so it
 *   can publish invocation-scoped diagnostics (collapsed request count, queue
 *   wait). The producer wrappers carry each request's trigger inside the
 *   request, so the creator's trigger labels the task.
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
 * @param options.bulk True when the target takes many requests per call
 *   (`produceMany`, `store.getMany`). Then `dispatch` receives every request
 *   of a batch at once, and requests attached with `automatic: true`
 *   accumulate in a queue. False for a single-request target (`produce`):
 *   each `dispatch` call receives exactly one request, and nothing
 *   accumulates.
 * @param options.maxBatchSize The most requests one automatic dispatch takes.
 *   Defaults to 20. A direct (non-automatic) dispatch is never split. Ignored
 *   when `bulk` is false.
 * @param options.batchScheduleFn Schedules the automatic queue's flush. It
 *   receives the flush callback. Defaults to the next tick after the current
 *   microtasks, so requests from one event-loop turn share a batch.
 * @param options.collapseTasksMs As in `collapsedTaskCreator`: a new
 *   request joins a pending task with the same key only if that task started
 *   less than this many milliseconds ago. Required with `makeKey`, and
 *   omitted without it.
 * @param options.makeKey As in `collapsedTaskCreator`: converts a request
 *   into the key that decides which pending task it may join. Return
 *   `undefined` for a request that must not share work with any other; the
 *   scheduler then gives it a key that matches nothing. Omit `makeKey` when no
 *   request may share work: then every request gets its own task.
 * @param options.retain Called when a task is created. It returns a release
 *   function that the scheduler calls once the task settles. The wrappers use
 *   it to keep a request's inputs alive while its production is pending.
 * @param options.dispatch Runs one call for the given tasks. It resolves with
 *   one result or Error per task, in order. A rejection fails every task in
 *   the call.
 * @internal
 */
export function createRequestScheduler<Request, Result>(
  options: BatchOptions & {
    bulk: boolean;
    retain?: (request: Request) => () => void;
    dispatch: (
      requests: readonly DispatchedRequest<Request>[],
    ) => Promise<readonly (Result | Error)[]>;
  } & (
      | {
          collapseTasksMs: number;
          makeKey: (request: Request) => string | undefined;
        }
      | { collapseTasksMs?: undefined; makeKey?: undefined }
    ),
) {
  type Task = {
    request: Request;
    key: string | symbol;
    createdAt: number;
    enqueuedAt: number;
    /** The task waited in the automatic queue, so it reports queue wait. */
    accumulated: boolean;
    /**
     * The async context (AsyncLocalStorage stores, the active tracing span) of
     * the attachment that created an accumulated task. A batch runs in its
     * first task's context, even when close() forces the flush from another
     * context. Undefined for a direct task, which dispatches synchronously in
     * its caller's context.
     */
    context: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    /** Attachments that rode this task, reported as `collapsedRequestCount`. */
    rides: number;
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
    throw new TypeError("maxBatchSize must be a positive integer");
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

    // Single-request targets take one request per call. Automatic accumulation
    // splits at maxBatchSize. A direct call is never split.
    const batchSize = !options.bulk ? 1 : automatic ? maxBatchSize : Infinity;
    for (let offset = 0; offset < tasks.length; offset += batchSize) {
      // Dispatch code can synchronously cancel or flush later queued tasks.
      const batch = tasks
        .slice(offset, offset + batchSize)
        .filter((task) => task.state === "queued");
      if (batch.length === 0) continue;

      const now = performance.now();
      batch.forEach((task) => {
        task.state = "running";
        queued.delete(task);
      });

      const run = () =>
        options.dispatch(
          batch.map((task) => ({
            request: task.request,
            collapsedRequestCount: () => task.rides,
            queueWaitMs: task.accumulated ? now - task.enqueuedAt : 0,
            autoBatched: automatic,
          })),
        );
      const context = batch[0]!.context;
      const operation = Promise.try(() =>
        context === undefined ? run() : context(run),
      )
        .then((results) => {
          if (results.length !== batch.length) {
            throw new CacheContractError(
              "Result count must match request count",
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
    // Each batch restores its own first task's context (see Task.context).
    const callback = () => {
      scheduled = false;
      dispatch([...queued], true);
    };
    if (options.batchScheduleFn) options.batchScheduleFn(callback);
    else void Promise.resolve().then(() => process.nextTick(callback));
  };

  return {
    /**
     * Attaches requests to pending or new tasks. For a bulk target with
     * `automatic: false`, one call dispatches all of its queued tasks,
     * including shared tasks it joined, as one dispatch call. A direct caller
     * must pass all of its requests in one call to get one dispatch call.
     */
    attach(
      requests: readonly {
        request: Request;
        background?: boolean;
        signal?: AbortSignal;
      }[],
      automatic: boolean,
    ) {
      const attached = requests.map(
        ({ request, background = false, signal }) => {
          signal?.throwIfAborted();
          const key = options.makeKey?.(request) ?? Symbol();
          signal?.throwIfAborted();

          const existing = pending.get(key);
          const now = Date.now();
          // Without makeKey every key is a fresh symbol, so `existing` is
          // always undefined. The makeKey check only narrows collapseTasksMs.
          const rode =
            existing !== undefined &&
            options.makeKey !== undefined &&
            now - existing.createdAt <= options.collapseTasksMs;
          const task: Task = rode
            ? existing
            : {
                request,
                key,
                createdAt: now,
                enqueuedAt: performance.now(),
                accumulated: options.bulk && automatic,
                context:
                  options.bulk && automatic
                    ? AsyncLocalStorage.snapshot()
                    : undefined,
                rides: 0,
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

          if (rode) task.rides += 1;
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
