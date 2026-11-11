import { CacheContractError } from "./utils.js";

/**
 * The signal of every task that can never be cancelled. Nothing holds its
 * controller, so it never aborts. Sharing it saves one AbortController per
 * such task.
 */
const neverAborts = new AbortController().signal;

/** A task as the sharer shows it to `schedule`. */
export type SharedTaskView<Input> = {
  /**
   * The input of the task request that STARTED the task. Task requests that
   * ride the task never replace it, so per-request labels such as a producer
   * trigger keep the starting task request's value.
   */
  readonly input: Input;
  /**
   * Aborts when every request on the task is cancelled. A task request is
   * cancelled when its own signal aborts. A task request without a signal can
   * never be cancelled, so it keeps the task's signal from aborting.
   */
  readonly signal: AbortSignal;
  /**
   * The number of task requests that have ridden the task so far. Each one is
   * a request that sharing served without starting new work. The task request
   * that started the task does not count, and a cancelled rider still does.
   *
   * It is a function, so a reader sees every ride up to the time it calls it.
   * A call records its rides only after its `schedule` returns, so `schedule`
   * never sees its own call's rides.
   */
  readonly collapsedRequestCount: () => number;
};

/**
 * Shares pending work between task requests whose inputs have the same key.
 * It generalizes `collapsedTaskCreator` in three ways:
 *
 * - One `startOrRideTasks` call takes many task requests. Each task request
 *   either starts a new task or rides a pending task for its input's key. The
 *   tasks that one call starts are scheduled together, in one `schedule` call,
 *   so a bulk caller's new inputs become one unit of work. Task requests that
 *   ride start nothing.
 * - Each task has an AbortSignal that aborts when every request on the task is
 *   cancelled. `schedule` passes it to whatever runs the work, such as a
 *   batcher's queue or a producer that supports cancellation.
 * - It counts the task requests that ride each task, for diagnostics.
 *
 * Terms:
 * - An input is the value that a task's work needs, such as a producer
 *   request. `makeKey` derives its key.
 * - A task request is one input plus an optional signal that cancels the task
 *   request. It is one item of `startOrRideTasks`'s `taskRequests`.
 * - A task request starts a task or rides one. A task's requests are the task
 *   request that started it and every task request that rides it.
 * - A task request is cancelled when its signal aborts. A task is cancelled
 *   when all of its requests are cancelled.
 *
 * The sharer itself does not queue, batch or limit work. The `schedule`
 * callback owns that.
 *
 * A task stops being ridable when it settles, or when it is cancelled. A
 * cancelled task can still be running, but a new task request must not ride
 * work that is being cancelled.
 *
 * @internal
 */
export function createTaskSharer<Input, Result, Handle>(options: {
  /**
   * A task request rides a pending task for its input's key only if that task
   * started no more than this many milliseconds ago.
   */
  collapseTasksMs: number;
  /**
   * Converts an input into the key that decides which pending task its task
   * request may ride. Return `undefined` for an input that must not share work
   * with any other, for example because its key cannot be computed. Its task
   * request then starts its own task, which no task request can ride.
   */
  makeKey: (input: Input) => string | undefined;
}) {
  /** The parts of a task that exist before its `schedule` call returns. */
  type TaskStart = {
    /**
     * `forget` reads this to remove the task from `latestPendingTaskByKey`.
     * Undefined for a task that was never there, so no task request can ride
     * it.
     */
    readonly key: string | undefined;
    /**
     * Compared with `collapseTasksMs`, so no task request rides a task that is
     * too old.
     */
    readonly startedAt: number;
    /**
     * Built once, because every `schedule` call that starts or rides this task
     * receives it.
     */
    readonly view: SharedTaskView<Input>;
    /** The count that `view.collapsedRequestCount` reads. */
    readonly rides: { count: number };
    /**
     * Undefined when the task request that started the task has no signal.
     * That task request can never be cancelled, so neither can the task, and
     * its signal is the shared {@link neverAborts}.
     */
    readonly cancellation:
      | {
          readonly controller: AbortController;
          /**
           * The task's requests that are not cancelled. A task request without
           * a signal is never cancelled, so it holds this above 0 until the
           * task settles.
           */
          uncancelledRequests: number;
        }
      | undefined;
  };

  /**
   * A task that its `schedule` call has scheduled. Only these tasks are in
   * `latestPendingTaskByKey` and `live`, so a failed `schedule` call leaves no
   * task behind.
   */
  type Task = TaskStart & {
    /** The handle that a later `schedule` call receives when it rides this task. */
    readonly handle: Handle;
    /** The result that the task's `schedule` call returned. */
    readonly result: Promise<Result>;
    /**
     * Removes this task's abort listeners when it settles. A task request's
     * signal can outlive the task, and its listener would otherwise keep the
     * settled task alive. Empty for a task with no request that has a signal.
     */
    readonly cleanups: (() => void)[];
  };

  /**
   * For each key, the newest pending task: the task that a new task request
   * for that key rides. A newer task replaces an older one whose start is
   * outside `collapseTasksMs`; the older one keeps running, tracked only in
   * `live`.
   */
  const latestPendingTaskByKey = new Map<string, Task>();
  /**
   * Every task that has not settled. `latestPendingTaskByKey` leaves out three
   * kinds of unsettled task: tasks with no key, cancelled tasks, and tasks
   * that a newer task replaced. `drain` must still wait for all of them.
   */
  const live = new Set<Task>();
  /**
   * The keys of the tasks that a running `schedule` call is starting. Those
   * tasks are not ridable until `schedule` returns. So when `schedule` runs a
   * producer synchronously, and that producer requests its own key, a nested
   * call would start the same task again, without end. The nested call
   * throws instead. Holds keys from several calls only while `schedule`
   * calls nest, with different keys.
   */
  const schedulingKeys = new Set<string>();

  // Only remove this task if the map still holds it for its key. The map
  // could hold a newer one if this task was replaced for being older than
  // collapseTasksMs.
  const forget = (task: Task) => {
    if (
      task.key !== undefined &&
      latestPendingTaskByKey.get(task.key) === task
    ) {
      latestPendingTaskByKey.delete(task.key);
    }
  };

  const newTaskStart = (
    key: string | undefined,
    input: Input,
    cancellable: boolean,
    now: number,
  ): TaskStart => {
    const cancellation = cancellable
      ? { controller: new AbortController(), uncancelledRequests: 0 }
      : undefined;
    const rides = { count: 0 };
    return {
      key,
      startedAt: now,
      view: {
        input,
        signal: cancellation?.controller.signal ?? neverAborts,
        collapsedRequestCount: () => rides.count,
      },
      rides,
      cancellation,
    };
  };

  /** Makes a scheduled task ridable, and tracks it until it settles. */
  const register = (
    start: TaskStart,
    { result, handle }: { result: Promise<Result>; handle: Handle },
  ): Task => {
    const task: Task = { ...start, handle, result, cleanups: [] };
    // Handling both outcomes also marks a rejection as handled: every task
    // request may be cancelled before anyone awaits the result.
    const settle = () => {
      forget(task);
      live.delete(task);
      task.cleanups.forEach((cleanup) => cleanup());
    };
    void result.then(settle, settle);
    if (task.key !== undefined) latestPendingTaskByKey.set(task.key, task);
    live.add(task);
    return task;
  };

  /**
   * Records a task request on a task, whether the task request started the
   * task or rides it. `signal` and `rode` are the task request's.
   *
   * @returns A function that cancels the task request, when its signal has
   *   already aborted. `schedule` runs user code, so a signal can abort after
   *   `startOrRideTasks` checked it. The caller runs these functions only
   *   after it has counted every request in the call. Otherwise an early
   *   abort could cancel a task that a later request in the call keeps alive.
   */
  const addTaskRequest = (
    task: Task,
    signal: AbortSignal | undefined,
    rode: boolean,
  ): (() => void) | undefined => {
    if (rode) task.rides.count += 1;
    // An uncancellable task needs no count: no task request can cancel it.
    const { cancellation } = task;
    if (cancellation === undefined) return undefined;

    cancellation.uncancelledRequests += 1;
    if (signal === undefined) return undefined;

    const cancelTaskRequest = () => {
      cancellation.uncancelledRequests -= 1;
      if (cancellation.uncancelledRequests === 0) {
        forget(task);
        cancellation.controller.abort(signal.reason);
      }
    };
    if (signal.aborted) return cancelTaskRequest;

    signal.addEventListener("abort", cancelTaskRequest, { once: true });
    task.cleanups.push(() =>
      signal.removeEventListener("abort", cancelTaskRequest),
    );
    return undefined;
  };

  return {
    /**
     * Each task request rides a pending task for its input's key, or starts a
     * new task. Schedules the new tasks with one `schedule` call.
     *
     * It changes no state until `schedule` returns. So when a signal is
     * already aborted, `makeKey` throws, `schedule` throws, or `schedule`
     * returns the wrong number of entries, it throws and changes nothing.
     *
     * The tasks this call starts become ridable only after `schedule`
     * returns. A `schedule` may call `startOrRideTasks` again, for example by
     * running a producer that reads other keys. But a nested call that
     * requests a key this call is starting throws a `CacheContractError`:
     * that request depends on its own result.
     *
     * @param taskRequests Each task request's input, and an optional signal
     *   that cancels the task request.
     * @param schedule Schedules the tasks this call starts, as one unit of
     *   work. It receives:
     *   - `toStart`: the tasks this call starts, in task request order.
     *   - `toRide`: the pending tasks this call rides, with the handles that
     *     their own `schedule` returned. A direct caller can use the handles
     *     to pull still-queued work into its own call. Other callers can
     *     ignore them.
     *
     *   It returns one entry per task in `toStart`, in order: the task's
     *   result, and an opaque handle that later `schedule` calls receive when
     *   they ride the task.
     * @returns One entry per task request, in order. `result` is the task's
     *   shared result. It does not reject when only this task request is
     *   cancelled, because the task's other requests may still need the
     *   result; a caller races its own signal. `rode` is true when the task
     *   request rode a task that it did not start.
     */
    startOrRideTasks(
      taskRequests: readonly {
        readonly input: Input;
        readonly signal?: AbortSignal;
      }[],
      schedule: (
        toStart: readonly SharedTaskView<Input>[],
        toRide: readonly (SharedTaskView<Input> & {
          readonly handle: Handle;
        })[],
      ) => readonly {
        readonly result: Promise<Result>;
        readonly handle: Handle;
      }[],
    ): { readonly result: Promise<Result>; readonly rode: boolean }[] {
      if (taskRequests.length === 0) return [];

      // Compute every key before checking signals: makeKey is user code and
      // may abort a signal.
      const keys = taskRequests.map(({ input }) => options.makeKey(input));
      taskRequests.forEach(({ signal }) => signal?.throwIfAborted());
      if (keys.some((key) => key !== undefined && schedulingKeys.has(key))) {
        throw new CacheContractError(
          "schedule requested a key that it is starting a task for",
        );
      }

      const now = Date.now();
      const toStart: TaskStart[] = [];
      // A task request whose key matches a task that this call starts rides
      // that task. The task is not in `latestPendingTaskByKey` yet.
      const startIndexByKey = new Map<string, number>();
      // A Set, because several task requests in one call can ride the same
      // task, and `schedule` must see that task once.
      const toRide = new Set<Task>();
      const steps = taskRequests.map(
        (
          { input, signal },
          i,
        ):
          | { startIndex: number; rode: boolean }
          | { ridden: Task; rode: true } => {
          const key = keys[i];
          if (key !== undefined) {
            const startIndex = startIndexByKey.get(key);
            if (startIndex !== undefined) return { startIndex, rode: true };

            const existing = latestPendingTaskByKey.get(key);
            if (
              existing !== undefined &&
              now - existing.startedAt <= options.collapseTasksMs
            ) {
              toRide.add(existing);
              return { ridden: existing, rode: true };
            }

            startIndexByKey.set(key, toStart.length);
          }

          toStart.push(newTaskStart(key, input, signal !== undefined, now));
          return { startIndex: toStart.length - 1, rode: false };
        },
      );

      // The guard above ensures that no outer call holds these keys, so
      // deleting them afterwards never removes an outer call's keys.
      const ownKeys = [...startIndexByKey.keys()];
      ownKeys.forEach((key) => schedulingKeys.add(key));
      const scheduled = (() => {
        try {
          return schedule(
            toStart.map((start) => start.view),
            [...toRide].map((task) => ({ ...task.view, handle: task.handle })),
          );
        } finally {
          ownKeys.forEach((key) => schedulingKeys.delete(key));
        }
      })();

      if (scheduled.length !== toStart.length) {
        throw new CacheContractError(
          "schedule must return one scheduled task per task to start",
        );
      }

      const started = toStart.map((start, index) =>
        register(start, scheduled[index]!),
      );
      // If `schedule` cancels every request on a task this call rides, this
      // call's task requests still join that cancelled task, and their
      // results settle with it.
      const tasks = steps.map((step) =>
        "ridden" in step ? step.ridden : started[step.startIndex]!,
      );
      tasks
        .flatMap(
          (task, index) =>
            addTaskRequest(
              task,
              taskRequests[index]!.signal,
              steps[index]!.rode,
            ) ?? [],
        )
        .forEach((cancelTaskRequest) => cancelTaskRequest());

      return tasks.map((task, index) => ({
        result: task.result,
        rode: steps[index]!.rode,
      }));
    },

    /** Waits until every task has settled, including cancelled ones. */
    async drain(): Promise<void> {
      while (live.size > 0) {
        await Promise.allSettled([...live].map((task) => task.result));
      }
    },
  };
}
