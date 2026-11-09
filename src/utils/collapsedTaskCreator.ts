import { AsyncLocalStorage } from "node:async_hooks";
import { asError, CacheContractError } from "./utils.js";
import type { Logger } from "../types/index.js";
import { defaultLoggersByComponent } from "../utils/utils.js";

/**
 * Imagine you have an function that, when called, kicks off a task, and
 * returns a promise representing the result of the task. Now, suppose the task
 * is expensive, but not effectful, like fetching from a REST API. If your code
 * attempts to run this task many times in quick succession, or many times in
 * parallel, this can be wasteful (if the result will always or likely be the
 * same) and/or overload whatever's doing work as part of the task (eg the API).
 *
 * There are a large number of npm packages that make it easy to better schedule
 * this work (e.g., queueing some parallel runs of the task behind others, if
 * the number of tasks already running exceeds some concurrency limit) or to
 * reuse the results of some runs of the task for others (by debouncing or
 * throttling calls to the function that starts the task). However, none of them
 * have quite the -- admittedly a bit quirky -- semantics that we want, and that
 * we implement here.
 *
 * Specifically, this function accepts a function for starting/creating tasks,
 * along with some options, and returns a new function that behaves like the
 * original except that the promise resulting from a call is reused on
 * subsequent calls if and only if: 1) the subsequent calls have the same
 * arguments [a la memoize]; 2) less than a certain number of milliseconds have
 * passed [a la throttle]; and 3) the original task is still running [unique].
 * In other words, it memoizes the original task-starting function, but then
 * reverts to calling through to the original function after a certain number
 * of milliseconds or after the last-started task finishes, whichever is first.
 * So it's sort of a combination of memoize, throttle, and promise chaining.
 *
 * @param taskCreator The task creation function
 * @param collapseTasksMs The number of milliseconds up until which, if a caller
 *   tries to start the same task while a previous version of the task is still
 *   running, the promise for the result of the currently-running task will be
 *   returned instead.
 * @param makeKey A function for converting the arguments passed to the task
 *   creation into a cache key, like in your standard memoize implementation.
 */
export default function collapsedTaskCreator<
  Args extends unknown[],
  Key,
  Result,
>(
  taskCreator: (...args: Args) => Promise<Result>,
  collapseTasksMs: number,
  makeKey: (args: Args) => Key,
  logger: Logger = defaultLoggersByComponent["collapsed-task-creator"],
) {
  const pendingTasks = new Map<
    Key,
    [Promise<Result>, taskStartTimestamp: number]
  >();
  const logTrace = logger.bind(null, "collapsed-task-creator", "trace");

  return async (...args: Args) => {
    const taskKey = makeKey(args);
    const res = pendingTasks.get(taskKey);
    const now = Date.now();
    logTrace("requested = new state for taskKey/args", { args, taskKey });

    if (!res || now - res[1] > collapseTasksMs) {
      logTrace(
        res
          ? "started new task; there _was_ an in-progress one, but it's too old"
          : "started new task b/c there was no in-progress task for these args",
        args,
      );

      const taskRes = taskCreator(...args).finally(async () => {
        // Only remove this task from pendingTasks if pendingTasks[taskKey]
        // is still the same task. (It could be a new one if the old one was
        // overwritten for taking longer than collapseTasksMs.)
        const pendingValueNow = pendingTasks.get(taskKey);
        if (pendingValueNow && pendingValueNow[0] === taskRes) {
          logTrace("completed = new state for taskKey/args", { args, taskKey });
          pendingTasks.delete(taskKey);
        }
      });

      // Save the new task as a pending task. This will be _replacing_
      // an existing pending task for this key if the other was too old.
      pendingTasks.set(taskKey, [taskRes, now]);
      logTrace("pending = new state for taskKey/args", { args, taskKey });
      return taskRes;
    }

    logTrace(
      "reusing result from prior, still-in-progress run of task for args/taskKey",
      {
        args,
        taskKey,
      },
    );
    return res[0];
  };
}

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
  readonly automatic: boolean;
};

/**
 * Schedules independent producer requests and shares compatible pending work.
 * Cancellation removes queued participation. Dispatched work always completes.
 */
export function createProducerScheduler<Request, Result>(options: {
  bulk: boolean;
  maxBatchSize?: number;
  batchScheduleFn?: (dispatch: () => void) => void;
  collapseTasksMs: number;
  key: (request: Request) => string | undefined;
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
    accumulated: boolean;
    callers: Set<object>;
    participants: number;
    background: boolean;
    state: "queued" | "running" | "settled";
    result: ReturnType<typeof Promise.withResolvers<Result>>;
    release: (() => void) | undefined;
  };
  const pending = new Map<string | symbol, Task>();
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
    if (pending.get(task.key) === task) pending.delete(task.key);
  };
  const dispatch = (selected: readonly Task[], automatic: boolean) => {
    const tasks = selected.filter((task) => task.state === "queued");
    // Only automatic accumulation is limited by maxBatchSize. A direct call
    // reaches a bulk producer as one invocation, whatever its size.
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
            automatic,
          })),
        ),
      )
        .then((results) => {
          if (results.length !== batch.length)
            throw new CacheContractError(
              "Producer result count must match request count",
            );
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
          const key = options.key(request) ?? Symbol();
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
