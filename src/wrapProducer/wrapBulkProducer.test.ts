import assert from "node:assert/strict";
import { it } from "node:test";
import type { DispatchInfo } from "@zingage/scheduling";
import type { Logger } from "../types/index.js";
import { BulkProducerScheduler } from "./wrapBulkProducer.js";

const sharing = {
  collapseTasksMs: 1_000,
  makeKey: (request: string) => request,
};

/** The options every test leaves at their defaults. */
const defaults = { logger: undefined };

it(
  "skips a queued task that an earlier chunk's producer cancels synchronously",
  { timeout: 5_000 },
  async () => {
    const scheduled = Promise.withResolvers<() => void>();
    const controller = new AbortController();
    const failure = new Error("cancelled during production");
    const calls: string[] = [];
    const scheduler = new BulkProducerScheduler<string, string>({
      ...defaults,
      batching: {
        maxBatchSize: 1,
        batchScheduleFn: (dispatch) => scheduled.resolve(dispatch),
      },
      collapseTasksMs: 3_000,
      makeKey: (request) => request,
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(...values);
        if (values.includes("a")) controller.abort(failure);
        return await Promise.resolve(values);
      },
    });
    const outcomes = scheduler.startOrRideTasks(
      ["a", "b", "c"].map((request) => ({
        request,
        ...(request === "b" ? { signal: controller.signal } : {}),
      })),
    );
    const results = Promise.allSettled(outcomes.map(({ promise }) => promise));
    (await scheduled.promise)();
    await scheduler.close();
    assert.deepEqual(calls, ["a", "c"]);
    assert.deepEqual(await results, [
      { status: "fulfilled", value: "a" },
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "c" },
    ]);
  },
);

it(
  "does not redispatch tasks that an earlier chunk's producer flushes synchronously",
  { timeout: 5_000 },
  async () => {
    const scheduled = Promise.withResolvers<() => void>();
    const calls: string[] = [];
    const scheduler = new BulkProducerScheduler<string, string>({
      ...defaults,
      batching: {
        maxBatchSize: 1,
        batchScheduleFn: (dispatch) => scheduled.resolve(dispatch),
      },
      collapseTasksMs: 3_000,
      makeKey: (request) => request,
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(...values);
        if (values.includes("a")) scheduler.flush();
        return await Promise.resolve(values);
      },
    });
    const outcomes = scheduler.startOrRideTasks(
      ["a", "b", "c"].map((request) => ({
        request,
      })),
    );
    (await scheduled.promise)();
    await scheduler.close();
    assert.deepEqual(calls, ["a", "b", "c"]);
    assert.deepEqual(
      await Promise.all(outcomes.map(({ promise }) => promise)),
      ["a", "b", "c"],
    );
  },
);

it(
  "defaults producer batches to at most 20 requests",
  { timeout: 5_000 },
  async () => {
    const scheduled = Promise.withResolvers<() => void>();
    const calls: number[][] = [];
    const scheduler = new BulkProducerScheduler<number, number>({
      ...defaults,
      batching: { batchScheduleFn: (dispatch) => scheduled.resolve(dispatch) },
      collapseTasksMs: 0,
      makeKey: (request) => String(request),
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(values);
        return await Promise.resolve(values);
      },
    });
    const requests = Array.from({ length: 21 }, (_, index) => index);
    const outcomes = scheduler.startOrRideTasks(
      requests.map((request) => ({ request })),
    );
    (await scheduled.promise)();
    await scheduler.close();
    assert.deepEqual(calls, [requests.slice(0, 20), requests.slice(20)]);
    assert.deepEqual(
      await Promise.all(outcomes.map(({ promise }) => promise)),
      requests,
    );
  },
);

it(
  "gives every request its own task when makeKey returns undefined",
  { timeout: 5_000 },
  async () => {
    const scheduled = Promise.withResolvers<() => void>();
    const calls: string[][] = [];
    const scheduler = new BulkProducerScheduler<string, string>({
      ...defaults,
      batching: { batchScheduleFn: (dispatch) => scheduled.resolve(dispatch) },
      collapseTasksMs: 1_000,
      makeKey: () => undefined,
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(values);
        return await Promise.resolve(values);
      },
    });
    const outcomes = scheduler.startOrRideTasks(
      ["a", "a"].map((request) => ({ request })),
    );
    (await scheduled.promise)();
    await scheduler.close();
    assert.deepEqual(calls, [["a", "a"]]);
    assert.deepEqual(
      outcomes.map(({ rode }) => rode),
      [false, false],
    );
  },
);

it(
  "gives the owner's logger the warning for work started after close",
  { timeout: 5_000 },
  async () => {
    const warnings: string[] = [];
    const logger: Logger = (component, level, message) => {
      if (level === "warn") warnings.push(`${component}: ${message}`);
    };
    const scheduler = new BulkProducerScheduler<string, string>({
      ...defaults,
      ...sharing,
      batching: {},
      logger,
      dispatch: async (requests) => requests.map(({ request }) => request),
    });

    await scheduler.close();
    const [late] = scheduler.startOrRideTasks([{ request: "late" }]);
    assert.equal(await late!.promise, "late");
    // The scheduler still queues an automatic request after close.
    assert.deepEqual(warnings, ["batcher: enqueue called after close"]);
  },
);

it(
  "close dispatches queued tasks at once, and waits for them",
  { timeout: 5_000 },
  async () => {
    const infos: DispatchInfo[] = [];
    const scheduler = new BulkProducerScheduler<string, string>({
      ...defaults,
      ...sharing,
      batching: { batchScheduleFn: () => {} },
      dispatch: async (requests, info) => {
        infos.push(info);
        return requests.map(({ request }) => request);
      },
    });
    const [queued] = scheduler.startOrRideTasks([{ request: "a" }]);
    const closed = scheduler.close();
    assert.equal(scheduler.close(), closed);
    assert.deepEqual(infos, [{ autoBatched: true }]);
    await closed;
    assert.equal(await queued!.promise, "a");
  },
);

it(
  "dispatches the other requests of a call when one request's signal already aborted",
  { timeout: 5_000 },
  async () => {
    const calls: string[][] = [];
    const scheduler = new BulkProducerScheduler<string, string>({
      ...defaults,
      batching: {},
      collapseTasksMs: 1_000,
      makeKey: (request) => request,
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(values);
        return values;
      },
    });
    const reason = new Error("cancelled");
    const [cancelled, kept] = scheduler.startOrRideDirect([
      { request: "a", signal: AbortSignal.abort(reason) },
      { request: "b" },
    ]);
    await assert.rejects(cancelled!.promise, reason);
    assert.equal(await kept!.promise, "b");
    assert.deepEqual(calls, [["b"]]);
  },
);

it(
  "sends a direct call as one unsplit dispatch, even when batchScheduleFn runs its callback at once",
  { timeout: 5_000 },
  async () => {
    const calls: { values: string[]; autoBatched: boolean }[] = [];
    const scheduler = new BulkProducerScheduler<string, string>({
      ...defaults,
      ...sharing,
      batching: { maxBatchSize: 2, batchScheduleFn: (dispatch) => dispatch() },
      dispatch: async (requests, { autoBatched }) => {
        const values = requests.map(({ request }) => request);
        calls.push({ values, autoBatched });
        return values;
      },
    });
    const outcomes = scheduler.startOrRideDirect(
      ["a", "b", "c", "d", "e"].map((request) => ({ request })),
    );
    assert.deepEqual(
      await Promise.all(outcomes.map(({ promise }) => promise)),
      ["a", "b", "c", "d", "e"],
    );
    assert.deepEqual(calls, [
      { values: ["a", "b", "c", "d", "e"], autoBatched: false },
    ]);
  },
);

it("still batches automatic requests that start after flush", async () => {
  const calls: (readonly string[])[] = [];
  const infos: DispatchInfo[] = [];
  const scheduler = new BulkProducerScheduler<string, string>({
    ...defaults,
    // A schedule that never fires, as an owner's may during shutdown.
    batching: { batchScheduleFn: () => {} },
    ...sharing,
    dispatch: async (requests, info) => {
      calls.push(requests.map(({ request }) => request));
      infos.push(info);
      return await Promise.resolve(requests.map(({ request }) => request));
    },
  });
  scheduler.flush();

  const outcomes = ["a", "b", "c"].flatMap((request) =>
    scheduler.startOrRideTasks([{ request }]),
  );

  assert.deepEqual(await Promise.all(outcomes.map(({ promise }) => promise)), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(calls, [["a", "b", "c"]]);
  assert.deepEqual(infos, [{ autoBatched: true }]);
  await scheduler.close();
});
