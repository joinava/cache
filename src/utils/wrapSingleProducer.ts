/**
 * @fileoverview The client for a single-request producer (`produce`). It
 * shares pending work between requests, and sends each started task to the
 * producer at once, as its own invocation. A single producer has nothing to
 * batch, so it needs no batcher.
 *
 * @module
 */
import { TaskSharer } from "../scheduling/taskSharer.js";
import type {
  ResourceTypeName,
  ResourceTypes,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  CoveringProducer,
} from "../types/index.js";
import {
  createProducerClient,
  releaseOnSettle,
  type LooseProducer,
  type ProducerScheduler,
  type ProducerSchedulerOptions,
} from "./producerClient.js";
import { asError, assertResultCount } from "./utils.js";
import type {
  WrappedProducerClient,
  WrapProducerOptions,
} from "./wrapProducer.js";

/**
 * Wraps a single-request producer. `wrapProducer` calls it for `produce`, and
 * documents the client.
 */
export function wrapSingleProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  options: WrapProducerOptions<RT, Validators, Params>,
  produce: CoveringProducer<RT, Covered, Validators, Params>,
): WrappedProducerClient<RT, Covered, Validators, Params> {
  // Classification and coverage checks prove this erasure before dispatch.
  const looseProduce = produce as LooseProducer<RT, Validators, Params>;
  return createProducerClient<RT, Covered, Validators, Params>(options, {
    producer: produce,
    call: async (requests) => [await looseProduce(requests[0]!)],
    makeScheduler: (schedulerOptions) =>
      new SingleProducerScheduler(schedulerOptions),
  });
}

/** Every single-producer invocation is sent at once. */
const SENT_AT_ONCE = { autoBatched: false } as const;

/**
 * Shares pending work between requests, and sends each started task at once,
 * with its own `dispatch` call. Nothing waits, so it has no
 * `startOrRideDirect`, and `flush` does nothing. The client rejects new calls
 * once it starts closing, and drains them before it closes this scheduler, so
 * no task can start after `close`.
 *
 * @internal
 */
export class SingleProducerScheduler<
  Work,
  Produced,
> implements ProducerScheduler<Work, Produced> {
  /** Shares pending work between requests with the same key. */
  readonly #sharer: TaskSharer<Work, Produced, undefined>;

  constructor({
    collapseTasksMs,
    makeKey,
    retain,
    dispatch,
  }: ProducerSchedulerOptions<Work, Produced>) {
    this.#sharer = new TaskSharer({
      collapseTasksMs,
      makeKey,
      // Takes each task's lease, then sends the task. The sharer passes only
      // tasks whose requests were not cancelled, and sends them in this same
      // turn, so no task needs a cancellation check here. Like the bulk
      // scheduler's `Batcher`, it rejects a task whose slot is an Error, and
      // wraps a non-Error rejection.
      schedule: (toStart) =>
        toStart.map((view) => {
          const release = retain(view.input);
          const result = Promise.try(() =>
            dispatch(
              [
                {
                  request: view.input,
                  collapsedRequestCount: () => view.collapsedRequestCount,
                  queueWaitMs: 0,
                },
              ],
              SENT_AT_ONCE,
            ),
          ).then(
            (results) => {
              assertResultCount(results, 1);
              const slot = results[0]!;
              if (slot instanceof Error) throw slot;
              return slot;
            },
            (error: unknown) => {
              throw asError(error);
            },
          );
          return {
            result: releaseOnSettle(release, result),
            handle: undefined,
          };
        }),
    });
  }

  startOrRideTasks(
    requests: readonly { request: Work; signal?: AbortSignal | undefined }[],
  ): { promise: Promise<Produced>; rode: boolean }[] {
    return this.#sharer
      .startOrRideTasks(
        requests.map(({ request, signal }) => ({ input: request, signal })),
      )
      .map(({ result, rode }) => ({ promise: result, rode }));
  }

  /** Does nothing: no task waits to be sent. */
  flush(): void {}

  /** Waits until no task is running. */
  close(): Promise<void> {
    return this.#sharer.drain();
  }
}
