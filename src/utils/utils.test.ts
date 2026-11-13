import {
  bulkMemoryStore,
  getMany,
  getOne,
  lookup,
} from "../../test/fixtures.js";
import Cache, { singleTypeCacheOptions } from "../cache/Cache.js";
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
  raceWithSignal,
} from "./utils.js";

// Normalized empty params, for raw Store requests.
const emptyParams = normalizeParams(
  (name) => name,
  (_name, value) => value,
  {},
);

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

describe("raw Store adapters", () => {
  it("preserves one operational Error across all bulk slots and scalar rejection", async (t) => {
    const store = bulkMemoryStore();
    t.after(async () => await store.close());
    const failure = new TypeError("custom Store failure");
    t.mock.method(store, "getMany", async () => {
      throw failure;
    });
    const request = { id: "a", params: emptyParams };
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
    const results = await getMany(store, [
      { id: "a", params: emptyParams },
      { id: "b", params: emptyParams },
    ]);
    assert.ok(results[0] instanceof Error);
    assert.equal(results[0], results[1]);
    assert.equal(results[0].cause, cause);
  });

  it("rejects malformed positional output instead of converting it to slots", async (t) => {
    const store = bulkMemoryStore();
    t.after(async () => await store.close());
    t.mock.method(store, "getMany", async () => []);
    await assert.rejects(
      getMany(store, [{ id: "a", params: emptyParams }]),
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
});

describe("throwIfAnyError", () => {
  it("reports the first request-order error", () => {
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
    await assert.rejects(
      getMany(store, [{ id: "a", params: emptyParams }]),
      CacheContractError,
    );
    await assert.rejects(cache.get(lookup("a")), CacheContractError);
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
        if (id === "invalid") {
          throw new CacheContractError("invalid single result");
        }
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
    };
    const cache = new Cache(
      singleTypeCacheOptions<string>()({ name: "single-drain", store }),
    );
    const read = cache.getUnbatched([lookup("invalid"), lookup("held")]);
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
