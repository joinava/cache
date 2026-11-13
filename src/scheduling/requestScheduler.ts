import { pick } from "es-toolkit";
import type { Logger } from "../types/index.js";
import {
  Batcher,
  settleResult,
  type BatchHandle,
  type BatchItem,
  type BatchOptions,
  type DispatchInfo,
} from "./batcher.js";
import { TaskSharer, type SharedTaskView } from "./taskSharer.js";

export type { BatchOptions, DispatchInfo };

/** One task as the scheduler hands it to `dispatch`. */
export type DispatchedRequest<Request> = {
  /**
   * The request that STARTED the task. Requests that ride the task never
   * replace it, so per-request labels such as a producer trigger keep the
   * starting request's value.
   */
  readonly request: Request;
  /**
   * The number of requests that have ridden the task so far. Each one is a
   * request that sharing served without starting new work. The request that
   * started the task does not count, and a cancelled rider still does. Live:
   * read it at publish time, so that requests that ride the task while it runs
   * count too.
   */
  readonly collapsedRequestCount: () => number;
  /**
   * Milliseconds the task waited in the automatic queue. 0 for a task that
   * a direct call or a single-request target started.
   */
  readonly queueWaitMs: number;
};

/** A task that a direct `startOrRideTasks` call started, and has not sent yet. */
type DirectStart<Request, Result> = {
  item: BatchItem<SharedTaskView<Request>>;
  result: PromiseWithResolvers<Result>;
};

/** The options of a {@link RequestScheduler}. Its constructor documents each one. */
export type RequestSchedulerOptions<Request, Result> = {
  batching: BatchOptions | false;
  logger?: Logger | undefined;
  retain?: (request: Request) => () => void;
  dispatch: (
    requests: readonly DispatchedRequest<Request>[],
    info: DispatchInfo,
  ) => Promise<readonly (Result | Error)[]>;
  collapseTasksMs: number;
  makeKey: (request: Request) => string | undefined;
};

/**
 * Shares pending tasks between independent requests, and optionally batches
 * the tasks. A queued task whose requests are all cancelled leaves the queue.
 * Dispatched work always completes.
 *
 * The producer wrappers use it for producer invocations. These always share
 * work, and batch it only for a bulk producer.
 *
 * A request rides a pending task when the two have the same key, the task
 * is not cancelled, and the task started no more than `collapseTasksMs` ago.
 * Otherwise the request starts a new task. `startOrRideTasks` reports for each request
 * whether it `rode` a pending task (true) or started one (false).
 * The dispatch function receives a {@link DispatchedRequest} per task, so it
 * can publish invocation-scoped diagnostics (collapsed request count, queue
 * wait).
 *
 * It composes a `TaskSharer`, which shares work, with a `Batcher`, which
 * sends the work. A bulk target batches it. A single-request target sends
 * each started task at once, with its own `dispatchNow` call.
 *
 * @internal
 */
export class RequestScheduler<Request, Result> {
  readonly #batching: BatchOptions | false;
  /**
   * Sends the work. It dispatches each item's live view, so
   * `collapsedRequestCount` counts riders up to dispatch time.
   *
   * A single-request target (`batching: false`) has nothing to batch, but it
   * still sends through the batcher, one `dispatchNow` call per task. It
   * never enqueues, so it gets no batch settings. The batcher gives it, with
   * no second copy of the code:
   * - the dispatch-result handling: the result-count check, an `Error` slot
   *   that rejects only its own task, and a rejection that fails the call;
   * - the rejection of a task whose signal aborted before it was sent;
   * - `close` waiting for running dispatches, and the warning for work sent
   *   after `close`.
   */
  readonly #batcher: Batcher<SharedTaskView<Request>, Result>;
  readonly #sharer: TaskSharer<
    Request,
    Result,
    BatchHandle<SharedTaskView<Request>, Result> | undefined,
    string,
    DirectStart<Request, Result>[] | undefined
  >;
  /**
   * True once `flush` runs. From then on, `startOrRideTasks` dispatches at
   * once even for requests passed with `autoBatch: true`, so shutdown does not wait
   * for a later batch. A flushed batcher would otherwise batch them on the
   * default schedule. Inert for a single-request target, which always
   * dispatches at once.
   */
  #flushed = false;
  /**
   * The promise that `close` returns, so a second `close` cannot flush or
   * drain twice.
   */
  #closing: Promise<void> | undefined;

  /**
   * @param options.batching The batch settings of a target that takes many
   *   requests per call (`produceMany`). Then `dispatch` receives every request
   *   of a batch at once, and requests passed with `autoBatch: true`
   *   accumulate in a queue. `false` for a single-request target (`produce`):
   *   each `dispatch` call receives exactly one request, and nothing
   *   accumulates.
   * @param options.logger Receives the warning for work started after `close`.
   * @param options.retain Called when a task starts. It returns a release
   *   function that the scheduler calls once the task settles. The wrappers use
   *   it to keep a request's inputs alive while its production is pending.
   * @param options.dispatch Runs one call for the given tasks. Its `info`
   *   describes the whole call. It resolves with one result or Error per task,
   *   in order. A rejection fails every task in the call.
   * @param options.collapseTasksMs A new request rides a pending task with the
   *   same key only if that task started no more than this many milliseconds
   *   ago.
   * @param options.makeKey Converts a request into the key that decides which
   *   pending task it may ride. Return `undefined` for a request that must not
   *   share work with any other: it then starts its own task.
   */
  constructor(options: RequestSchedulerOptions<Request, Result>) {
    const { batching, logger, dispatch, retain } = options;
    this.#batching = batching;
    this.#batcher = new Batcher({
      ...(batching === false
        ? {}
        : pick(batching, [
            "maxBatchSize",
            "batchScheduleFn",
            "preserveAsyncContext",
          ])),
      ...(logger === undefined ? {} : { logger }),
      dispatch: (items, info) =>
        dispatch(
          items.map(
            ({ input: view, queueWaitMs }): DispatchedRequest<Request> => ({
              request: view.input,
              collapsedRequestCount: () => view.collapsedRequestCount,
              queueWaitMs,
            }),
          ),
          info,
        ),
    });

    this.#sharer = new TaskSharer({
      collapseTasksMs: options.collapseTasksMs,
      makeKey: options.makeKey,
      // Takes each task's lease, then starts the task. A direct call
      // passes a list as the context, and collects its new tasks there to
      // send itself. Any other call passes none, and its new tasks queue.
      schedule: (toStart, directStarts) => {
        const leases = retain
          ? toStart.map((view) => retain(view.input))
          : undefined;

        const items = toStart.map((it) => ({ input: it, signal: it.signal }));
        const started = directStarts
          ? items.map((item) => {
              const result = Promise.withResolvers<Result>();
              directStarts.push({ item, result });
              return { result: result.promise, handle: undefined };
            })
          : this.#batcher.enqueue(items);
        return leases
          ? started.map(({ result, handle }, index) => ({
              result: releaseOnSettle(leases[index]!, result),
              handle,
            }))
          : started;
      },
    });
  }

  /**
   * Starts or rides a task for each request. For a bulk target with
   * `autoBatch: false`, one call dispatches the tasks it starts and the
   * queued tasks it rides as one dispatch call. A direct caller must pass all
   * of its requests in one call to get one dispatch call.
   *
   * A request without a signal can never be cancelled, so the task it starts
   * or rides can never be cancelled either.
   */
  startOrRideTasks(
    requests: readonly { request: Request; signal?: AbortSignal }[],
    { autoBatch }: { autoBatch: boolean },
  ) {
    const needsDirectStarts =
      this.#batching === false || !autoBatch || this.#flushed;

    // `schedule` gets this list as its context. When it is defined, `schedule`
    // collects this call's new tasks there, instead of queueing them.
    // `schedule` must return each task's result at once, but only our
    // `startOrRideTasks` call here learns the handles of the tasks it rode. So
    // the new tasks get pending results, and the code below sends them and the
    // ridden tasks with one `dispatchNow`. The new tasks never wait in a batch,
    // so a `batchScheduleFn` cannot send part of a direct call early.
    const newDirectStarts: DirectStart<Request, Result>[] | undefined =
      needsDirectStarts ? [] : undefined;

    let outcomes;
    try {
      outcomes = this.#sharer.startOrRideTasks(
        requests.map(({ request, signal }) => ({ input: request, signal })),
        newDirectStarts,
      );
    } catch (error) {
      // The sharer kept none of the new tasks, so no caller waits for them.
      // Rejecting them still ends their leases.
      newDirectStarts?.forEach(({ result }) => {
        settleResult(result, { ok: false, error });
      });
      throw error;
    }

    if (newDirectStarts) {
      // A direct bulk call also dispatches the queued tasks it rode, so they
      // leave accumulation. A ridden task that already dispatched has no
      // handle, and neither does a task that this call starts.
      const results =
        this.#batching === false
          ? newDirectStarts.map(
              ({ item }) => this.#batcher.dispatchNow([], [item])[0]!,
            )
          : this.#batcher.dispatchNow(
              outcomes.flatMap(({ handle }) => (handle ? [handle] : [])),
              newDirectStarts.map(({ item }) => item),
            );
      newDirectStarts.forEach(({ result }, index) => {
        result.resolve(results[index]!);
      });
    }

    return outcomes.map(({ result, rode }) => ({ promise: result, rode }));
  }

  /**
   * Dispatches every queued task now, and makes later calls dispatch at
   * once. An owner that must still start or ride tasks for accepted work during its
   * shutdown calls it when that shutdown starts, and calls `close` later.
   */
  flush(): void {
    this.#flushed = true;
    this.#batcher.flush();
  }

  /**
   * Runs the whole shutdown: `flush`, then waits until no task is queued
   * or running. The flush runs synchronously, before `close` returns. Call
   * it once the owner stops starting or riding tasks: work started after it finishes
   * logs a warning.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.flush();
      await this.#batcher.close();
      await this.#sharer.drain();
    })();
    return this.#closing;
  }
}

/**
 * Ends a task's `retain` lease once its result settles. The lease is taken
 * before the task's work starts. Every result settles, including a
 * cancelled one, so the lease always ends.
 */
const releaseOnSettle = <Result>(
  release: () => void,
  result: Promise<Result>,
) => {
  const held = result.finally(release);
  // Cancellation can reject the result before anyone awaits it.
  void held.catch(() => {});
  return held;
};
