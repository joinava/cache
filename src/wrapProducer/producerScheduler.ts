/**
 * @fileoverview How a producer client shares and sends its producer work. The
 * parts are separate so that each wrapper picks them independently:
 *
 * - Sharing: {@link createProducerScheduler} lets requests with the same key
 *   ride one pending task. It is the same for every producer.
 * - Sending: a {@link TaskSender} decides when the producer is invoked for
 *   the started tasks, and in what groups. {@link immediateSender} invokes
 *   it once per task. {@link batchingSender} accumulates tasks into batches.
 * - Limiting: either sender takes an optional `ConcurrencyLimiter`, which
 *   limits the producer invocations that run at one time.
 *
 * @module
 */
import {
  Batcher,
  CollapsedTaskCreator,
  type BatchHandle,
  type BatchOptions,
  type ConcurrencyLimiter,
  type DispatchInfo,
  type SharedTaskView,
} from "@zingage/scheduling";
import { pick } from "es-toolkit";

import type { Logger } from "../types/index.js";
import {
  asError,
  assertResultCount,
  defaultLoggersByComponent,
  runLimited,
} from "../utils/utils.js";

/** One task as a scheduler hands it to `dispatch`. */
export type DispatchedRequest<Work> = {
  /**
   * The work of the request that STARTED the task. Requests that ride the
   * task never replace it, so per-request labels such as a producer trigger
   * keep the starting request's value.
   */
  readonly request: Work;
  /**
   * The number of requests that have ridden the task so far. Each one is a
   * request that sharing served without starting new work. The request that
   * started the task does not count, and a cancelled rider still does. Live:
   * read it at publish time, so that requests that ride the task while it runs
   * count too.
   */
  readonly collapsedRequestCount: () => number;
  /**
   * Milliseconds the task waited before the producer was invoked: in the
   * automatic queue, and for a slot under a call limit. 0 for a task that
   * was sent at once.
   */
  readonly queueWaitMs: number;
};

/**
 * Runs one producer invocation for the given tasks. Its `info` describes the
 * whole invocation. It resolves with one result or Error per task, in order.
 * A rejection fails every task in the invocation.
 */
export type DispatchTasks<Work, Produced> = (
  tasks: readonly DispatchedRequest<Work>[],
  info: DispatchInfo,
) => Promise<readonly (Produced | Error)[]>;

/** One request to a {@link ProducerScheduler}. */
export type SchedulerRequest<Work> = {
  request: Work;
  /**
   * Cancels the request. A request without a signal can never be cancelled,
   * so the task it starts or rides can never be cancelled either.
   */
  signal?: AbortSignal | undefined;
  /**
   * `false` keeps the request from riding a task whose producer invocation
   * has already started. It still rides a task that waits, in a batch or for
   * a slot, because that invocation starts after this request.
   */
  joinInFlight?: false | undefined;
};

/** What a scheduler returns for one request. */
export type TaskOutcome<Produced> = {
  /** The task's shared result. */
  promise: Promise<Produced>;
  /** True when the request rode a pending task, false when it started one. */
  rode: boolean;
};

/**
 * Shares pending producer work between independent requests, and sends it.
 * Dispatched work always completes.
 */
export type ProducerScheduler<Work, Produced> = {
  /**
   * Starts or rides a task for each request. The sender decides when each
   * new task's producer invocation starts.
   */
  startOrRideTasks(
    requests: readonly SchedulerRequest<Work>[],
  ): TaskOutcome<Produced>[];
  /**
   * Like `startOrRideTasks`, but sends the call's new tasks, together with
   * the waiting tasks that it rides, as one invocation. Only a scheduler
   * whose sender accumulates work has it. A call with
   * `autoBatch.producer: false` then collects all of its producer work, and
   * sends it with one `startOrRideDirect` call.
   */
  startOrRideDirect?(
    requests: readonly SchedulerRequest<Work>[],
  ): TaskOutcome<Produced>[];
  /** Sends every accumulated task now. */
  flush(): void;
  /**
   * Flushes, then waits until no task waits or runs. The client calls it
   * once it stops starting or riding tasks.
   */
  close(): Promise<void>;
};

/**
 * One started task, from the time the sharing layer starts it until its
 * producer invocation settles.
 */
export type StartedTask<Work, Queued> = {
  /** The task's live view: its work, signal, and rider count. */
  readonly view: SharedTaskView<Work>;
  /**
   * `Date.now()` when the task's producer invocation started. Undefined
   * while the task waits. The sender sets it. The sharing layer reads it: a
   * waiting task is always ridable, and the sharing window of an invoked
   * task runs from this time.
   */
  invokedAt: number | undefined;
  /**
   * The sender's own reference to the waiting task, which
   * {@link TaskSender.sendTogether} uses to take it out of the queue.
   * Undefined for a sender that keeps none, and once the task is invoked.
   */
  queued: Queued | undefined;
};

/**
 * Sends started tasks to the producer. It decides when the producer is
 * invoked, and which tasks share an invocation. It does not share work: every
 * task that it receives is invoked exactly once, unless the task's signal
 * aborts while the task waits.
 */
export type TaskSender<Work, Produced, Queued> = {
  /** Sends each task on the sender's own schedule. Returns each task's result. */
  send(tasks: readonly StartedTask<Work, Queued>[]): Promise<Produced>[];
  /**
   * Sends `tasks`, and those of `waiting` that still wait, as one invocation
   * that is never split. Returns the result of each of `tasks`. Only a
   * sender that accumulates work has it.
   */
  sendTogether?(
    waiting: readonly StartedTask<Work, Queued>[],
    tasks: readonly StartedTask<Work, Queued>[],
  ): Promise<Produced>[];
  /** Sends every accumulated task now. */
  flush(): void;
  /** Flushes, then waits until the sender is idle. */
  close(): Promise<void>;
};

/** What every {@link TaskSender} needs. */
export type TaskSenderOptions<Work, Produced> = {
  dispatch: DispatchTasks<Work, Produced>;
  /**
   * Limits the producer invocations that run at one time. A task that waits
   * for a slot stays ridable, and leaves the queue when its signal aborts.
   */
  limiter: ConcurrencyLimiter | undefined;
};

function toDispatched<Work>(
  task: StartedTask<Work, unknown>,
  queueWaitMs: number,
): DispatchedRequest<Work> {
  const { view } = task;
  return {
    request: view.input,
    collapsedRequestCount: () => view.collapsedRequestCount,
    queueWaitMs,
  };
}

/** Every invocation of an {@link immediateSender} holds one task. */
const SENT_AT_ONCE = { autoBatched: false } as const;

/**
 * Invokes the producer once per task: at once, or when a slot frees under
 * `limiter`. It never accumulates, so it has no `sendTogether`, and `flush`
 * does nothing. Like a `Batcher`, it rejects a task whose slot is an Error,
 * and wraps a non-Error rejection.
 */
export function immediateSender<Work, Produced>({
  dispatch,
  limiter,
}: TaskSenderOptions<Work, Produced>): TaskSender<Work, Produced, undefined> {
  type Task = StartedTask<Work, undefined>;

  const invoke = (task: Task, queueWaitMs: number): Promise<Produced> => {
    task.invokedAt = Date.now();
    return Promise.try(
      dispatch,
      [toDispatched(task, queueWaitMs)],
      SENT_AT_ONCE,
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
  };

  return {
    send: (tasks) =>
      tasks.map((task) =>
        limiter === undefined
          ? invoke(task, 0)
          : runLimited(
              limiter,
              (queueWaitMs) => invoke(task, queueWaitMs),
              task.view.signal,
            ),
      ),
    flush: () => {},
    // The sharing layer waits for every task's result, also for a task that
    // waits for a slot.
    close: async () => {},
  };
}

/** A task as a {@link batchingSender} holds it: `queued` is its batch entry. */
// An interface, because a type alias cannot name itself in its own argument.
interface BatchedTask<Work, Produced> extends StartedTask<
  Work,
  BatchHandle<BatchedTask<Work, Produced>, Produced>
> {}

/**
 * Accumulates tasks in a `Batcher`, and invokes the producer once per batch.
 * A waiting task whose signal aborts leaves the queue. The `Batcher` also
 * logs the warning for work started after `close`.
 */
export function batchingSender<Work, Produced>({
  dispatch,
  limiter,
  logger,
  batching,
}: TaskSenderOptions<Work, Produced> & {
  /**
   * The caller's logger, or undefined for the default. The `Batcher` warns
   * about work started after `close` under its own component.
   */
  logger: Logger | undefined;
  /** The accumulation settings. They apply only to automatic batches. */
  batching: BatchOptions;
}): TaskSender<
  Work,
  Produced,
  BatchHandle<BatchedTask<Work, Produced>, Produced>
> {
  type Task = BatchedTask<Work, Produced>;

  const batcher = new Batcher<Task, Produced>({
    ...pick(batching, [
      "maxBatchSize",
      "batchScheduleFn",
      "preserveAsyncContext",
    ]),
    ...(limiter === undefined ? {} : { limiter }),
    // Keep the `@zingage/cache:batcher` debug namespace by default.
    logger: logger ?? defaultLoggersByComponent.batcher,
    dispatch: (items, info) => {
      const now = Date.now();
      return dispatch(
        items.map(({ input: task, queueWaitMs }) => {
          task.invokedAt = now;
          task.queued = undefined;
          return toDispatched(task, queueWaitMs);
        }),
        info,
      );
    },
  });
  const toItem = (task: Task) => ({ input: task, signal: task.view.signal });

  return {
    send: (tasks) =>
      batcher.enqueue(tasks.map(toItem)).map(({ result, handle }, index) => {
        tasks[index]!.queued = handle;
        return result;
      }),
    // The new tasks never wait in a batch, so a `batchScheduleFn` cannot
    // send part of a direct call early.
    sendTogether: (waiting, tasks) =>
      batcher.dispatchNow(
        waiting.flatMap(({ queued }) => (queued === undefined ? [] : [queued])),
        tasks.map(toItem),
      ),
    // After a flush, automatic work still queues. The flushed batcher sends
    // it on its default schedule, which always fires, so shutdown still
    // batches it instead of sending one call per request.
    flush: () => {
      batcher.flush();
    },
    close: async () => batcher.close(),
  };
}

/** What the sharing layer needs: when requests are compatible, and for how long. */
export type TaskSharingOptions<Work> = {
  /**
   * A new request rides a pending task with the same key if the task still
   * waits, or if its producer invocation started no more than this many
   * milliseconds ago.
   */
  collapseTasksMs: number;
  /**
   * Converts a request into the key that decides which pending task it may
   * ride. `undefined` means the request must not share work with any other:
   * it then starts its own task.
   */
  makeKey: (work: Work) => string | undefined;
};

/**
 * What the shared client gives a wrapper to build its scheduler: the sharing
 * options, and what every sender needs.
 */
export type ProducerSchedulerOptions<Work, Produced> =
  TaskSharingOptions<Work> &
    TaskSenderOptions<Work, Produced> & {
      /** The caller's logger, or undefined to let the scheduler pick its default. */
      logger: Logger | undefined;
    };

/**
 * Builds a {@link ProducerScheduler}: a `CollapsedTaskCreator` shares work
 * between requests, and `sender` sends each started task.
 */
export function createProducerScheduler<Work, Produced, Queued>(
  { collapseTasksMs, makeKey }: TaskSharingOptions<Work>,
  sender: TaskSender<Work, Produced, Queued>,
): ProducerScheduler<Work, Produced> {
  type Task = StartedTask<Work, Queued>;
  /** A task that a direct call started, and has not sent yet. */
  type DirectStart = { task: Task; result: PromiseWithResolvers<Produced> };

  // Its context is a direct call's list of new tasks to send together, or
  // undefined for a call whose new tasks go to `sender.send`.
  const taskCreator = new CollapsedTaskCreator<
    Work,
    Produced,
    Task,
    string,
    DirectStart[] | undefined
  >({
    collapseTasksMs,
    makeKey,
    invokedAt: (task) => task.invokedAt,
    schedule: (toStart, directStarts) => {
      const tasks = toStart.map(
        (view): Task => ({ view, invokedAt: undefined, queued: undefined }),
      );
      // `schedule` must return each task's result at once, but only the
      // `startOrRideTasks` call learns which waiting tasks the call rode. So a
      // direct call's new tasks get pending results here, and
      // `startOrRideDirect` sends them with the ridden tasks.
      if (directStarts !== undefined) {
        return tasks.map((task) => {
          const result = Promise.withResolvers<Produced>();
          directStarts.push({ task, result });
          return { result: result.promise, handle: task };
        });
      }

      const results = sender.send(tasks);
      return tasks.map((task, index) => ({
        result: results[index]!,
        handle: task,
      }));
    },
  });

  const toTaskRequest = ({
    request,
    signal,
    joinInFlight,
  }: SchedulerRequest<Work>) =>
    joinInFlight === false
      ? { input: request, signal, rideInvoked: false }
      : { input: request, signal };
  const toOutcome = ({
    result,
    rode,
  }: {
    result: Promise<Produced>;
    rode: boolean;
  }): TaskOutcome<Produced> => ({ promise: result, rode });

  const sendTogether = sender.sendTogether?.bind(sender);
  let closing: Promise<void> | undefined;

  return {
    startOrRideTasks: (requests) =>
      taskCreator
        .startOrRideTasks(requests.map(toTaskRequest), undefined)
        .map(toOutcome),
    ...(sendTogether === undefined
      ? {}
      : {
          startOrRideDirect: (requests) => {
            const directStarts: DirectStart[] = [];
            // If this throws, the task creator kept none of the new tasks, so
            // no caller waits for their results.
            const outcomes = taskCreator.startOrRideTasks(
              requests.map(toTaskRequest),
              directStarts,
            );
            // The call also sends the waiting tasks that it rode, so they
            // leave accumulation. A task that this call started has nothing
            // queued, and neither does a ridden task that was already sent.
            const results = sendTogether(
              outcomes.flatMap(({ handle }) =>
                handle?.queued === undefined ? [] : [handle],
              ),
              directStarts.map(({ task }) => task),
            );
            directStarts.forEach(({ result }, index) => {
              result.resolve(results[index]!);
            });
            return outcomes.map(toOutcome);
          },
        }),
    flush: () => {
      sender.flush();
    },
    close: () => {
      closing ??= (async () => {
        await sender.close();
        await taskCreator.drain();
      })();
      return closing;
    },
  };
}
