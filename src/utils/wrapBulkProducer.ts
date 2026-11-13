/**
 * @fileoverview The client for a bulk producer (`produceMany`). It shares
 * pending work between requests, and batches the started tasks into producer
 * invocations.
 *
 * @module
 */
import { pick } from "es-toolkit";
import {
  Batcher,
  settleResult,
  type BatchHandle,
  type BatchItem,
  type BatchOptions,
} from "../scheduling/batcher.js";
import { TaskSharer, type SharedTaskView } from "../scheduling/taskSharer.js";
import type {
  ResourceTypeName,
  ResourceTypes,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  CoveringBulkProducer,
} from "../types/index.js";
import {
  createProducerClient,
  releaseOnSettle,
  type DispatchedRequest,
  type LooseBulkProducer,
  type ProducerScheduler,
  type ProducerSchedulerOptions,
} from "./producerClient.js";
import type {
  WrappedProducerClient,
  WrapProducerOptions,
} from "./wrapProducer.js";

/**
 * Wraps a bulk producer. `wrapProducer` calls it for `produceMany`, and
 * documents the client.
 */
export function wrapBulkProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  options: WrapProducerOptions<RT, Validators, Params>,
  produceMany: CoveringBulkProducer<RT, Covered, Validators, Params>,
): WrappedProducerClient<RT, Covered, Validators, Params> {
  // Classification and coverage checks prove this erasure before dispatch.
  const looseProduceMany = produceMany as LooseBulkProducer<
    RT,
    Validators,
    Params,
    Error
  >;
  return createProducerClient<RT, Covered, Validators, Params>(options, {
    producer: produceMany,
    call: looseProduceMany,
    makeScheduler: (schedulerOptions) =>
      new BulkProducerScheduler({
        ...schedulerOptions,
        batching: options.producerBatching ?? {},
      }),
  });
}

/** A task that a direct `startOrRideTasks` call started, and has not sent yet. */
type DirectStart<Work, Produced> = {
  item: BatchItem<SharedTaskView<Work>>;
  result: PromiseWithResolvers<Produced>;
};

/**
 * Shares pending work between requests, and batches the started tasks. A
 * queued task whose requests are all cancelled leaves the queue.
 *
 * It composes a `TaskSharer`, which shares work, with a `Batcher`, which
 * batches and sends it. The `Batcher` also logs the warning for work started
 * after `close`.
 *
 * @internal
 */
export class BulkProducerScheduler<Work, Produced> implements ProducerScheduler<
  Work,
  Produced
> {
  /**
   * Sends the work. It dispatches each item's live view, so
   * `collapsedRequestCount` counts riders up to dispatch time.
   */
  readonly #batcher: Batcher<SharedTaskView<Work>, Produced>;
  /**
   * Shares work. Its context is a direct call's list of new tasks to send at
   * once, or undefined for automatic work, which queues.
   */
  readonly #sharer: TaskSharer<
    Work,
    Produced,
    BatchHandle<SharedTaskView<Work>, Produced> | undefined,
    string,
    DirectStart<Work, Produced>[] | undefined
  >;
  /**
   * The promise that `close` returns, so a second `close` cannot flush or
   * drain twice.
   */
  #closing: Promise<void> | undefined;

  /**
   * @param options.batching The batch settings. Requests passed with
   *   `autoBatch: true` accumulate in a queue, and `dispatch` receives every
   *   request of a batch at once.
   */
  constructor(
    options: ProducerSchedulerOptions<Work, Produced> & {
      batching: BatchOptions;
    },
  ) {
    const { batching, logger, dispatch, retain } = options;
    this.#batcher = new Batcher({
      ...pick(batching, [
        "maxBatchSize",
        "batchScheduleFn",
        "preserveAsyncContext",
      ]),
      ...(logger === undefined ? {} : { logger }),
      dispatch: (items, info) =>
        dispatch(
          items.map(
            ({ input: view, queueWaitMs }): DispatchedRequest<Work> => ({
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
        const leases = toStart.map((view) => retain(view.input));
        const items = toStart.map((it) => ({ input: it, signal: it.signal }));
        const started = directStarts
          ? items.map((item) => {
              const result = Promise.withResolvers<Produced>();
              directStarts.push({ item, result });
              return { result: result.promise, handle: undefined };
            })
          : this.#batcher.enqueue(items);
        return started.map(({ result, handle }, index) => ({
          result: releaseOnSettle(leases[index]!, result),
          handle,
        }));
      },
    });
  }

  /** Starts or rides a task for each request. New tasks queue. */
  startOrRideTasks(
    requests: readonly { request: Work; signal?: AbortSignal | undefined }[],
  ): { promise: Promise<Produced>; rode: boolean }[] {
    return this.#startOrRide(requests, true);
  }

  /**
   * Starts or rides a task for each request, and dispatches the tasks it
   * starts and the queued tasks it rides as one dispatch call. A direct
   * caller must pass all of its requests in one call to get one dispatch
   * call.
   */
  startOrRideDirect(
    requests: readonly { request: Work; signal?: AbortSignal | undefined }[],
  ): { promise: Promise<Produced>; rode: boolean }[] {
    return this.#startOrRide(requests, false);
  }

  #startOrRide(
    requests: readonly { request: Work; signal?: AbortSignal | undefined }[],
    autoBatch: boolean,
  ): { promise: Promise<Produced>; rode: boolean }[] {
    // After `flush`, requests passed with `autoBatch: true` still queue. The
    // flushed batcher sends them on its default schedule, which always fires,
    // so shutdown still batches them instead of sending one call per request.
    //
    // `schedule` gets this list as its context. When it is defined, `schedule`
    // collects this call's new tasks there, instead of queueing them.
    // `schedule` must return each task's result at once, but only our
    // `startOrRideTasks` call here learns the handles of the tasks it rode. So
    // the new tasks get pending results, and the code below sends them and the
    // ridden tasks with one `dispatchNow`. The new tasks never wait in a batch,
    // so a `batchScheduleFn` cannot send part of a direct call early.
    const newDirectStarts: DirectStart<Work, Produced>[] | undefined = autoBatch
      ? undefined
      : [];

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
      // A direct call also dispatches the queued tasks it rode, so they
      // leave accumulation. A ridden task that already dispatched has no
      // handle, and neither does a task that this call starts.
      const results = this.#batcher.dispatchNow(
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
   * Dispatches every queued task now. Later automatic batches use the
   * batcher's default schedule, which always fires, instead of
   * `batchScheduleFn`.
   */
  flush(): void {
    this.#batcher.flush();
  }

  /**
   * Runs the whole shutdown: `flush`, then waits until no task is queued
   * or running. The flush runs synchronously, before `close` returns.
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
