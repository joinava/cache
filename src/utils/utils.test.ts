import { bulkMemoryStore, getMany, getOne } from "../../test/fixtures.js";
import Cache, { singleTypeCacheOptions } from "../Cache.js";
import MemoryStore from "../stores/MemoryStore/MemoryStore.js";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import { normalizeParams } from "./normalization.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "timers/promises";
import {
  CacheContractError,
  throwIfAnyError,
  naiveGetMany,
  raceWithSignal,
} from "./utils.js";

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
      {
        message: "already",
      },
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
      {
        message: "boom",
      },
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
      {
        message: "signal-reason",
      },
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
      const [{ id }] = args;
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
      const [{ id }] = args;
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
    t.mock.method(store, "get", async ({ id }: { id: string }) => {
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

describe("raw Store adapters", () => {
  it("preserves one operational Error across all bulk slots and scalar rejection", async (t) => {
    const store = bulkMemoryStore();
    t.after(async () => await store.close());
    const failure = new TypeError("custom Store failure");
    t.mock.method(store, "getMany", async () => {
      throw failure;
    });
    const params = normalizeParams(
      (name) => name,
      (_name, value) => value,
      {},
    );
    const request = { id: "a", params };
    const result = await getMany(store, [request, request]);
    assert.equal(result[0], failure);
    assert.equal(result[1], failure);
    await assert.rejects(getOne(store, request), (error) => error === failure);
  });

  it("wraps a whole-operation non-Error failure once", async (t) => {
    const store = bulkMemoryStore();
    t.after(async () => await store.close());
    const cause = { failed: true };
    t.mock.method(store, "getMany", async () => {
      throw cause;
    });
    const params = normalizeParams(
      (name) => name,
      (_name, value) => value,
      {},
    );
    const results = await getMany(store, [
      { id: "a", params },
      { id: "b", params },
    ]);
    assert.ok(results[0] instanceof Error);
    assert.equal(results[0], results[1]);
    assert.equal(results[0].cause, cause);
  });

  it("rejects malformed positional output instead of converting it to slots", async (t) => {
    const store = bulkMemoryStore();
    t.after(async () => await store.close());
    t.mock.method(store, "getMany", async () => []);
    const params = normalizeParams(
      (name) => name,
      (_name, value) => value,
      {},
    );
    await assert.rejects(
      getMany(store, [{ id: "a", params }]),
      CacheContractError,
    );
  });

  it("does not dispatch an empty known set", async (t) => {
    const store = bulkMemoryStore();
    t.after(async () => await store.close());
    const read = t.mock.method(store, "getMany");
    assert.deepEqual(await getMany(store, []), []);
    assert.equal(read.mock.callCount(), 0);
  });

  it("rejects invalid capabilities at construction for JavaScript callers", async (t) => {
    const memory = new MemoryStore();
    t.after(async () => await memory.close());
    const options = singleTypeCacheOptions<string>()({
      name: "invalid-capability",
      store: memory,
    });
    assert.throws(
      () =>
        Reflect.construct(Cache, [
          { ...options, store: { get: undefined, getMany: undefined } },
        ]),
      CacheContractError,
    );
    assert.throws(
      () =>
        Reflect.construct(Cache, [
          {
            ...options,
            store: { get: memory.get.bind(memory), getMany: async () => [] },
          },
        ]),
      CacheContractError,
    );
  });

  it("throwIfAnyError reports the first request-order error", () => {
    const first = new Error("first");
    const second = new Error("second");
    assert.throws(
      () => throwIfAnyError([1, first, second]),
      (error) => error === first,
    );
    const values = [1, "two"] as const;
    assert.equal(throwIfAnyError(values), values);
  });
});

describe("adapter lifecycle and positional contracts", () => {
  it("rejects missing bulk slots instead of treating them as misses", async () => {
    const store = bulkMemoryStore();
    Object.defineProperty(store, "getMany", {
      // oxlint-disable-next-line unicorn/no-new-array -- The Store deliberately returns a sparse positional array.
      value: async (requests: readonly unknown[]) => new Array(requests.length),
    });
    const cache = new Cache(
      singleTypeCacheOptions<unknown>()({ name: "sparse-bulk", store }),
    );
    const params = normalizeParams(
      (name) => name,
      (_name, value) => value,
      {},
    );
    await assert.rejects(
      getMany(store, [{ id: "a", params }]),
      CacheContractError,
    );
    await assert.rejects(
      cache.get({ id: "a", params: {}, directives: {} }),
      CacheContractError,
    );
    await cache.close();
  });

  it("keeps accepted single reads owned until they settle after a contract failure", async () => {
    const memory = new MemoryStore<CacheSpec<string, string>>();
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let active = false;
    let closedWhileActive = false;
    const store = {
      get: async ({ id }: { id: string }) => {
        if (id === "invalid")
          throw new CacheContractError("invalid single result");
        active = true;
        started.resolve();
        await held.promise;
        active = false;
        return [];
      },
      store: memory.store.bind(memory),
      delete: memory.delete.bind(memory),
      close: async () => {
        closedWhileActive = active;
        await memory.close();
      },
      [Symbol.asyncDispose]: memory[Symbol.asyncDispose].bind(memory),
    };
    const cache = new Cache(
      singleTypeCacheOptions<string>()({ name: "single-drain", store }),
    );
    const read = cache.getMany([
      { id: "invalid", params: {}, directives: {} },
      { id: "held", params: {}, directives: {} },
    ]);
    const rejected = assert.rejects(read, CacheContractError);
    await started.promise;
    const close = cache.close();
    await nextTurn();
    assert.equal(closedWhileActive, false);
    held.resolve();
    await rejected;
    await close;
    assert.equal(closedWhileActive, false);
  });
});

it("throwIfAnyError lets callers reject a partial cache result", async (t) => {
  const request = (id: string) => ({ id, params: {}, directives: {} });
  const store = bulkMemoryStore();
  const cache = new Cache(
    singleTypeCacheOptions<string>()({ name: "explicit-partial-store", store }),
  );
  t.after(async () => await cache.close());
  const failure = new Error("one resource unavailable");
  t.mock.method(store, "getMany", async () => [[], failure]);
  await assert.rejects(
    cache.getMany([request("hit"), request("failed")]).then(throwIfAnyError),
    (error) => error === failure,
  );
});
