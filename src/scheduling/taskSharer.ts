import { assertUnreachable, CacheContractError, zip2 } from "../utils/utils.js";

/**
 * The signal of every task that can never be cancelled. Nothing holds its
 * controller, so it never aborts. Sharing it saves one AbortController per
 * such task.
 */
const neverAborts = new AbortController().signal;

/** A task as the sharer shows it to `schedule`. */
export type SharedTaskView<Input> = Readonly<
  Pick<
    TaskStart<Input>,
    "input" | "signal" | "collapsedRequestCount" | "startReason"
  >
>;

type TaskRequest<Input> = { input: Input; signal?: AbortSignal };

/** What `startOrRideTasks` returns for one task request. */
export type TaskRequestOutcome<Result, Handle> = {
  readonly result: Promise<Result>;
  readonly handle: Handle;
  readonly rode: boolean;
};

/**
 * What `startOrRideTasks` returns: one outcome per task request, at the same
 * position. A tuple of requests gives a tuple of outcomes of the same length.
 */
export type TaskRequestOutcomes<
  Requests extends readonly unknown[],
  Result,
  Handle,
> = { -readonly [K in keyof Requests]: TaskRequestOutcome<Result, Handle> };

/** The `schedule` option of a {@link TaskSharer}. */
export type ScheduleTasks<Input, Result, Handle> = (
  toStart: readonly SharedTaskView<Input>[],
) => readonly Readonly<{ result: Promise<Result>; handle: Handle }>[];

/**
 * Why a task request started a task instead of riding one:
 * - `noKey`: `makeKey` returned `undefined`, so the request never shares work.
 * - `noPendingTask`: no task for its key was pending.
 * - `pendingTaskTooOld`: the pending task for its key started more than
 *   `collapseTasksMs` ago.
 * - `pendingTaskCancelled`: the pending task for its key was cancelled.
 */
export type TaskStartReason =
  | "noKey"
  | "noPendingTask"
  | "pendingTaskTooOld"
  | "pendingTaskCancelled";

/** The parts of a task that exist before its `schedule` call returns. */
type TaskStart<Input> = {
  /**
   * Why the task request that started the task did not ride one. It is for
   * diagnostics, for example a log line that `schedule` writes.
   */
  readonly startReason: TaskStartReason;
  /**
   * Compared with `collapseTasksMs`, so no task request rides a task that is
   * too old.
   */
  readonly startedAt: number;
  /**
   * The input of the task request that STARTED the task. Task requests that
   * ride the task never replace it, so per-request labels such as a producer
   * trigger keep the starting task request's value.
   */
  readonly input: Input;
  /**
   * Aborts when every request on the task is cancelled. A task request is
   * cancelled when its own signal aborts. A task request without a signal can
   * never be cancelled, so it keeps the task's signal from aborting. Its
   * reason is the signal reason of the last request to be cancelled.
   *
   * The lookup in `startOrRideTasks` also reads it, so no request rides a
   * cancelled task.
   */
  readonly signal: AbortSignal;
  /**
   * The number of task requests that have ridden the task so far. Each one is
   * a request that sharing served without starting new work. The task request
   * that started the task does not count, and a cancelled rider still does.
   *
   * `schedule` receives this object itself, not a copy, so a reader sees
   * every ride up to the time it reads the field. A call records its rides
   * only after its `schedule` returns, so `schedule` never sees its own
   * call's rides. Only the sharer writes it: `SharedTaskView` makes it
   * readonly.
   */
  collapsedRequestCount: number;
};

/**
 * A task that its `schedule` call has scheduled. Only these tasks are in
 * `#latestPendingTaskByKey` and `#live`, so a failed `schedule` call leaves no
 * task behind.
 */
class Task<Input, Result, Handle> {
  /** The parts of the task that existed before its `schedule` call returned. */
  readonly start: TaskStart<Input>;
  /**
   * The handle that the task's `schedule` call returned. `startOrRideTasks`
   * returns it to every request on the task.
   */
  readonly handle: Handle;
  /** The result that the task's `schedule` call returned. */
  readonly result: Promise<Result>;
  /**
   * Undefined once the task can never be cancelled. That happens in three ways:
   *
   * - The task is created to handle an initial request that has no signal, and
   *   is therefore uncancelable. The task's `start.signal`, given to
   *   `schedule`, is then the shared {@link neverAborts}, and there's no
   *   controller to use to cancel it.
   *
   * - A later request has no signal. That request can never be cancelled, so
   *   neither can the task.
   *
   * - The task settles. Its work is done, and no request can ride it any more.
   *
   * In the last two cases, the task keeps its controller's signal, which
   * `schedule` already received, but nothing can abort it any more.
   */
  #cancellation:
    | {
        /** Aborts the task's unique `start.signal`. */
        readonly controller: AbortController;
        /**
         * The task's requests that are not cancelled, plus the number of
         * `hold()` calls on the task. Every one of those requests has a signal:
         * a request without one would clear `#cancellation` instead. The task's
         * signal aborts when this reaches 0.
         */
        uncancelledRequests: number;
        /**
         * The signal reason of the last request to be cancelled. The task's
         * signal aborts with it. Stored because a hold can delay the abort
         * until after that request's cancellation.
         */
        lastCancelReason: unknown;
        /**
         * The abort listeners that the task (via `addRequest`) added to
         * individual requests' signals. They are removed when the task becomes
         * uncancellable: a task request's signal can outlive the task, and its
         * listener would otherwise keep the task alive. Kept here because
         * listeners exist only while the task can be cancelled.
         */
        readonly abortListeners: [signal: AbortSignal, listener: () => void][];
      }
    | undefined;

  /**
   * @param controller The controller whose signal is `start.signal`, or
   *   undefined when the starting request has no signal.
   * @param onSettle Called once, when `result` settles, after the task has
   *   become uncancellable and removed its abort listeners.
   */
  constructor(
    start: TaskStart<Input>,
    controller: AbortController | undefined,
    { result, handle }: { result: Promise<Result>; handle: Handle },
    onSettle: () => void,
  ) {
    this.start = start;
    this.#cancellation = controller && {
      controller,
      uncancelledRequests: 0,
      lastCancelReason: undefined,
      abortListeners: [],
    };
    this.handle = handle;
    this.result = result;

    // Handling both outcomes also marks a rejection as handled: every task
    // request may be cancelled before anyone awaits the result.
    const settle = () => {
      this.#makeUncancelable();
      onSettle();
    };
    void result.then(settle, settle);
  }

  /**
   * Keeps the task's signal from aborting until `release`, even if every
   * request on the task is cancelled meanwhile. `startOrRideTasks` holds each
   * task it starts or rides until it has recorded all of its requests, so a
   * cancellation during `schedule`, or during another task's abort, cannot
   * cancel a task that a request of the call will keep alive.
   *
   * A hold counts as one uncancelled request. Holds can nest, because a
   * nested `startOrRideTasks` call can ride a task that an outer call holds.
   */
  hold() {
    if (this.#cancellation) this.#cancellation.uncancelledRequests += 1;
  }

  /**
   * Ends one `hold`. Aborts the task's signal if no request keeps the task
   * alive.
   */
  release() {
    const cancellation = this.#cancellation;
    if (cancellation === undefined) return;
    cancellation.uncancelledRequests -= 1;
    if (cancellation.uncancelledRequests === 0) {
      cancellation.controller.abort(cancellation.lastCancelReason);
    }
  }

  /**
   * Records a task request on this task, whether the request started the
   * task or rides it. `signal` and `rode` are the request's. Call it only
   * while holding the task: a request whose signal already aborted is not
   * counted, so only `release` can abort the task for it.
   */
  addRequest(signal: AbortSignal | undefined, rode: boolean) {
    if (rode) this.start.collapsedRequestCount += 1;

    // An uncancellable task needs no count: no task request can cancel it.
    const cancellation = this.#cancellation;
    if (cancellation === undefined) return;

    // A request w/o a signal can never be cancelled, so neither can the task.
    if (signal === undefined) {
      this.#makeUncancelable();
      return;
    }

    // `schedule` runs user code, so a signal can abort after `startOrRideTasks`
    // checked it.
    if (signal.aborted) {
      cancellation.lastCancelReason = signal.reason;
      return;
    }

    cancellation.uncancelledRequests += 1;
    const listener = () => {
      cancellation.lastCancelReason = signal.reason;
      this.release();
    };
    signal.addEventListener("abort", listener, { once: true });
    cancellation.abortListeners.push([signal, listener]);
  }

  /**
   * Records that the task can never be cancelled, because one of its
   * requests has no signal or because it settled. Its count and listeners
   * can no longer abort it, so this drops them. The task keeps its
   * controller's signal, which `schedule` already received, but nothing
   * aborts it any more. Calling it again does nothing.
   */
  #makeUncancelable() {
    this.#cancellation?.abortListeners.forEach(([signal, listener]) => {
      signal.removeEventListener("abort", listener);
    });
    this.#cancellation = undefined;
  }
}

/**
 * Builds a task's start, and the controller that aborts its signal. The
 * controller stays out of the start because `schedule` receives the start,
 * and only the task may abort its own signal.
 */
function newTaskStart<Input>(
  input: Input,
  cancellable: boolean,
  now: number,
  startReason: TaskStartReason,
): { start: TaskStart<Input>; controller: AbortController | undefined } {
  const controller = cancellable ? new AbortController() : undefined;
  return {
    start: {
      startReason,
      startedAt: now,
      input,
      signal: controller?.signal ?? neverAborts,
      collapsedRequestCount: 0,
    },
    controller,
  };
}

/**
 * Shares pending work between task requests whose inputs have the same key.
 * `collapsedTaskCreator` runs on it. Beyond the collapsing that
 * `collapsedTaskCreator` offers, it adds three things:
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
 * A task stops being ridable when it settles, when it is cancelled, or when
 * it started more than `collapseTasksMs` ago. A cancelled task can still be
 * running, but a new task request must not ride work that is being
 * cancelled.
 *
 * It is also the first block of a planned split of `requestScheduler`,
 * whose collapsing half it will replace. Until then, `requestScheduler` does
 * the production collapsing and keeps its own count of rides; the two counts
 * follow the same rules.
 *
 * @internal
 */
export class TaskSharer<Input, Result, Handle, Key = string> {
  readonly #collapseTasksMs: number;
  readonly #makeKey: (input: Input) => Key | undefined;
  readonly #schedule: ScheduleTasks<Input, Result, Handle>;

  /**
   * For each key, the newest pending task: the task that a new task request
   * for that key rides, unless it is too old or cancelled. A cancelled task
   * stays here until it settles or a newer task replaces it; the lookup in
   * `startOrRideTasks` checks its signal, so no request rides it. A newer
   * task replaces an older one whose start is outside `collapseTasksMs`, or
   * a cancelled one; the replaced task keeps running, tracked only in
   * `#live`.
   */
  readonly #latestPendingTaskByKey = new Map<
    Key,
    Task<Input, Result, Handle>
  >();

  /**
   * Every task that has not settled. `#latestPendingTaskByKey` leaves out two
   * kinds of unsettled task: tasks with no key, and tasks that a newer task
   * replaced. `drain` must still wait for all of them.
   */
  readonly #live = new Set<Task<Input, Result, Handle>>();

  /**
   * The keys of the tasks that a running `schedule` call is starting. Those
   * tasks enter `#latestPendingTaskByKey` only after `schedule` returns. So
   * when `schedule` runs a producer synchronously, and that producer requests
   * its own key, a nested call could not ride the task and would start it
   * again, without end. The nested call throws instead.
   *
   * Tasks with no key are never reserved, because nothing can ride them. A
   * key stays here only while its `schedule` call runs. The set holds keys
   * from several calls only while `schedule` calls nest, with different keys.
   */
  readonly #schedulingKeys = new Set<Key>();

  constructor(options: {
    /**
     * A task request rides a pending task for its input's key only if that
     * task started no more than this many milliseconds ago.
     */
    collapseTasksMs: number;
    /**
     * Converts an input into the key that decides which pending task its task
     * request may ride. Return `undefined` for an input that must not share
     * work with any other, for example because its key cannot be computed.
     * Its task request then starts its own task, which no task request can
     * ride. Keys match as `Map` keys do (SameValueZero), so an object key
     * matches only itself.
     */
    makeKey: (input: Input) => Key | undefined;
    /**
     * Schedules the tasks that one `startOrRideTasks` call starts, in task
     * request order, as one unit of work. It returns one entry per task, in
     * order: the task's result, and an opaque handle that every request on
     * the task gets back.
     *
     * Every call uses this same function, so it cannot know how the caller
     * wants the work run, for example batched with later calls or run at
     * once. Usually it only queues the work and arms a flush. A caller that
     * wants the work run at once then dispatches it, using the handles that
     * `startOrRideTasks` returns. Those handles also cover the queued tasks
     * the call rode, so one dispatch can cover all of the call's work.
     *
     * A `schedule` that runs work synchronously may call `startOrRideTasks`
     * again, for example through a producer that reads other keys. See
     * `startOrRideTasks` for the limit on that.
     */
    schedule: ScheduleTasks<Input, Result, Handle>;
  }) {
    this.#collapseTasksMs = options.collapseTasksMs;
    this.#makeKey = options.makeKey;
    this.#schedule = options.schedule;
  }

  /**
   * Finds the pending task that a task request for `key` may ride, or says
   * why there is none. A task that is both too old and cancelled reports
   * `pendingTaskTooOld`.
   */
  #findRidable(
    now: number,
    key: Key,
  ):
    | { ride: Task<Input, Result, Handle> }
    | { startReason: Exclude<TaskStartReason, "noKey"> } {
    const existing = this.#latestPendingTaskByKey.get(key);
    if (!existing) return { startReason: "noPendingTask" };
    const { signal, startedAt } = existing.start;
    if (now - startedAt > this.#collapseTasksMs) {
      return { startReason: "pendingTaskTooOld" };
    }
    if (signal.aborted) return { startReason: "pendingTaskCancelled" };
    return { ride: existing };
  }

  #setupNewTask(
    start: TaskStart<Input>,
    controller: AbortController | undefined,
    scheduleResult: Readonly<{ result: Promise<Result>; handle: Handle }>,
    key: Key | undefined,
  ) {
    const task = new Task(start, controller, scheduleResult, () => {
      this.#live.delete(task);
      // Only remove this task if the map still holds it for its key. The map
      // could hold a newer one if this task was replaced for being too old or
      // cancelled.
      if (key !== undefined && this.#latestPendingTaskByKey.get(key) === task) {
        this.#latestPendingTaskByKey.delete(key);
      }
    });

    this.#live.add(task);

    // If the key is defined, this task can be the existing pending task
    // for future requests with the same key, so register it.
    if (key !== undefined) {
      this.#latestPendingTaskByKey.set(key, task);
    }

    return task;
  }

  /**
   * Each task request rides a pending task for its input's key, or starts a
   * new task. Schedules the new tasks with one `schedule` call. When every
   * task request rides, it does not call `schedule`.
   *
   * It changes no state until `schedule` returns, except that it holds the
   * tasks it rides. So when a signal is already aborted, `makeKey` throws,
   * `schedule` throws, or `schedule` returns the wrong number of entries, it
   * releases those tasks, throws, and changes nothing else.
   *
   * It holds every task it starts or rides until it has recorded all of its
   * task requests. So when user code cancels every other request on a task
   * meanwhile, the task still is not cancelled while this call's requests
   * keep it alive.
   *
   * The tasks this call starts become ridable only after `schedule`
   * returns. A `schedule` may call `startOrRideTasks` again, for example by
   * running a producer that reads other keys. But a nested call that
   * requests a key this call is starting throws a `CacheContractError`:
   * that request depends on its own result.
   *
   * @param taskRequests Each task request's input, and an optional signal
   *   that cancels the task request.
   * @returns One entry per task request, in order. `result` is the task's
   *   shared result. It does not reject when only this task request is
   *   cancelled, because the task's other requests may still need the
   *   result; a caller races its own signal. `handle` is the handle that the
   *   task's `schedule` returned. A caller that wants its work run at once
   *   can dispatch the still-queued tasks behind these handles, including
   *   the tasks it rode.
   *   `rode` is true when the task request rode a task that it did not
   *   start.
   */
  startOrRideTasks<
    const Requests extends readonly Readonly<TaskRequest<Input>>[],
  >(taskRequests: Requests): TaskRequestOutcomes<Requests, Result, Handle> {
    // Compute every key before checking signals: `makeKey` is user code and
    // may abort a signal.
    const keys = taskRequests.map(({ input }) => this.#makeKey(input));
    taskRequests.forEach(({ signal }) => signal?.throwIfAborted());

    if (keys.some((k) => k !== undefined && this.#schedulingKeys.has(k))) {
      throw new CacheContractError(
        "schedule requested a key that it is starting a task for",
      );
    }
    // What this call does with each group of requests. `indexes` are the
    // group's positions in `taskRequests`, so results go back in request
    // order. A START with no key always has one index, because requests with
    // no key never share. A START with a key covers every request for that
    // key: the first starts the task, and the rest ride it. A RIDE covers
    // every request that rides one pending task.
    type Decision =
      | {
          type: "START";
          key: undefined;
          start: TaskStart<Input>;
          controller: AbortController | undefined;
          indexes: [number];
        }
      | {
          type: "START";
          key: Key;
          start: TaskStart<Input>;
          controller: AbortController | undefined;
          indexes: number[];
        }
      | {
          type: "RIDE";
          task: Task<Input, Result, Handle>;
          indexes: number[];
        };

    // Group. Requests with the same key share one task, so each group
    // is one task that this call touches.
    const requestsByKey = Map.groupBy(
      taskRequests.map((request, i) => ({ request, i, key: keys[i] })),
      ({ key }) => key,
    );

    // Decide. Each group rides the pending task for its key, or starts
    // a new task. The group's first request decides, as if it came alone.
    const now = Date.now();
    const decisions = requestsByKey
      .entries()
      .flatMap(([key, reqs]): Decision[] => {
        if (key === undefined) {
          return reqs.map(({ request: { input, signal }, i }) => ({
            type: "START" as const,
            key: undefined,
            ...newTaskStart(input, signal !== undefined, now, "noKey"),
            indexes: [i],
          }));
        }

        const ridableLookup = this.#findRidable(now, key);
        if ("ride" in ridableLookup) {
          return [
            {
              type: "RIDE" as const,
              task: ridableLookup.ride,
              indexes: reqs.map(({ i }) => i),
            },
          ];
        }

        const { input, signal } = reqs[0]!.request;
        return [
          {
            type: "START" as const,
            key,
            ...newTaskStart(
              input,
              signal !== undefined,
              now,
              ridableLookup.startReason,
            ),
            indexes: reqs.map(({ i }) => i),
          },
        ];
      })
      .toArray();

    // Schedule the new tasks.
    const startDecisions = decisions.filter((d) => d.type === "START");
    const taskStarts = startDecisions.map((d) => d.start);

    // The `schedule` function is user code, so we have to hold tasks that
    // other requests in this call are riding -- to make sure that schedule
    // doesn't cancel them prematurely (i.e., abort signals on their existing
    // requests). `heldTasks` collects every task this call touches: the
    // ridden tasks now, and each started task when its requests are
    // recorded. Every task stays held until this call records all of its
    // requests, because a release can abort a task and run user code.
    // Holding a task that cannot be cancelled does nothing.
    const heldTasks = new Set(
      decisions.filter((d) => d.type === "RIDE").map((d) => d.task),
    );
    heldTasks.forEach((task) => task.hold());

    try {
      // Reserve keys for the tasks we're about to schedule (to prevent
      // infinite loop on re-entrant calls).
      const scheduled = (() => {
        if (taskStarts.length === 0) {
          return [];
        }

        const scheduledKeys = new Set(
          startDecisions.map((d) => d.key).filter((key) => key !== undefined),
        );
        scheduledKeys.forEach((key) => this.#schedulingKeys.add(key));

        try {
          return this.#schedule(taskStarts);
        } finally {
          // Free the keys before any release: a release can abort a
          // task, and its abort listeners may request those keys, which are
          // ridable by then.
          scheduledKeys.forEach((key) => this.#schedulingKeys.delete(key));
        }
      })();

      if (scheduled.length !== taskStarts.length) {
        throw new CacheContractError(
          "schedule must return one scheduled task per task to start",
        );
      }

      // Create a Task for each new task, and set up the initial bookkeeping
      // for it. The map lets the record loop below, which walks RIDE and
      // START decisions interleaved, find each START's new task.
      const newTasksByStartDecision = new Map(
        zip2(startDecisions, scheduled).map(
          ([startDecision, scheduleResult]) => {
            const { start, controller, key } = startDecision;
            const task = this.#setupNewTask(
              start,
              controller,
              scheduleResult,
              key,
            );
            return [start, task];
          },
        ),
      );

      // Record every request on its task, and build one entry per
      // request, back in request order. Every request in a ridden group
      // rode; in a started group, only the first did not.
      const result = Array<TaskRequestOutcome<Result, Handle>>(
        taskRequests.length,
      );

      decisions.forEach((d) => {
        switch (d.type) {
          case "RIDE": {
            const outcome = {
              result: d.task.result,
              handle: d.task.handle,
              rode: true as const,
            };
            d.indexes.forEach((reqIdx) => {
              // NB: task is still held from before schedule()
              d.task.addRequest(taskRequests[reqIdx]!.signal, true);
              result[reqIdx] = outcome;
            });
            break;
          }
          case "START": {
            const task = newTasksByStartDecision.get(d.start)!;
            // Hold the task until every request in this call is recorded (so
            // that, e.g., an already-aborted signal on the first request
            // doesn't cancel the whole new task for subsequent requests in this
            // call). Note that, if the key is undefined, there can only be one
            // `d.indexes` and this task can never be ridden, so the hold is
            // technically redundant.
            task.hold();
            heldTasks.add(task);
            d.indexes.forEach((reqIdx, i) => {
              const rode = i > 0;
              task.addRequest(taskRequests[reqIdx]!.signal, rode);
              result[reqIdx] = {
                result: task.result,
                handle: task.handle,
                rode,
              };
            });
            break;
          }
          default:
            assertUnreachable(d);
        }
      });

      // The loop above fills every position of `result`, one per task
      // request, but TS can't prove that it matches the mapped tuple type.
      return result as TaskRequestOutcomes<Requests, Result, Handle>;
    } finally {
      heldTasks.forEach((task) => task.release());
    }
  }

  /**
   * Waits until every task has settled, including cancelled ones. It loops
   * because work that settles can start new tasks, for example a producer
   * that reads other keys. Those tasks join `#live` after the snapshot that
   * one `allSettled` waits on.
   */
  async drain(): Promise<void> {
    while (this.#live.size > 0) {
      await Promise.allSettled([...this.#live].map((task) => task.result));
    }
  }
}
