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
      { args, taskKey },
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

/**
 * The producer wrappers' internal variant of {@link collapsedTaskCreator}:
 * identical collapse semantics (same args + pending + within
 * `collapseTasksMs` of the task's start ⇒ reuse), but purpose-built for
 * producer-invocation telemetry:
 *
 * - each call is labeled with the trigger that motivated it; the label of
 *   the call that actually CREATES an invocation is fixed as that
 *   invocation's trigger (riders never re-label it);
 * - the task function receives a {@link CollapsedInvocation} handle so it can
 *   publish invocation-scoped diagnostics (trigger, attached-caller count);
 * - each call's return says whether it `rode` an already-in-flight
 *   invocation (true) or initiated one (false). Settlements that DEPEND on
 *   the invocation (served-from-producer / producer-error /
 *   served-stale-after-error / aborted-while-waiting) report this as the
 *   fetch channel's `collapsed` flag; cache-served settlements (fresh or
 *   stale-while-revalidating) report `collapsed: false` even when they
 *   attached a background revalidation as a rider, since their settlement
 *   never depended on it (see CacheFetchMessage.collapsed).
 *
 * Not exported from the package: the public `collapsedTaskCreator` remains
 * the general-purpose utility.
 * @internal
 */
export function collapsedInvocationTaskCreator<
  Args extends unknown[],
  Result,
>(
  taskCreator: (
    invocation: CollapsedInvocation,
    ...args: Args
  ) => Promise<Result>,
  collapseTasksMs: number,
  makeKey: (args: Args) => string,
  logger: Logger = defaultLoggersByComponent["collapsed-task-creator"],
): (
  trigger: CollapsedInvocation["trigger"],
  ...args: Args
) => { promise: Promise<Result>; rode: boolean } {
  type PendingInvocation = {
    promise: Promise<Result>;
    taskStartTimestamp: number;
    /**
     * Its own cell so the task function can read a LIVE count: the
     * `CollapsedInvocation` handle has to exist before `taskCreator` runs, but
     * riders increment the count afterwards.
     */
    callers: { count: number };
  };
  const pendingTasks = new Map<string, PendingInvocation>();
  const logTrace = logger.bind(null, "collapsed-task-creator", "trace");

  return (trigger, ...args) => {
    const taskKey = makeKey(args);
    const existing = pendingTasks.get(taskKey);
    const now = Date.now();

    if (existing && now - existing.taskStartTimestamp <= collapseTasksMs) {
      logTrace(
        "reusing result from prior, still-in-progress run of task for args/taskKey",
        { args, taskKey },
      );
      existing.callers.count += 1;
      return { promise: existing.promise, rode: true };
    }

    logTrace(
      existing
        ? "started new task; there _was_ an in-progress one, but it's too old"
        : "started new task b/c there was no in-progress task for these args",
      args,
    );

    // The caller count lives in its own cell so the handle below can be built
    // (and read live) before the pending record exists.
    const callers = { count: 1 };
    const invocation: CollapsedInvocation = {
      trigger,
      attachedCallerCount: () => callers.count,
    };

    const promise = taskCreator(invocation, ...args).finally(() => {
      // Only remove this task from pendingTasks if pendingTasks[taskKey]
      // is still the same task. (It could be a new one if the old one was
      // overwritten for taking longer than collapseTasksMs.) Identified by its
      // promise, since that is unique per invocation.
      if (pendingTasks.get(taskKey)?.promise === promise) {
        logTrace("completed = new state for taskKey/args", { args, taskKey });
        pendingTasks.delete(taskKey);
      }
    });

    // Save the new task as a pending task. This will be _replacing_
    // an existing pending task for this key if the other was too old.
    pendingTasks.set(taskKey, { promise, taskStartTimestamp: now, callers });
    return { promise, rode: false };
  };
}
