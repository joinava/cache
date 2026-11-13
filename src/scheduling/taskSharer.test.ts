import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import {
  TaskSharer,
  type ScheduleTasks as ScheduleTasksFor,
  type SharedTaskView,
} from "./taskSharer.js";

type Handle = { readonly ids: readonly string[] };
/** One call's `schedule`. It needs no context, so it takes only `toStart`. */
type ScheduleTasks = (
  toStart: Parameters<ScheduleTasksFor<string, string, Handle>>[0],
) => ReturnType<ScheduleTasksFor<string, string, Handle>>;

/**
 * A recording `schedule` that resolves each started task with its input, after
 * `release` is called. Until then, every task stays pending. Each handle names
 * the schedule call's started inputs. `seen` collects every started task's
 * view.
 */
function recordingSchedule() {
  const calls: string[][] = [];
  const seen: SharedTaskView<string>[] = [];
  const gate = Promise.withResolvers<void>();
  const schedule: ScheduleTasks = (toStart) => {
    const ids = toStart.map(({ input }) => input);
    calls.push(ids);
    seen.push(...toStart);
    return toStart.map(({ input }) => ({
      result: gate.promise.then(() => input),
      handle: { ids },
    }));
  };
  return { calls, seen, schedule, release: () => gate.resolve() };
}

/**
 * The signal that `schedule` received for a task. Fails the test when the
 * task has none, which happens only when its starting request has no signal.
 */
function signalOf(view: SharedTaskView<string>): AbortSignal {
  assert.ok(view.signal, "the task has no signal");
  return view.signal;
}

const sharing = {
  collapseTasksMs: 1_000,
  makeKey: (input: string) => input,
};

/**
 * A sharer whose `startOrRideTasks` takes the `schedule` for that call. The
 * sharer takes one `schedule` for every call, but many tests need a
 * different `schedule` per call, for example one that throws or cancels a
 * signal. Each call passes its `schedule` as the context, and the
 * constructor's `schedule` runs it.
 */
function testSharer(
  options: Pick<
    ConstructorParameters<typeof TaskSharer<string, string, Handle>>[0],
    "collapseTasksMs" | "makeKey"
  > = sharing,
) {
  return new TaskSharer<string, string, Handle, string, ScheduleTasks>({
    ...options,
    schedule: (toStart, schedule) => schedule(toStart),
  });
}

describe("TaskSharer", () => {
  it("starts one call's new tasks together, and starts nothing for riders", async () => {
    const sharer = testSharer();
    const { calls, schedule, release } = recordingSchedule();
    const startOrRideTasks = (ids: string[]) =>
      sharer.startOrRideTasks(
        ids.map((input) => ({ input })),
        schedule,
      );

    const first = startOrRideTasks(["x", "y", "z"]);
    const second = startOrRideTasks(["x", "y", "z"]);
    const third = startOrRideTasks(["x", "y", "w"]);

    // The second call rides every task, so it does not call `schedule`.
    assert.deepEqual(calls, [["x", "y", "z"], ["w"]]);
    // Every request gets the handle of the task it started or rode.
    assert.deepEqual(
      [first, second, third].map((call) => call.map(({ handle }) => handle)),
      [
        [
          { ids: ["x", "y", "z"] },
          { ids: ["x", "y", "z"] },
          { ids: ["x", "y", "z"] },
        ],
        [
          { ids: ["x", "y", "z"] },
          { ids: ["x", "y", "z"] },
          { ids: ["x", "y", "z"] },
        ],
        [{ ids: ["x", "y", "z"] }, { ids: ["x", "y", "z"] }, { ids: ["w"] }],
      ],
    );
    assert.equal(second[0]!.handle, first[0]!.handle);
    assert.deepEqual(
      [first, second, third].map((call) => call.map(({ rode }) => rode)),
      [
        [false, false, false],
        [true, true, true],
        [true, true, false],
      ],
    );
    assert.equal(second[0]!.result, first[0]!.result);

    release();
    assert.deepEqual(await Promise.all(third.map(({ result }) => result)), [
      "x",
      "y",
      "w",
    ]);
  });

  it("does not call schedule for an empty call", () => {
    const sharer = testSharer();
    const { calls, schedule } = recordingSchedule();
    assert.deepEqual(sharer.startOrRideTasks([], schedule), []);
    assert.deepEqual(calls, []);
  });

  it("collapses duplicate keys within one call onto one started task", () => {
    const sharer = testSharer();
    const { calls, schedule } = recordingSchedule();
    const results = sharer.startOrRideTasks(
      ["x", "x"].map((input) => ({ input })),
      schedule,
    );
    assert.deepEqual(calls, [["x"]]);
    assert.deepEqual(
      results.map(({ rode }) => rode),
      [false, true],
    );
  });

  it("returns entries in task request order when duplicate keys interleave", async () => {
    const sharer = testSharer();
    const { calls, schedule, release } = recordingSchedule();
    const results = sharer.startOrRideTasks(
      ["x", "y", "x"].map((input) => ({ input })),
      schedule,
    );
    assert.deepEqual(calls, [["x", "y"]]);
    assert.deepEqual(
      results.map(({ rode }) => rode),
      [false, false, true],
    );
    release();
    assert.deepEqual(await Promise.all(results.map(({ result }) => result)), [
      "x",
      "y",
      "x",
    ]);
  });

  it("never shares a task request whose input has no key", () => {
    const sharer = testSharer({
      collapseTasksMs: 1_000,
      makeKey: (input) => (input === "unkeyable" ? undefined : input),
    });
    const { calls, schedule } = recordingSchedule();
    sharer.startOrRideTasks([{ input: "unkeyable" }], schedule);
    const results = sharer.startOrRideTasks(
      [{ input: "unkeyable" }, { input: "unkeyable" }],
      schedule,
    );
    assert.deepEqual(calls, [["unkeyable"], ["unkeyable", "unkeyable"]]);
    assert.deepEqual(
      results.map(({ rode }) => rode),
      [false, false],
    );
  });

  it("tells schedule why each task started", (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const sharer = testSharer({
      collapseTasksMs: 1_000,
      makeKey: (input) => (input === "unkeyable" ? undefined : input),
    });
    const { seen, schedule } = recordingSchedule();
    const cancel = new AbortController();

    sharer.startOrRideTasks(
      [
        { input: "old" },
        { input: "cancelled", signal: cancel.signal },
        { input: "unkeyable" },
      ],
      schedule,
    );
    cancel.abort();
    t.mock.timers.tick(1_001);
    sharer.startOrRideTasks(
      [{ input: "old" }, { input: "cancelled" }],
      schedule,
    );

    assert.deepEqual(
      seen.map(({ input, startReason }) => [input, startReason]),
      [
        ["old", "noPendingTask"],
        ["cancelled", "noPendingTask"],
        ["unkeyable", "noKey"],
        ["old", "pendingTaskTooOld"],
        // A task that is both too old and cancelled reports its age.
        ["cancelled", "pendingTaskTooOld"],
      ],
    );

    const fresh = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "fresh", signal: fresh.signal }],
      schedule,
    );
    fresh.abort();
    sharer.startOrRideTasks([{ input: "fresh" }], schedule);
    assert.equal(seen.at(-1)!.startReason, "pendingTaskCancelled");
  });

  it("replaces a task older than collapseTasksMs, and the old one's settlement keeps the new one ridable", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const sharer = testSharer();
    const results: PromiseWithResolvers<string>[] = [];
    const schedule: ScheduleTasks = (toStart) =>
      toStart.map(() => {
        const result = Promise.withResolvers<string>();
        results.push(result);
        return { result: result.promise, handle: { ids: [] } };
      });
    const [old] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    t.mock.timers.tick(1_001);
    const [replacement] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(replacement!.rode, false);

    results[0]!.resolve("old");
    assert.equal(await old!.result, "old");
    const [rider] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(rider!.rode, true);
    assert.equal(rider!.result, replacement!.result);
  });

  it("aborts a task's signal only after every request on it is cancelled", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const a = new AbortController();
    const b = new AbortController();
    sharer.startOrRideTasks([{ input: "x", signal: a.signal }], schedule);
    sharer.startOrRideTasks([{ input: "x", signal: b.signal }], schedule);
    const signal = signalOf(seen[0]!);

    a.abort(new Error("a cancelled"));
    assert.equal(signal.aborted, false);
    b.abort(new Error("b cancelled"));
    assert.equal(signal.aborted, true);
    assert.deepEqual(signal.reason, new Error("b cancelled"));

    // A cancelled task is no longer ridable, even though it may still run.
    const [next] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(next!.rode, false);
    assert.equal(seen.length, 2);
  });

  it("never aborts a task that has a task request without a signal", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const controller = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }],
      schedule,
    );
    sharer.startOrRideTasks([{ input: "x" }], schedule);
    controller.abort();
    assert.equal(signalOf(seen[0]!).aborted, false);
  });

  it("makes a task uncancellable, and removes its abort listeners, when a task request without a signal joins it", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const first = new AbortController();
    const later = new AbortController();
    sharer.startOrRideTasks([{ input: "x", signal: first.signal }], schedule);
    assert.equal(getEventListeners(first.signal, "abort").length, 1);

    sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(getEventListeners(first.signal, "abort").length, 0);
    // A later rider's signal gets no listener either.
    sharer.startOrRideTasks([{ input: "x", signal: later.signal }], schedule);
    assert.equal(getEventListeners(later.signal, "abort").length, 0);

    first.abort();
    later.abort();
    assert.equal(signalOf(seen[0]!).aborted, false);
  });

  it("removes its abort listeners when the task settles", async () => {
    const sharer = testSharer();
    const { seen, schedule, release } = recordingSchedule();
    const first = new AbortController();
    const rider = new AbortController();
    const [started] = sharer.startOrRideTasks(
      [{ input: "x", signal: first.signal }],
      schedule,
    );
    sharer.startOrRideTasks([{ input: "x", signal: rider.signal }], schedule);
    assert.equal(getEventListeners(first.signal, "abort").length, 1);
    assert.equal(getEventListeners(rider.signal, "abort").length, 1);

    release();
    await started!.result;
    assert.equal(getEventListeners(first.signal, "abort").length, 0);
    assert.equal(getEventListeners(rider.signal, "abort").length, 0);

    // The settled task's signal no longer follows its requests' signals.
    first.abort();
    rider.abort();
    assert.equal(signalOf(seen[0]!).aborted, false);
  });

  it("ignores a deferred cancellation after a task request without a signal in the same call makes the task uncancellable", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const controller = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }, { input: "x" }],
      (toStart) => {
        controller.abort();
        return schedule(toStart);
      },
    );
    assert.equal(signalOf(seen[0]!).aborted, false);
    const [rider] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(rider!.rode, true);
  });

  it("gives schedule no signal for a task whose starting task request has no signal", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    sharer.startOrRideTasks([{ input: "x" }, { input: "y" }], schedule);
    const controller = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }],
      schedule,
    );
    controller.abort();

    assert.equal(seen[0]!.signal, undefined);
    assert.equal(seen[1]!.signal, undefined);
    // A rider's abort does not make the task unridable.
    const [rider] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(rider!.rode, true);
  });

  it("rejects only an already-cancelled task request, which starts and rides nothing", async () => {
    const keyed: string[] = [];
    const sharer = testSharer({
      collapseTasksMs: 1_000,
      makeKey: (input) => {
        keyed.push(input);
        return input;
      },
    });
    const { calls, schedule, release } = recordingSchedule();
    sharer.startOrRideTasks([{ input: "y" }], schedule);
    const reason = new Error("already aborted");
    const [x, y] = sharer.startOrRideTasks(
      [{ input: "x" }, { input: "y", signal: AbortSignal.abort(reason) }],
      schedule,
    );
    assert.deepEqual(calls, [["y"], ["x"]]);
    assert.deepEqual(keyed, ["y", "x"], "a cancelled request needs no key");
    assert.deepEqual(
      { handle: y!.handle, rode: y!.rode },
      { handle: undefined, rode: false },
    );
    await assert.rejects(y!.result, reason);
    release();
    assert.equal(await x!.result, "x");
  });

  it("treats a task request whose signal aborts during makeKey as cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted by makeKey");
    const sharer = testSharer({
      collapseTasksMs: 1_000,
      makeKey: (input) => {
        if (input === "x") controller.abort(reason);
        return input;
      },
    });
    const { calls, schedule } = recordingSchedule();
    const [y, x] = sharer.startOrRideTasks(
      [{ input: "y", signal: controller.signal }, { input: "x" }],
      schedule,
    );
    assert.deepEqual(calls, [["x"]]);
    assert.equal(x!.rode, false);
    await assert.rejects(y!.result, reason);
  });

  it("throws and changes nothing when schedule throws", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const rider = new AbortController();
    sharer.startOrRideTasks([{ input: "x" }], schedule);
    const failure = new Error("schedule failed");
    assert.throws(
      () =>
        sharer.startOrRideTasks(
          [{ input: "x", signal: rider.signal }, { input: "y" }],
          () => {
            throw failure;
          },
        ),
      failure,
    );
    // The failed call neither started "y" nor recorded its ride on "x".
    assert.equal(seen[0]!.collapsedRequestCount, 0);
    const [y] = sharer.startOrRideTasks([{ input: "y" }], schedule);
    assert.equal(y!.rode, false);
  });

  it("throws a contract error and changes nothing when schedule returns the wrong count", () => {
    const sharer = testSharer();
    assert.throws(() => sharer.startOrRideTasks([{ input: "x" }], () => []), {
      message: "schedule must return one scheduled task per task to start",
    });
    const { schedule } = recordingSchedule();
    const [x] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(x!.rode, false);
  });

  it("lets schedule request other keys, but throws when it requests a key it is starting", () => {
    const sharer = testSharer();
    const inner = recordingSchedule();
    const outer = recordingSchedule();
    const nested: { rode: boolean }[] = [];
    const [x] = sharer.startOrRideTasks([{ input: "x" }], (toStart) => {
      assert.throws(
        () => sharer.startOrRideTasks([{ input: "x" }], inner.schedule),
        { message: "schedule requested a key that it is starting a task for" },
      );
      nested.push(...sharer.startOrRideTasks([{ input: "y" }], inner.schedule));
      return outer.schedule(toStart);
    });
    assert.deepEqual(
      nested.map(({ rode }) => rode),
      [false],
    );
    assert.deepEqual(inner.calls, [["y"]]);
    // Once schedule returns, the key is free, and later requests ride the task.
    const [rider] = sharer.startOrRideTasks([{ input: "x" }], outer.schedule);
    assert.equal(rider!.result, x!.result);
  });

  it("frees a call's keys when its schedule throws", () => {
    const sharer = testSharer();
    assert.throws(() =>
      sharer.startOrRideTasks([{ input: "x" }], () => {
        throw new Error("schedule failed");
      }),
    );
    const { schedule } = recordingSchedule();
    const [x] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(x!.rode, false);
  });

  it("counts a signal that aborts during schedule as cancelled, after counting the call's other requests", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const early = new AbortController();
    const late = new AbortController();
    sharer.startOrRideTasks(
      [
        { input: "x", signal: early.signal },
        { input: "x", signal: late.signal },
      ],
      (toStart) => {
        early.abort(new Error("early"));
        return schedule(toStart);
      },
    );
    const signal = signalOf(seen[0]!);
    // The second request keeps the task alive.
    assert.equal(signal.aborted, false);
    late.abort(new Error("late"));
    assert.equal(signal.aborted, true);
  });

  it("keeps a ridden task alive when schedule cancels its other requests, if this call's request keeps it alive", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const first = new AbortController();
    const rider = new AbortController();
    sharer.startOrRideTasks([{ input: "x", signal: first.signal }], schedule);
    const [, ride] = sharer.startOrRideTasks(
      [{ input: "y" }, { input: "x", signal: rider.signal }],
      (toStart) => {
        first.abort(new Error("first"));
        return schedule(toStart);
      },
    );
    assert.equal(ride!.rode, true);
    const signal = signalOf(seen[0]!);
    assert.equal(signal.aborted, false);
    rider.abort(new Error("rider"));
    assert.equal(signal.aborted, true);
    assert.deepEqual(signal.reason, new Error("rider"));
  });

  it("cancels a ridden task whose requests were all cancelled during a schedule that throws", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const first = new AbortController();
    sharer.startOrRideTasks([{ input: "x", signal: first.signal }], schedule);
    assert.throws(
      () =>
        sharer.startOrRideTasks([{ input: "y" }, { input: "x" }], () => {
          first.abort(new Error("first"));
          throw new Error("schedule failed");
        }),
      { message: "schedule failed" },
    );
    assert.equal(signalOf(seen[0]!).aborted, true);
    assert.deepEqual(signalOf(seen[0]!).reason, new Error("first"));
  });

  it("does not cancel a task when another task's cancellation in the same call cancels its earlier requests", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const xFirst = new AbortController();
    const yOnly = new AbortController();
    const xRider = new AbortController();
    sharer.startOrRideTasks([{ input: "x", signal: xFirst.signal }], schedule);
    sharer.startOrRideTasks(
      // y is recorded first, so a cancellation of y could run before this
      // call's request on x is recorded.
      [
        { input: "y", signal: yOnly.signal },
        { input: "x", signal: xRider.signal },
      ],
      (toStart) => {
        signalOf(toStart[0]!).addEventListener("abort", () => xFirst.abort());
        yOnly.abort();
        return schedule(toStart);
      },
    );
    assert.equal(signalOf(seen[1]!).aborted, true);
    assert.equal(xFirst.signal.aborted, true);
    assert.equal(signalOf(seen[0]!).aborted, false);
  });

  it("aborts a task with the reason of a signal that aborted during schedule", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const controller = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }],
      (toStart) => {
        controller.abort(new Error("during schedule"));
        return schedule(toStart);
      },
    );
    assert.equal(signalOf(seen[0]!).aborted, true);
    assert.deepEqual(signalOf(seen[0]!).reason, new Error("during schedule"));
  });

  it("lets an abort listener that runs when the call releases its tasks request a key the call started", () => {
    const sharer = testSharer();
    const { calls, schedule } = recordingSchedule();
    const controller = new AbortController();
    const nested: { rode: boolean }[] = [];
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }],
      (toStart) => {
        signalOf(toStart[0]!).addEventListener("abort", () => {
          nested.push(...sharer.startOrRideTasks([{ input: "x" }], schedule));
        });
        controller.abort();
        return schedule(toStart);
      },
    );
    // The cancelled task is not ridable, so the nested call starts a new one.
    assert.deepEqual(
      nested.map(({ rode }) => rode),
      [false],
    );
    assert.deepEqual(calls, [["x"], ["x"]]);
  });

  it("counts every task request that rides a task, across calls", () => {
    const sharer = testSharer();
    const { seen, schedule } = recordingSchedule();
    const controller = new AbortController();
    // The duplicate rides the task that its own call starts.
    sharer.startOrRideTasks([{ input: "x" }, { input: "x" }], schedule);
    assert.equal(seen[0]!.collapsedRequestCount, 1);
    sharer.startOrRideTasks(
      [
        { input: "x" },
        { input: "y" },
        { input: "x", signal: controller.signal },
      ],
      schedule,
    );
    // A cancelled rider still counts.
    controller.abort();
    assert.equal(seen[0]!.collapsedRequestCount, 3);
    assert.equal(seen[1]!.collapsedRequestCount, 0);
  });

  it("drain waits for cancelled tasks that are still running", async () => {
    const sharer = testSharer();
    const { schedule, release } = recordingSchedule();
    const controller = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }],
      schedule,
    );
    controller.abort();

    const order: string[] = [];
    const drained = sharer.drain().then(() => order.push("drained"));
    await Promise.resolve();
    order.push("released");
    release();
    await drained;
    assert.deepEqual(order, ["released", "drained"]);
  });
});
