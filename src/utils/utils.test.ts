import Cache, { singleTypeCacheOptions } from "../Cache.js";
import MemoryStore from "../stores/MemoryStore/MemoryStore.js";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import { normalizeParams } from "./normalization.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "timers/promises";
import { naiveGetMany, raceWithSignal } from "./utils.js";

describe("raceWithSignal", () => {
  it("should return the promise result when signal is undefined", async () => {
    const result = await raceWithSignal(Promise.resolve("ok"), undefined);
    assert.equal(result, "ok");
  });

  it("should return the promise result when signal is not aborted", async () => {
    const controller = new AbortController();
    const result = await raceWithSignal(
      Promise.resolve("ok"),
      controller.signal,
    );
    assert.equal(result, "ok");
  });

  it("should reject immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already"));

    await assert.rejects(
      async () => raceWithSignal(Promise.resolve("ok"), controller.signal),
      { message: "already" },
    );
  });

  it("should reject when signal aborts before promise settles", async () => {
    const controller = new AbortController();
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow"), 200);
    });

    const resultPromise = raceWithSignal(slowPromise, controller.signal);
    await delay(10);
    controller.abort(new Error("cancelled"));

    await assert.rejects(async () => resultPromise, { message: "cancelled" });
  });

  it("should resolve if promise settles before signal aborts", async () => {
    const controller = new AbortController();
    const fastPromise = Promise.resolve("fast");

    const result = await raceWithSignal(fastPromise, controller.signal);
    assert.equal(result, "fast");

    // Aborting after settlement should have no effect.
    controller.abort(new Error("too-late"));
  });

  it("should propagate promise rejection even with a signal", async () => {
    const controller = new AbortController();
    const failingPromise = Promise.reject(new Error("boom"));

    await assert.rejects(
      async () => raceWithSignal(failingPromise, controller.signal),
      { message: "boom" },
    );
  });

  it("should use the signal's reason as the rejection value", async () => {
    const controller = new AbortController();
    const neverSettles = new Promise<string>(() => {});

    const resultPromise = raceWithSignal(neverSettles, controller.signal);
    controller.abort("custom-reason");

    try {
      await resultPromise;
      throw new Error("should have rejected");
    } catch (e) {
      assert.equal(e, "custom-reason");
    }
  });

  it("should reject with the signal reason (not the promise error) when both are already settled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("signal-reason"));
    const alreadyRejected = Promise.reject(new Error("promise-reason"));

    await assert.rejects(
      async () => raceWithSignal(alreadyRejected, controller.signal),
      { message: "signal-reason" },
    );

    // The key concern: the already-rejected promise should not cause an
    // unhandledRejection. If it does, the test runner will report it as a
    // failure. Waiting a tick gives Node's rejection tracking time to fire.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("naiveGetMany partial reads", () => {
  function arrange() {
    const store = new MemoryStore<CacheSpec<string, string>>();
    const cache = new Cache(
      singleTypeCacheOptions<string>()({ name: "naive-partial", store }),
    );
    const params = normalizeParams(
      cache.normalizeParamName,
      cache.normalizeParamValue,
      {},
    );
    return { store, cache, request: (id: string) => ({ id, params }) };
  }

  it("keeps hits, misses, duplicate slots, and synchronous errors in request order", async (t) => {
    const { store, cache, request } = arrange();
    t.after(async () => await cache.close());
    await cache.store([
      { id: "hit", content: "value", directives: { freshUntilAge: 60 } },
    ]);
    const get = store.get.bind(store);
    const failure = new Error("read failed");
    t.mock.method(store, "get", (...args: Parameters<typeof get>) => {
      const [id] = args;
      if (id === "failed") throw failure;
      return get(...args);
    });
    const result = await naiveGetMany(
      store,
      [request("hit"), request("failed"), request("missing"), request("hit")],
      2,
    );
    const [hit, failed, missing, duplicate] = result;
    assert.ok(Array.isArray(hit));
    assert.equal(hit[0]?.content, "value");
    assert.equal(failed, failure);
    assert.deepEqual(missing, []);
    assert.ok(Array.isArray(duplicate));
    assert.equal(duplicate[0]?.content, "value");
  });

  it("wraps non-Error rejections and continues queued reads at the concurrency limit", async (t) => {
    const { store, cache, request } = arrange();
    t.after(async () => await cache.close());
    const gate = Promise.withResolvers<void>();
    const started: string[] = [];
    const failure = { reason: "not an Error" };
    const get = store.get.bind(store);
    t.mock.method(store, "get", async (...args: Parameters<typeof get>) => {
      const [id] = args;
      started.push(id);
      if (id === "first") {
        await gate.promise;
        throw failure;
      }
      return await get(...args);
    });
    const call = naiveGetMany(
      store,
      [request("first"), request("second"), request("third")],
      1,
    );
    await nextTurn();
    assert.deepEqual(started, ["first"]);
    gate.resolve();
    const result = await call;
    assert.ok(result[0] instanceof Error);
    assert.equal(result[0].cause, failure);
    assert.deepEqual(result.slice(1), [[], []]);
    assert.deepEqual(started, ["first", "second", "third"]);
  });

  it("rejects before reading when the caller is already cancelled", async (t) => {
    const { store, cache, request } = arrange();
    t.after(async () => await cache.close());
    const get = t.mock.method(store, "get");
    const controller = new AbortController();
    const failure = new Error("cancelled");
    controller.abort(failure);
    await assert.rejects(
      naiveGetMany(store, [request("a")], 1, { signal: controller.signal }),
      (error) => error === failure,
    );
    assert.equal(get.mock.callCount(), 0);
  });

  it("keeps cancellation out of partial-error slots and does not start queued reads", async (t) => {
    const { store, cache, request } = arrange();
    t.after(async () => await cache.close());
    const controller = new AbortController();
    const failure = new Error("cancelled during read");
    const started: string[] = [];
    t.mock.method(store, "get", async (id: string) => {
      started.push(id);
      controller.abort(failure);
      throw failure;
    });
    await assert.rejects(
      naiveGetMany(store, [request("a"), request("b")], 1, {
        signal: controller.signal,
      }),
      (error) => error === failure,
    );
    assert.deepEqual(started, ["a"]);
  });
});
