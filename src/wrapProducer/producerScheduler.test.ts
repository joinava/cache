import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ConcurrencyLimiter, type DispatchInfo } from "@zingage/scheduling";

import {
  batchingSender,
  createProducerScheduler,
  immediateSender,
  type DispatchedRequest,
} from "./producerScheduler.js";

const options = { timeout: 5_000 };

/**
 * A dispatch whose invocations stay open until the test releases them. It
 * records each invocation's requests, and how many ran at one time.
 */
const gatedDispatch = () => {
  const calls: {
    values: string[];
    info: DispatchInfo;
    queueWaitMs: number[];
    release: () => void;
  }[] = [];
  const counts = { running: 0, maxRunning: 0 };
  return {
    calls,
    counts,
    dispatch: async (
      tasks: readonly DispatchedRequest<string>[],
      info: DispatchInfo,
    ) => {
      const values = tasks.map(({ request }) => request);
      const gate = Promise.withResolvers<void>();
      calls.push({
        values,
        info,
        queueWaitMs: tasks.map(({ queueWaitMs }) => queueWaitMs),
        release: gate.resolve,
      });
      counts.running += 1;
      counts.maxRunning = Math.max(counts.maxRunning, counts.running);
      await gate.promise;
      counts.running -= 1;
      return values;
    },
  };
};

const sharing = { collapseTasksMs: 1_000, makeKey: (work: string) => work };

/** A batching scheduler whose automatic batches wait for `runBatches`. */
const manualBatching = (
  dispatch: ReturnType<typeof gatedDispatch>["dispatch"],
  extra: { limiter?: ConcurrencyLimiter; maxBatchSize?: number } = {},
) => {
  const scheduled: (() => void)[] = [];
  const scheduler = createProducerScheduler(
    sharing,
    batchingSender({
      dispatch,
      limiter: extra.limiter,
      logger: undefined,
      batching: {
        batchScheduleFn: (run) => scheduled.push(run),
        ...(extra.maxBatchSize === undefined
          ? {}
          : { maxBatchSize: extra.maxBatchSize }),
      },
    }),
  );
  return {
    scheduler,
    runBatches: () => {
      scheduled.splice(0).forEach((run) => run());
    },
  };
};

describe("the sharing window", options, () => {
  it("runs from the producer invocation, so a waiting task stays ridable", (t) => {
    mock.timers.enable({ apis: ["Date"] });
    t.after(() => mock.timers.reset());
    const { dispatch, calls } = gatedDispatch();
    const { scheduler, runBatches } = manualBatching(dispatch);

    const [first] = scheduler.startOrRideTasks([{ request: "a" }]);
    // The task waits in its batch for longer than the window.
    mock.timers.tick(5_000);
    const [whileWaiting] = scheduler.startOrRideTasks([{ request: "a" }]);
    assert.equal(whileWaiting!.rode, true);

    runBatches();
    mock.timers.tick(1_000);
    const [inWindow] = scheduler.startOrRideTasks([{ request: "a" }]);
    assert.equal(inWindow!.rode, true);

    mock.timers.tick(1);
    const [afterWindow] = scheduler.startOrRideTasks([{ request: "a" }]);
    assert.equal(afterWindow!.rode, false);
    assert.equal(first!.rode, false);

    runBatches();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["a"]],
    );
    calls.forEach(({ release }) => release());
  });

  it("covers a task that waits for a slot under a limiter", async () => {
    const { dispatch, calls } = gatedDispatch();
    const scheduler = createProducerScheduler(
      { ...sharing, collapseTasksMs: 0 },
      immediateSender({ dispatch, limiter: new ConcurrencyLimiter(1) }),
    );

    const [running] = scheduler.startOrRideTasks([{ request: "a" }]);
    const [waiting] = scheduler.startOrRideTasks([{ request: "b" }]);
    await nextTurn();
    // "b" waits for the slot. With a window of 0 ms, only a waiting task can
    // still be ridden a turn later.
    const [rider] = scheduler.startOrRideTasks([{ request: "b" }]);
    assert.equal(rider!.rode, true);

    calls[0]!.release();
    await running!.promise;
    await nextTurn();
    calls[1]!.release();
    assert.deepEqual(await Promise.all([waiting!.promise, rider!.promise]), [
      "b",
      "b",
    ]);
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["b"]],
    );
    await scheduler.close();
  });
});

describe("joinInFlight: false", options, () => {
  it("rides a waiting task, but not one whose invocation has started", async () => {
    const { dispatch, calls } = gatedDispatch();
    const { scheduler, runBatches } = manualBatching(dispatch);

    const [first] = scheduler.startOrRideTasks([{ request: "a" }]);
    const [whileWaiting] = scheduler.startOrRideTasks([
      { request: "a", joinInFlight: false },
    ]);
    assert.equal(whileWaiting!.rode, true);

    runBatches();
    const [afterInvocation] = scheduler.startOrRideTasks([
      { request: "a", joinInFlight: false },
    ]);
    assert.equal(afterInvocation!.rode, false);
    // A later ordinary request rides the newer task, which still waits.
    const [later] = scheduler.startOrRideTasks([{ request: "a" }]);
    assert.equal(later!.rode, true);
    assert.equal(later!.promise, afterInvocation!.promise);
    assert.notEqual(later!.promise, first!.promise);

    runBatches();
    calls.forEach(({ release }) => release());
    await scheduler.close();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["a"]],
    );
  });

  it("never rides an invocation of a sender that invokes at once", async () => {
    const { dispatch, calls } = gatedDispatch();
    const scheduler = createProducerScheduler(
      sharing,
      immediateSender({ dispatch, limiter: undefined }),
    );

    scheduler.startOrRideTasks([{ request: "a" }]);
    const [ordinary] = scheduler.startOrRideTasks([{ request: "a" }]);
    const [fresh] = scheduler.startOrRideTasks([
      { request: "a", joinInFlight: false },
    ]);
    // Requests of one call always share one task.
    const sameCall = scheduler.startOrRideTasks([
      { request: "b", joinInFlight: false },
      { request: "b", joinInFlight: false },
    ]);

    assert.equal(ordinary!.rode, true);
    assert.equal(fresh!.rode, false);
    assert.deepEqual(
      sameCall.map(({ rode }) => rode),
      [false, true],
    );
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["a"], ["b"]],
    );
    calls.forEach(({ release }) => release());
    await scheduler.close();
  });
});

describe("a limiter", options, () => {
  it("limits an immediate sender, in arrival order, and reports the wait", async () => {
    const { dispatch, calls, counts } = gatedDispatch();
    const scheduler = createProducerScheduler(
      sharing,
      immediateSender({ dispatch, limiter: new ConcurrencyLimiter(2) }),
    );

    const outcomes = scheduler.startOrRideTasks(
      ["a", "b", "c", "d"].map((request) => ({ request })),
    );
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["b"]],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls[0]!.release();
    await outcomes[0]!.promise;
    await nextTurn();
    assert.deepEqual(calls[2]!.values, ["c"]);
    assert.ok(calls[2]!.queueWaitMs[0]! >= 15);
    assert.deepEqual(calls[0]!.queueWaitMs, [0]);

    calls[1]!.release();
    calls[2]!.release();
    await outcomes[2]!.promise;
    await nextTurn();
    calls[3]!.release();
    await scheduler.close();
    assert.equal(counts.maxRunning, 2);
    assert.deepEqual(
      await Promise.all(outcomes.map(({ promise }) => promise)),
      ["a", "b", "c", "d"],
    );
  });

  it("drops a waiting task when every request on it is cancelled", async () => {
    const { dispatch, calls } = gatedDispatch();
    const scheduler = createProducerScheduler(
      sharing,
      immediateSender({ dispatch, limiter: new ConcurrencyLimiter(1) }),
    );
    const controller = new AbortController();
    const reason = new Error("stop");

    const [running] = scheduler.startOrRideTasks([{ request: "a" }]);
    const [cancelled] = scheduler.startOrRideTasks([
      { request: "b", signal: controller.signal },
    ]);
    const [kept] = scheduler.startOrRideTasks([{ request: "c" }]);
    controller.abort(reason);
    await assert.rejects(cancelled!.promise, reason);

    calls[0]!.release();
    await running!.promise;
    await nextTurn();
    calls[1]!.release();
    await kept!.promise;
    await scheduler.close();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["c"]],
    );
  });

  it("fills a waiting batch instead of opening more invocations", async () => {
    const { dispatch, calls, counts } = gatedDispatch();
    const { scheduler, runBatches } = manualBatching(dispatch, {
      limiter: new ConcurrencyLimiter(1),
      maxBatchSize: 3,
    });

    const first = scheduler.startOrRideTasks([{ request: "a" }]);
    runBatches();
    // The next batch is due while the first invocation runs. It keeps taking
    // tasks until it is full.
    const second = scheduler.startOrRideTasks([{ request: "b" }]);
    runBatches();
    const more = scheduler.startOrRideTasks(
      ["c", "d", "e"].map((request) => ({ request })),
    );
    runBatches();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"]],
    );

    calls[0]!.release();
    await first[0]!.promise;
    // The slot frees when the invocation settles, just after its results.
    await nextTurn();
    assert.deepEqual(calls[1]!.values, ["b", "c", "d"]);
    calls[1]!.release();
    await second[0]!.promise;
    await nextTurn();
    calls[2]!.release();
    await Promise.all(more.map(({ promise }) => promise));
    await scheduler.close();

    assert.deepEqual(calls[2]!.values, ["e"]);
    assert.equal(counts.maxRunning, 1);
  });

  it("makes a direct call wait for a slot, unsplit", async () => {
    const { dispatch, calls } = gatedDispatch();
    const { scheduler, runBatches } = manualBatching(dispatch, {
      limiter: new ConcurrencyLimiter(1),
      maxBatchSize: 1,
    });

    const [running] = scheduler.startOrRideTasks([{ request: "a" }]);
    runBatches();
    const direct = scheduler.startOrRideDirect!(
      ["b", "c", "d"].map((request) => ({ request })),
    );
    await nextTurn();
    assert.equal(calls.length, 1);
    // The direct call's tasks wait, so another request can ride them.
    const [rider] = scheduler.startOrRideTasks([{ request: "c" }]);
    assert.equal(rider!.rode, true);

    calls[0]!.release();
    await running!.promise;
    await nextTurn();
    assert.deepEqual(calls[1]!.values, ["b", "c", "d"]);
    assert.deepEqual(calls[1]!.info, { autoBatched: false });
    calls[1]!.release();
    await Promise.all(direct.map(({ promise }) => promise));
    await scheduler.close();
    assert.equal(calls.length, 2);
  });
});
