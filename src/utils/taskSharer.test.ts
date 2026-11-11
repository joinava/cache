import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTaskSharer, type SharedTaskView } from "./taskSharer.js";

type Handle = { readonly ids: readonly string[] };
type ScheduleTasks = Parameters<
  ReturnType<
    typeof createTaskSharer<string, string, Handle>
  >["startOrRideTasks"]
>[1];

/**
 * A recording `schedule` that resolves each started task with its input, after
 * `release` is called. Until then, every task stays pending. Each handle names
 * the schedule call's started inputs. `seen` collects every started task's
 * view.
 */
function recordingSchedule() {
  const calls: { toStart: string[]; toRide: Handle[] }[] = [];
  const seen: SharedTaskView<string>[] = [];
  const gate = Promise.withResolvers<void>();
  const schedule: ScheduleTasks = (toStart, toRide) => {
    const ids = toStart.map(({ input }) => input);
    calls.push({ toStart: ids, toRide: toRide.map(({ handle }) => handle) });
    seen.push(...toStart);
    return toStart.map(({ input }) => ({
      result: gate.promise.then(() => input),
      handle: { ids },
    }));
  };
  return { calls, seen, schedule, release: () => gate.resolve() };
}

const sharing = {
  collapseTasksMs: 1_000,
  makeKey: (input: string) => input,
};

describe("createTaskSharer", () => {
  it("starts one call's new tasks together, and starts nothing for riders", async () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { calls, schedule, release } = recordingSchedule();
    const startOrRideTasks = (ids: string[]) =>
      sharer.startOrRideTasks(
        ids.map((input) => ({ input })),
        schedule,
      );

    const first = startOrRideTasks(["x", "y", "z"]);
    const second = startOrRideTasks(["x", "y", "z"]);
    const third = startOrRideTasks(["x", "y", "w"]);

    assert.deepEqual(calls, [
      { toStart: ["x", "y", "z"], toRide: [] },
      // The second call rides every task. `schedule` still runs, so a direct
      // caller can pull queued work in, but it starts nothing.
      {
        toStart: [],
        toRide: [
          { ids: ["x", "y", "z"] },
          { ids: ["x", "y", "z"] },
          { ids: ["x", "y", "z"] },
        ],
      },
      {
        toStart: ["w"],
        toRide: [{ ids: ["x", "y", "z"] }, { ids: ["x", "y", "z"] }],
      },
    ]);
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

  it("does not call schedule when there is nothing to start or ride", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { calls, schedule } = recordingSchedule();
    assert.deepEqual(sharer.startOrRideTasks([], schedule), []);
    assert.deepEqual(calls, []);
  });

  it("collapses duplicate keys within one call onto one started task", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { calls, schedule } = recordingSchedule();
    const results = sharer.startOrRideTasks(
      ["x", "x"].map((input) => ({ input })),
      schedule,
    );
    assert.deepEqual(calls, [{ toStart: ["x"], toRide: [] }]);
    assert.deepEqual(
      results.map(({ rode }) => rode),
      [false, true],
    );
  });

  it("never shares a task request whose input has no key", () => {
    const sharer = createTaskSharer<string, string, Handle>({
      collapseTasksMs: 1_000,
      makeKey: (input) => (input === "unkeyable" ? undefined : input),
    });
    const { calls, schedule } = recordingSchedule();
    sharer.startOrRideTasks([{ input: "unkeyable" }], schedule);
    const results = sharer.startOrRideTasks(
      [{ input: "unkeyable" }, { input: "unkeyable" }],
      schedule,
    );
    assert.deepEqual(calls, [
      { toStart: ["unkeyable"], toRide: [] },
      { toStart: ["unkeyable", "unkeyable"], toRide: [] },
    ]);
    assert.deepEqual(
      results.map(({ rode }) => rode),
      [false, false],
    );
  });

  it("replaces a task older than collapseTasksMs, and the old one's settlement keeps the new one ridable", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const sharer = createTaskSharer<string, string, Handle>(sharing);
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
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { seen, schedule } = recordingSchedule();
    const a = new AbortController();
    const b = new AbortController();
    sharer.startOrRideTasks([{ input: "x", signal: a.signal }], schedule);
    sharer.startOrRideTasks([{ input: "x", signal: b.signal }], schedule);
    const signal = seen[0]!.signal;

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
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { seen, schedule } = recordingSchedule();
    const controller = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }],
      schedule,
    );
    sharer.startOrRideTasks([{ input: "x" }], schedule);
    controller.abort();
    assert.equal(seen[0]!.signal.aborted, false);
  });

  it("gives every task whose starting task request has no signal one shared signal that never aborts", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { seen, schedule } = recordingSchedule();
    sharer.startOrRideTasks([{ input: "x" }, { input: "y" }], schedule);
    const controller = new AbortController();
    sharer.startOrRideTasks(
      [{ input: "x", signal: controller.signal }],
      schedule,
    );
    controller.abort();

    assert.equal(seen[0]!.signal, seen[1]!.signal);
    assert.equal(seen[0]!.signal.aborted, false);
    // A rider's abort does not make the task unridable.
    const [rider] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(rider!.rode, true);
  });

  it("validates every task request before it changes any state", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { calls, schedule } = recordingSchedule();
    const reason = new Error("already aborted");
    assert.throws(
      () =>
        sharer.startOrRideTasks(
          [{ input: "x" }, { input: "y", signal: AbortSignal.abort(reason) }],
          schedule,
        ),
      reason,
    );
    assert.deepEqual(calls, []);
    const [x] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(x!.rode, false);
  });

  it("throws and changes nothing when schedule throws", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
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
    assert.equal(seen[0]!.collapsedRequestCount(), 0);
    const [y] = sharer.startOrRideTasks([{ input: "y" }], schedule);
    assert.equal(y!.rode, false);
  });

  it("throws a contract error and changes nothing when schedule returns the wrong count", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    assert.throws(() => sharer.startOrRideTasks([{ input: "x" }], () => []), {
      message: "schedule must return one scheduled task per task to start",
    });
    const { schedule } = recordingSchedule();
    const [x] = sharer.startOrRideTasks([{ input: "x" }], schedule);
    assert.equal(x!.rode, false);
  });

  it("lets schedule request other keys, but throws when it requests a key it is starting", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const inner = recordingSchedule();
    const outer = recordingSchedule();
    const nested: { rode: boolean }[] = [];
    const [x] = sharer.startOrRideTasks([{ input: "x" }], (toStart, toRide) => {
      assert.throws(
        () => sharer.startOrRideTasks([{ input: "x" }], inner.schedule),
        { message: "schedule requested a key that it is starting a task for" },
      );
      nested.push(...sharer.startOrRideTasks([{ input: "y" }], inner.schedule));
      return outer.schedule(toStart, toRide);
    });
    assert.deepEqual(
      nested.map(({ rode }) => rode),
      [false],
    );
    assert.deepEqual(inner.calls, [{ toStart: ["y"], toRide: [] }]);
    // Once schedule returns, the key is free, and later requests ride the task.
    const [rider] = sharer.startOrRideTasks([{ input: "x" }], outer.schedule);
    assert.equal(rider!.result, x!.result);
  });

  it("frees a call's keys when its schedule throws", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
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
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { seen, schedule } = recordingSchedule();
    const early = new AbortController();
    const late = new AbortController();
    sharer.startOrRideTasks(
      [
        { input: "x", signal: early.signal },
        { input: "x", signal: late.signal },
      ],
      (toStart, toRide) => {
        early.abort(new Error("early"));
        return schedule(toStart, toRide);
      },
    );
    const signal = seen[0]!.signal;
    // The second request keeps the task alive.
    assert.equal(signal.aborted, false);
    late.abort(new Error("late"));
    assert.equal(signal.aborted, true);
  });

  it("counts every task request that rides a task, across calls", () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
    const { seen, schedule } = recordingSchedule();
    const controller = new AbortController();
    // The duplicate rides the task that its own call starts.
    sharer.startOrRideTasks([{ input: "x" }, { input: "x" }], schedule);
    assert.equal(seen[0]!.collapsedRequestCount(), 1);
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
    assert.equal(seen[0]!.collapsedRequestCount(), 3);
    assert.equal(seen[1]!.collapsedRequestCount(), 0);
  });

  it("drain waits for cancelled tasks that are still running", async () => {
    const sharer = createTaskSharer<string, string, Handle>(sharing);
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
