import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { BatchOptions } from "@zingage/scheduling";

import {
  createProducerScheduler,
  type ProducerItem,
  type ProducerRequest,
  type ProducerScheduler,
} from "./producerScheduler.js";
import { queueWaitMs } from "../utils/utils.js";

const options = { timeout: 5_000 };

type Call = ProducerRequest<string>["call"];

/**
 * An invoke whose producer calls stay open until the test releases them. It
 * records each call's work, and how many calls ran at one time.
 */
const gatedInvoke = () => {
  const calls: {
    values: string[];
    autoBatched: boolean;
    queueWaitMs: number[];
    release: () => void;
  }[] = [];
  const counts = { running: 0, maxRunning: 0 };
  return {
    calls,
    counts,
    invoke: async (
      items: readonly ProducerItem<string, string>[],
      { autoBatched }: { autoBatched: boolean },
    ) => {
      const values = items.map(({ input }) => input.work);
      const gate = Promise.withResolvers<void>();
      calls.push({
        values,
        autoBatched,
        queueWaitMs: items.map(queueWaitMs),
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

/** An invoke that records each call, and returns each item's work at once. */
const echoInvoke = () => {
  const calls: { values: string[]; autoBatched: boolean }[] = [];
  return {
    calls,
    invoke: async (
      items: readonly ProducerItem<string, string>[],
      { autoBatched }: { autoBatched: boolean },
    ) => {
      const values = items.map(({ input }) => input.work);
      calls.push({ values, autoBatched });
      return await Promise.resolve(values);
    },
  };
};

const defaults: {
  sharingWindowMs: number;
  keyOf: (work: string) => string | undefined;
  maxConcurrentCalls: number | undefined;
} = {
  sharingWindowMs: 1_000,
  keyOf: (work) => work,
  maxConcurrentCalls: undefined,
};

/** A scheduler for a producer that takes one request per call. */
const oneByOneScheduler = (
  invoke: ReturnType<typeof gatedInvoke>["invoke"],
  extra: { maxConcurrentCalls?: number; sharingWindowMs?: number } = {},
) =>
  createProducerScheduler<string, string>({
    ...defaults,
    ...extra,
    batching: undefined,
    invoke,
  });

/** A batching scheduler whose accumulated work waits for `runBatches`. */
const manualBatching = (
  invoke: ReturnType<typeof gatedInvoke>["invoke"],
  extra: { maxConcurrentCalls?: number; maxBatchSize?: number } = {},
) => {
  const scheduled: (() => void)[] = [];
  const batching: BatchOptions = {
    batchScheduleFn: (run) => scheduled.push(run),
    ...(extra.maxBatchSize === undefined
      ? {}
      : { maxBatchSize: extra.maxBatchSize }),
  };
  const scheduler = createProducerScheduler<string, string>({
    ...defaults,
    maxConcurrentCalls: extra.maxConcurrentCalls,
    batching,
    invoke,
  });
  return {
    scheduler,
    /**
     * Makes the accumulated work ready, and waits until the dispatcher has
     * started the calls that can start.
     */
    runBatches: async () => {
      scheduled.splice(0).forEach((run) => run());
      await nextTurn();
    },
  };
};

/** Requests `work`. Every request is its own public call unless `call` is given. */
const request = (
  scheduler: ProducerScheduler<string, string>,
  work: string,
  extra: { call?: Call; signal?: AbortSignal } = {},
) => scheduler.request({ work, call: extra.call ?? {} }, extra.signal);

const FRESH: Call = { joinInFlight: false };

describe("the sharing window", options, () => {
  it("runs from the producer call's start, so waiting work stays joinable", async (t) => {
    const clock = { now: 1_000 };
    t.mock.method(performance, "now", () => clock.now);
    const { invoke, calls } = gatedInvoke();
    const { scheduler, runBatches } = manualBatching(invoke);

    const first = request(scheduler, "a");
    // The work waits in its batch for longer than the window.
    clock.now += 5_000;
    const whileWaiting = request(scheduler, "a");
    assert.equal(whileWaiting.joined, true);

    await runBatches();
    clock.now += 1_000;
    const inWindow = request(scheduler, "a");
    assert.equal(inWindow.joined, true);

    clock.now += 1;
    const afterWindow = request(scheduler, "a");
    assert.equal(afterWindow.joined, false);
    assert.equal(first.joined, false);

    await runBatches();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["a"]],
    );
    calls.forEach(({ release }) => release());
    await scheduler.close();
  });

  it("covers work that waits for a slot under a call limit", async () => {
    const { invoke, calls } = gatedInvoke();
    const scheduler = oneByOneScheduler(invoke, {
      maxConcurrentCalls: 1,
      sharingWindowMs: 0,
    });

    const running = request(scheduler, "a");
    const waiting = request(scheduler, "b");
    await nextTurn();
    // "b" waits for the slot. With a window of 0 ms, only waiting work can
    // still be joined a turn later.
    const joiner = request(scheduler, "b");
    assert.equal(joiner.joined, true);

    calls[0]!.release();
    await running.result;
    await nextTurn();
    calls[1]!.release();
    assert.deepEqual(await Promise.all([waiting.result, joiner.result]), [
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
  it("joins waiting work, but not work whose producer call has started", async () => {
    const { invoke, calls } = gatedInvoke();
    const { scheduler, runBatches } = manualBatching(invoke);

    const first = request(scheduler, "a");
    const whileWaiting = request(scheduler, "a", { call: FRESH });
    assert.equal(whileWaiting.joined, true);

    await runBatches();
    const afterStart = request(scheduler, "a", { call: { ...FRESH } });
    assert.equal(afterStart.joined, false);
    assert.equal(afterStart.startReason, "inFlight");
    // A later ordinary request joins the newer work, which still waits.
    const later = request(scheduler, "a");
    assert.equal(later.joined, true);
    assert.equal(later.item, afterStart.item);
    assert.notEqual(later.item, first.item);

    await runBatches();
    calls.forEach(({ release }) => release());
    await scheduler.close();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["a"]],
    );
  });

  it("never joins another call's work when each producer call starts at once", async () => {
    const { invoke, calls } = gatedInvoke();
    const scheduler = oneByOneScheduler(invoke);

    request(scheduler, "a");
    const ordinary = request(scheduler, "a");
    const fresh = request(scheduler, "a", { call: { ...FRESH } });
    // The requests of one call join the work that the call itself started,
    // although its producer call has started.
    const sameCall: Call = { ...FRESH };
    const fromOneCall = [
      request(scheduler, "b", { call: sameCall }),
      request(scheduler, "b", { call: sameCall }),
    ];

    assert.equal(ordinary.joined, true);
    assert.equal(fresh.joined, false);
    assert.deepEqual(
      fromOneCall.map(({ joined }) => joined),
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

describe("a call limit", options, () => {
  it("limits one-by-one calls, in arrival order, and reports the wait", async () => {
    const { invoke, calls, counts } = gatedInvoke();
    const scheduler = oneByOneScheduler(invoke, { maxConcurrentCalls: 2 });

    const outcomes = ["a", "b", "c", "d"].map((work) =>
      request(scheduler, work),
    );
    // While a slot is free, each call starts inside `request`.
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["b"]],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls[0]!.release();
    await outcomes[0]!.result;
    await nextTurn();
    assert.deepEqual(calls[2]!.values, ["c"]);
    assert.ok(calls[2]!.queueWaitMs[0]! >= 15);
    assert.ok(calls[0]!.queueWaitMs[0]! < 15);

    calls[1]!.release();
    calls[2]!.release();
    await outcomes[2]!.result;
    await nextTurn();
    calls[3]!.release();
    await scheduler.close();
    assert.equal(counts.maxRunning, 2);
    assert.deepEqual(await Promise.all(outcomes.map(({ result }) => result)), [
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("drops waiting work when every request on it is cancelled", async () => {
    const { invoke, calls } = gatedInvoke();
    const scheduler = oneByOneScheduler(invoke, { maxConcurrentCalls: 1 });
    const controller = new AbortController();
    const reason = new Error("stop");

    const running = request(scheduler, "a");
    const cancelled = request(scheduler, "b", { signal: controller.signal });
    const kept = request(scheduler, "c");
    await nextTurn();
    controller.abort(reason);
    await assert.rejects(cancelled.result, reason);

    calls[0]!.release();
    await running.result;
    await nextTurn();
    calls[1]!.release();
    await kept.result;
    await scheduler.close();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"], ["c"]],
    );
  });

  it("fills a waiting batch instead of opening more calls", async () => {
    const { invoke, calls, counts } = gatedInvoke();
    const { scheduler, runBatches } = manualBatching(invoke, {
      maxConcurrentCalls: 1,
      maxBatchSize: 3,
    });

    const first = request(scheduler, "a");
    await runBatches();
    // The next work is ready while the first call runs. The call that gets
    // the slot takes all the work that is ready then, up to the batch limit.
    const second = request(scheduler, "b");
    await runBatches();
    const more = ["c", "d", "e"].map((work) => request(scheduler, work));
    await runBatches();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a"]],
    );

    calls[0]!.release();
    await first.result;
    // The slot frees when the call settles, just after its results.
    await nextTurn();
    assert.deepEqual(calls[1]!.values, ["b", "c", "d"]);
    calls[1]!.release();
    await second.result;
    await nextTurn();
    calls[2]!.release();
    await Promise.all(more.map(({ result }) => result));
    await scheduler.close();

    assert.deepEqual(calls[2]!.values, ["e"]);
    assert.equal(counts.maxRunning, 1);
  });

  it("makes expedited work wait for a slot, in calls of at most maxBatchSize", async () => {
    const { invoke, calls } = gatedInvoke();
    const { scheduler, runBatches } = manualBatching(invoke, {
      maxConcurrentCalls: 1,
      maxBatchSize: 2,
    });

    const running = request(scheduler, "a");
    await runBatches();
    const direct = ["b", "c", "d"].map((work) => request(scheduler, work));
    direct.forEach(({ item }) => item!.expedite());
    await nextTurn();
    assert.equal(calls.length, 1);
    // The expedited work waits for a slot, so another request can join it.
    const joiner = request(scheduler, "c");
    assert.equal(joiner.joined, true);

    calls[0]!.release();
    await running.result;
    await nextTurn();
    // Expediting skips only the accumulation wait. The batch limit still
    // splits the work.
    assert.deepEqual(calls[1]!.values, ["b", "c"]);
    assert.equal(calls[1]!.autoBatched, false);
    calls[1]!.release();
    await direct[0]!.result;
    await nextTurn();
    assert.deepEqual(calls[2]!.values, ["d"]);
    assert.equal(calls[2]!.autoBatched, false);
    calls[2]!.release();
    await Promise.all(direct.map(({ result }) => result));
    await scheduler.close();
    assert.equal(calls.length, 3);
  });
});

describe("a producer that takes one request per call", options, () => {
  it("sends each unit of work as its own call, at once, and shares equal keys", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = oneByOneScheduler(invoke);
    const outcomes = ["a", "b", "a"].map((work) => request(scheduler, work));

    // Without a call limit, each call starts inside `request`.
    assert.deepEqual(calls, [
      { values: ["a"], autoBatched: false },
      { values: ["b"], autoBatched: false },
    ]);
    assert.deepEqual(await Promise.all(outcomes.map(({ result }) => result)), [
      "a",
      "b",
      "a",
    ]);
    assert.deepEqual(
      outcomes.map(({ joined }) => joined),
      [false, false, true],
    );
    assert.equal(scheduler.joinedCount(outcomes[0]!.item!), 1);
    assert.equal(scheduler.joinedCount(outcomes[1]!.item!), 0);
    await scheduler.close();
  });

  it("ignores expedite, and never reports a call as automatic", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = oneByOneScheduler(invoke, { maxConcurrentCalls: 1 });

    const outcomes = ["a", "b"].map((work) => request(scheduler, work));
    outcomes[1]!.item!.expedite();
    await Promise.all(outcomes.map(({ result }) => result));

    assert.deepEqual(calls, [
      { values: ["a"], autoBatched: false },
      { values: ["b"], autoBatched: false },
    ]);
    await scheduler.close();
  });

  it("rejects work whose slot is an Error, and wraps a non-Error rejection", async () => {
    const slotError = new Error("slot");
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      batching: undefined,
      invoke: async ([item]) => {
        if (item!.input.work === "slot") return [slotError];
        // oxlint-disable-next-line no-throw-literal -- the case under test
        throw "not an Error";
      },
    });
    const slot = request(scheduler, "slot");
    const thrown = request(scheduler, "thrown");

    await assert.rejects(slot.result, slotError);
    await assert.rejects(thrown.result, (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    });
    await scheduler.close();
  });

  it("close waits for running work", async () => {
    const release = Promise.withResolvers<string[]>();
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      batching: undefined,
      invoke: async () => release.promise,
    });
    const outcome = request(scheduler, "a");
    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });

    await nextTurn();
    assert.equal(closed, false);
    release.resolve(["a"]);
    await closing;
    assert.equal(await outcome.result, "a");
  });
});

describe("a producer that takes batches", options, () => {
  /** A batching scheduler whose one accumulation waits for `scheduled`. */
  const scheduledOnce = (
    invoke: ReturnType<typeof echoInvoke>["invoke"],
    batching: BatchOptions = {},
    extra: Partial<typeof defaults> = {},
  ) => {
    const scheduled = Promise.withResolvers<() => void>();
    const scheduler: ProducerScheduler<string, string> =
      createProducerScheduler<string, string>({
        ...defaults,
        ...extra,
        batching: { ...batching, batchScheduleFn: scheduled.resolve },
        invoke,
      });
    return { scheduler, scheduled: scheduled.promise };
  };

  it("skips waiting work that an earlier call's producer cancels synchronously", async () => {
    const controller = new AbortController();
    const failure = new Error("cancelled during production");
    const calls: string[] = [];
    const { scheduler, scheduled } = scheduledOnce(
      async (items) => {
        const values = items.map(({ input }) => input.work);
        calls.push(...values);
        if (values.includes("a")) controller.abort(failure);
        return await Promise.resolve(values);
      },
      { maxBatchSize: 1 },
    );
    const outcomes = ["a", "b", "c"].map((work) =>
      request(scheduler, work, work === "b" ? controller : {}),
    );
    const results = Promise.allSettled(outcomes.map(({ result }) => result));
    (await scheduled)();
    await scheduler.close();
    assert.deepEqual(calls, ["a", "c"]);
    assert.deepEqual(await results, [
      { status: "fulfilled", value: "a" },
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "c" },
    ]);
  });

  it("does not run work twice when an earlier call's producer flushes synchronously", async () => {
    const calls: string[] = [];
    const { scheduler, scheduled } = scheduledOnce(
      async (items) => {
        const values = items.map(({ input }) => input.work);
        calls.push(...values);
        if (values.includes("a")) scheduler.flush();
        return await Promise.resolve(values);
      },
      { maxBatchSize: 1 },
    );
    const outcomes = ["a", "b", "c"].map((work) => request(scheduler, work));
    (await scheduled)();
    await scheduler.close();
    assert.deepEqual(calls, ["a", "b", "c"]);
    assert.deepEqual(await Promise.all(outcomes.map(({ result }) => result)), [
      "a",
      "b",
      "c",
    ]);
  });

  it("defaults producer batches to at most 20 requests", async () => {
    const { invoke, calls } = echoInvoke();
    const { scheduler, scheduled } = scheduledOnce(
      invoke,
      {},
      { sharingWindowMs: 0 },
    );
    const works = Array.from({ length: 21 }, (_, index) => String(index));
    const outcomes = works.map((work) => request(scheduler, work));
    (await scheduled)();
    await scheduler.close();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [works.slice(0, 20), works.slice(20)],
    );
    assert.deepEqual(
      await Promise.all(outcomes.map(({ result }) => result)),
      works,
    );
  });

  it("gives every request its own work when keyOf returns undefined", async () => {
    const { invoke, calls } = echoInvoke();
    const { scheduler, scheduled } = scheduledOnce(
      invoke,
      {},
      { keyOf: () => undefined },
    );
    const outcomes = ["a", "a"].map((work) => request(scheduler, work));
    (await scheduled)();
    await scheduler.close();
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["a", "a"]],
    );
    assert.deepEqual(
      outcomes.map(({ joined }) => joined),
      [false, false],
    );
  });

  it("still runs work that is requested after close", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      batching: {},
      invoke,
    });

    await scheduler.close();
    // The dispatcher has no closed state: it accepts the work without a
    // warning, and sends it on the default schedule.
    const late = request(scheduler, "late");
    assert.equal(await late.result, "late");
    assert.deepEqual(calls, [{ values: ["late"], autoBatched: true }]);
  });

  it("close makes waiting work ready, and waits for it", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      // A schedule that never fires.
      batching: { batchScheduleFn: () => {} },
      invoke,
    });
    const queued = request(scheduler, "a");
    const closed = scheduler.close();
    assert.equal(scheduler.close(), closed);
    // The call starts in a microtask after the flush, not inside `close`.
    assert.deepEqual(calls, []);
    await closed;
    assert.deepEqual(calls, [{ values: ["a"], autoBatched: true }]);
    assert.equal(await queued.result, "a");
  });

  it("starts nothing for a request whose signal already aborted", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      batching: {},
      invoke,
    });
    const reason = new Error("cancelled");
    const cancelled = request(scheduler, "a", {
      signal: AbortSignal.abort(reason),
    });
    const kept = request(scheduler, "b");
    assert.equal(cancelled.item, undefined);
    await assert.rejects(cancelled.result, reason);
    assert.equal(await kept.result, "b");
    assert.deepEqual(
      calls.map(({ values }) => values),
      [["b"]],
    );
  });

  it("sends expedited work in calls of at most maxBatchSize, without the schedule", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      // A schedule that never fires: only expedited work can start.
      batching: { maxBatchSize: 2, batchScheduleFn: () => {} },
      invoke,
    });
    const outcomes = ["a", "b", "c", "d", "e"].map((work) =>
      request(scheduler, work),
    );
    outcomes.forEach(({ item }) => item!.expedite());
    assert.deepEqual(await Promise.all(outcomes.map(({ result }) => result)), [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    // The work of one turn forms calls together, split at the batch limit:
    // expedited work is not one producer call of its own.
    assert.deepEqual(calls, [
      { values: ["a", "b"], autoBatched: false },
      { values: ["c", "d"], autoBatched: false },
      { values: ["e"], autoBatched: false },
    ]);
    await scheduler.close();
  });

  it("reports a call as automatic unless every item of it was expedited", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduled: (() => void)[] = [];
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      batching: { batchScheduleFn: (run) => scheduled.push(run) },
      invoke,
    });

    const accumulated = request(scheduler, "a");
    const expedited = request(scheduler, "b");
    expedited.item!.expedite();
    assert.equal(await expedited.result, "b");
    // The accumulation's schedule makes "a" ready in the turn in which "c"
    // is expedited, so one call takes both, in the order in which they
    // became ready.
    const alsoExpedited = request(scheduler, "c");
    alsoExpedited.item!.expedite();
    scheduled.splice(0).forEach((run) => run());
    await Promise.all([accumulated.result, alsoExpedited.result]);

    assert.deepEqual(calls, [
      { values: ["b"], autoBatched: false },
      { values: ["c", "a"], autoBatched: true },
    ]);
    await scheduler.close();
  });

  it("lets a request expedite waiting work that it joined", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      // A schedule that never fires.
      batching: { batchScheduleFn: () => {} },
      invoke,
    });

    const waiting = request(scheduler, "a");
    const joiner = request(scheduler, "a");
    assert.equal(joiner.item, waiting.item);
    joiner.item!.expedite();

    assert.equal(await waiting.result, "a");
    assert.deepEqual(calls, [{ values: ["a"], autoBatched: false }]);
    assert.equal(scheduler.joinedCount(waiting.item!), 1);
    await scheduler.close();
  });

  it("still batches automatic requests that start after flush", async () => {
    const { invoke, calls } = echoInvoke();
    const scheduler = createProducerScheduler<string, string>({
      ...defaults,
      // A schedule that never fires, as an owner's may during shutdown.
      batching: { batchScheduleFn: () => {} },
      invoke,
    });
    scheduler.flush();

    const outcomes = ["a", "b", "c"].map((work) => request(scheduler, work));

    assert.deepEqual(await Promise.all(outcomes.map(({ result }) => result)), [
      "a",
      "b",
      "c",
    ]);
    assert.deepEqual(calls, [{ values: ["a", "b", "c"], autoBatched: true }]);
    await scheduler.close();
  });
});
