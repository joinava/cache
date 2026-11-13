import { partition } from "es-toolkit";
import { assertUnreachable, CacheContractError } from "../utils/utils.js";

/** A task as the sharer shows it to `schedule`. */
export type SharedTaskView<Input> = Readonly<
  Pick<
    TaskStart<Input>,
    "input" | "signal" | "collapsedRequestCount" | "startReason"
  >
>;

type TaskRequest<Input> = { input: Input; signal?: AbortSignal | undefined };

/** What `startOrRideTasks` returns for one task request. */
export type TaskRequestOutcome<Result, Handle> = {
  readonly result: Promise<Result>;
  /**
   * The handle of the request's task. Undefined for a request that was
   * already cancelled, which gets no task.
   */
  readonly handle: Handle | undefined;
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

/**
 * The `schedule` option of a {@link TaskSharer}. `context` is the value the
 * `startOrRideTasks` call passed.
 */
export type ScheduleTasks<Input, Result, Handle, Context = void> = (
  toStart: readonly SharedTaskView<Input>[],
  context: Context,
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
   * Undefined when the request that started the task has no signal: the task
   * can never be cancelled, so it needs no signal, and `schedule` skips any
   * cancellation work. The converse does not hold. A defined signal can still
   * never abort, when a later request without a signal makes the task
   * uncancellable after `schedule` received the signal.
   *
   * The lookup in `startOrRideTasks` also reads it, so no request rides a
   * cancelled task.
   */
  readonly signal: AbortSignal | undefined;
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
   * Undefined once the task can never be cancelled: from the start when its
   * starting request has no signal, after a later request without a signal
   * (see `SharedTaskView.signal`), or once the task settles. In the last two
   * cases, the task keeps the signal that `schedule` already received, but
   * nothing can abort it any more.
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
   * It is inert on an uncancellable task, which has no signal to abort.
   */
  hold() {
    if (this.#cancellation) this.#cancellation.uncancelledRequests += 1;
  }

  /**
   * Ends one `hold`. Aborts the task's signal if no request keeps the task
   * alive. Like `hold`, it is inert on an uncancellable task.
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
   * Clears `#cancellation`, and removes its abort listeners, which can no
   * longer abort the task. Calling it again does nothing.
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
      signal: controller?.signal,
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
 * - Each task has an optional AbortSignal that aborts when every request on the
 *   task is cancelled. `schedule` passes it to whatever runs the work, such as
 *   a batcher's queue or a producer that supports cancellation. See
 *   `SharedTaskView.signal`.
 * - It counts the task requests that ride each task, for diagnostics.
 *
 * Terms:
 * - An input is the value that a task's work needs, such as a producer request.
 *   `makeKey` derives its key.
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
 * A task stops being ridable when it settles, when it is cancelled, or when it
 * started more than `collapseTasksMs` ago. A cancelled task can still be
 * running, but a new task request must not ride work that is being cancelled.
 *
 * @internal
 */
export class TaskSharer<Input, Result, Handle, Key = string, Context = void> {
  readonly #collapseTasksMs: number;
  readonly #makeKey: (input: Input) => Key | undefined;
  readonly #schedule: ScheduleTasks<Input, Result, Handle, Context>;

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
     * Every call uses this same function. It receives the `context` that the
     * `startOrRideTasks` call passed, for example to learn how the caller
     * wants the work run: batched with later calls, or at once. Usually it
     * only queues the work and arms a flush. A caller that wants the work run
     * at once then dispatches it, using the handles that `startOrRideTasks`
     * returns. Those handles also cover the queued tasks the call rode, so
     * one dispatch can cover all of the call's work.
     *
     * A `schedule` that runs work synchronously may call `startOrRideTasks`
     * again, for example through a producer that reads other keys. See
     * `startOrRideTasks` for the limit on that.
     */
    schedule: ScheduleTasks<Input, Result, Handle, Context>;
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
    if (signal?.aborted) return { startReason: "pendingTaskCancelled" };
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
   * A task request whose signal is already aborted, or aborts during
   * `makeKey`, starts and rides nothing. Its `result` rejects with the
   * signal's reason, and the call's other task requests are not affected.
   *
   * It changes no state until `schedule` returns, except that it holds the
   * tasks it rides. So when `makeKey` throws, `schedule` throws, or
   * `schedule` returns the wrong number of entries, it releases those tasks,
   * throws, and changes nothing else. It also holds
   * each task it starts until it has recorded all of its task requests (see
   * `Task.hold`).
   *
   * The tasks this call starts become ridable only after `schedule`
   * returns. A `schedule` may call `startOrRideTasks` again, for example by
   * running a producer that reads other keys. But a nested call that
   * requests a key this call is starting throws a `CacheContractError`:
   * that request depends on its own result.
   *
   * @param taskRequests Each task request's input, and an optional signal
   *   that cancels the task request.
   * @param context Passed unchanged to `schedule`, if this call starts any
   *   task. A nested call passes its own context. A sharer whose `schedule`
   *   needs none keeps the default `Context`, `void`, so its callers omit
   *   it. TypeScript lets a caller omit a trailing argument only when its
   *   type accepts `void`; `undefined` does not count.
   * @returns One entry per task request, in order. `result` is the task's
   *   shared result. It does not reject when only this task request is
   *   cancelled, because the task's other requests may still need the
   *   result; a caller races its own signal. `handle` is the handle that the
   *   task's `schedule` returned. A caller that wants its work run at once
   *   can dispatch the still-queued tasks behind these handles, including
   *   the tasks it rode. It is undefined for a cancelled task request.
   *   `rode` is true when the task request rode a task that it did not
   *   start.
   */
  startOrRideTasks<
    const Requests extends readonly Readonly<TaskRequest<Input>>[],
  >(
    taskRequests: Requests,
    context: Context,
  ): TaskRequestOutcomes<Requests, Result, Handle> {
    // A cancelled task request needs no key. Signals are read again after
    // every key: `makeKey` is user code and may abort a signal.
    const keys = taskRequests.map(({ input, signal }) =>
      signal?.aborted ? undefined : this.#makeKey(input),
    );
    // A cancelled task request starts and rides nothing, and gets only its
    // own rejection. The split happens once, here, so that a later abort
    // cannot change which requests this call treats as cancelled.
    const [cancelled, live] = partition(
      taskRequests.map((request, i) => ({ request, i, key: keys[i] })),
      ({ request: { signal } }) => signal?.aborted === true,
    );

    if (
      live.some(({ key }) => key !== undefined && this.#schedulingKeys.has(key))
    ) {
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
    const requestsByKey = Map.groupBy(live, ({ key }) => key);

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

    // Every task this call touches, held as `Task.hold` describes: the
    // ridden tasks now, and each started task when its requests are
    // recorded. All releases wait until the end, because a release can abort
    // a task and run user code.
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
          return this.#schedule(taskStarts, context);
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
        startDecisions.map((startDecision, i) => {
          const { start, controller, key } = startDecision;
          const task = this.#setupNewTask(
            start,
            controller,
            scheduled[i]!,
            key,
          );
          return [start, task];
        }),
      );

      // Record every request on its task, and build one entry per
      // request, back in request order. Every request in a ridden group
      // rode; in a started group, only the first did not.
      const result = Array<TaskRequestOutcome<Result, Handle>>(
        taskRequests.length,
      );

      cancelled.forEach(({ request: { signal }, i }) => {
        // An aborted signal's reason never changes.
        const rejected = Promise.reject(signal?.reason);
        // A caller may never await it.
        void rejected.catch(() => {});
        result[i] = { result: rejected, handle: undefined, rode: false };
      });

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
            // See `heldTasks`. Redundant when the key is undefined: that task
            // has exactly one request, and nothing can ride it.
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
