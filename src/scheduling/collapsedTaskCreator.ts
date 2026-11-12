import type { Logger } from "../types/index.js";
import { defaultLoggersByComponent } from "../utils/utils.js";
import { TaskSharer, type TaskStartReason } from "./taskSharer.js";

// The sharer reserves `undefined` for inputs that never share work, but here
// `undefined` is an ordinary key. So it stands in for `undefined` with a
// key that no caller can produce.
const undefinedKey = Symbol("undefined key");

/**
 * The "started" log line for each reason a call starts a task. A call here
 * has no signal, so its task is never cancelled, and its key is never
 * `undefined` for the sharer. But every reason has a line, so the log stays
 * accurate if that changes.
 */
const startedMessages: Record<TaskStartReason, string> = {
  noPendingTask:
    "started new task b/c there was no in-progress task for these args",
  pendingTaskTooOld:
    "started new task; there _was_ an in-progress one, but it's too old",
  pendingTaskCancelled:
    "started new task; there _was_ an in-progress one, but it was cancelled",
  noKey: "started new task b/c these args have no key",
};

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
 * It runs on `TaskSharer`: each call is one task request, whose input
 * carries the call's arguments and key.
 *
 * @param taskCreator The task creation function
 * @param collapseTasksMs The number of milliseconds up until which, if a caller
 *   tries to start the same task while a previous version of the task is still
 *   running, the promise for the result of the currently-running task will be
 *   returned instead.
 * @param makeKey A function for converting the arguments passed to the task
 *   creation into a cache key, like in your standard memoize implementation.
 * @param logger Receives the trace lines that each call writes.
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
  const logTrace = logger.bind(null, "collapsed-task-creator", "trace");

  // The sharer's input carries the key, so `makeKey` runs once per call and
  // every log line below can include the key.
  const sharer = new TaskSharer({
    collapseTasksMs,
    makeKey: ({ taskKey }: { args: Args; taskKey: Key }) =>
      taskKey === undefined ? undefinedKey : taskKey,
    schedule: (toStart) =>
      toStart.map(({ input: { args, taskKey }, startReason }) => {
        logTrace(startedMessages[startReason], args);
        const taskRes = taskCreator(...args);
        logTrace("pending = new state for taskKey/args", { args, taskKey });
        return {
          result: taskRes.finally(() => {
            logTrace("completed = new state for taskKey/args", {
              args,
              taskKey,
            });
          }),
          handle: undefined,
        };
      }),
  });

  return async (...args: Args) => {
    const taskKey = makeKey(args);
    logTrace("requested = new state for taskKey/args", { args, taskKey });

    const [{ result, rode }] = sharer.startOrRideTasks([
      { input: { args, taskKey } },
    ]);

    if (rode) {
      logTrace(
        "reusing result from prior, still-in-progress run of task for args/taskKey",
        { args, taskKey },
      );
    }

    return result;
  };
}
