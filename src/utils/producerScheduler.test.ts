import assert from "node:assert/strict";
import { it } from "node:test";
import { createProducerScheduler } from "./producerScheduler.js";

it(
  "skips a queued task that an earlier chunk's producer cancels synchronously",
  { timeout: 5_000 },
  async () => {
    const scheduled = Promise.withResolvers<() => void>();
    const controller = new AbortController();
    const failure = new Error("cancelled during production");
    const calls: string[] = [];
    const scheduler = createProducerScheduler<string, string>({
      bulk: true,
      maxBatchSize: 1,
      collapseTasksMs: 3_000,
      makeKey: (request) => request,
      batchScheduleFn: (dispatch) => scheduled.resolve(dispatch),
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(...values);
        if (values.includes("a")) controller.abort(failure);
        return await Promise.resolve(values);
      },
    });
    const attached = scheduler.attach(
      ["a", "b", "c"].map((request) => ({
        request,
        trigger: "miss",
        caller: {},
        ...(request === "b" ? { signal: controller.signal } : {}),
      })),
      true,
    );
    const results = Promise.allSettled(attached.map(({ promise }) => promise));
    (await scheduled.promise)();
    await scheduler.drain();
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
    const scheduler = createProducerScheduler<string, string>({
      bulk: true,
      maxBatchSize: 1,
      collapseTasksMs: 3_000,
      makeKey: (request) => request,
      batchScheduleFn: (dispatch) => scheduled.resolve(dispatch),
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(...values);
        if (values.includes("a")) scheduler.flush();
        return await Promise.resolve(values);
      },
    });
    const attached = scheduler.attach(
      ["a", "b", "c"].map((request) => ({
        request,
        trigger: "miss",
        caller: {},
      })),
      true,
    );
    (await scheduled.promise)();
    await scheduler.drain();
    assert.deepEqual(calls, ["a", "b", "c"]);
    assert.deepEqual(
      await Promise.all(attached.map(({ promise }) => promise)),
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
    const scheduler = createProducerScheduler<number, number>({
      bulk: true,
      collapseTasksMs: 0,
      makeKey: (request) => String(request),
      batchScheduleFn: (dispatch) => scheduled.resolve(dispatch),
      dispatch: async (requests) => {
        const values = requests.map(({ request }) => request);
        calls.push(values);
        return await Promise.resolve(values);
      },
    });
    const requests = Array.from({ length: 21 }, (_, index) => index);
    const attached = scheduler.attach(
      requests.map((request) => ({ request, trigger: "miss", caller: {} })),
      true,
    );
    (await scheduled.promise)();
    await scheduler.drain();
    assert.deepEqual(calls, [requests.slice(0, 20), requests.slice(20)]);
    assert.deepEqual(
      await Promise.all(attached.map(({ promise }) => promise)),
      requests,
    );
  },
);
