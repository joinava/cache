import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Cache,
  MemoryStore,
  singleTypeCacheOptions,
  wrapProducer,
  wrapHashedInputProducer,
  type OnStore,
} from "../index.js";

function deferred() {
  return Promise.withResolvers<void>();
}

function makeGatedMemoryStore() {
  const memoryStore = new MemoryStore();
  const started = deferred();
  const gate = deferred();
  const stored = deferred();
  const state = { isStored: false };
  const originalStore = memoryStore.store.bind(memoryStore);
  const store = Object.assign(memoryStore, {
    async store(entries: Parameters<MemoryStore["store"]>[0]) {
      started.resolve();
      await gate.promise;
      const result = await originalStore(entries);
      state.isStored = true;
      stored.resolve();
      return result;
    },
  });

  return {
    store,
    started: started.promise,
    stored: stored.promise,
    isStored() {
      return state.isStored;
    },
    release() {
      gate.resolve();
    },
    fail(error: unknown) {
      gate.reject(error);
    },
  };
}

function makeWrappedProducer(
  store: MemoryStore,
  options: {
    collapseOverlappingRequestsTime?: number;
    onProducerCall?: () => void;
    maxBatchSize?: number;
    producerErrors?: ReadonlyMap<string, Error>;
  } = {},
) {
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      store,
      name: "cache_wait_for_store_test",
    }),
  );
  return wrapProducer({
    cache,
    producerBatching: { maxBatchSize: options.maxBatchSize ?? 20 },
    ...(options.collapseOverlappingRequestsTime === undefined
      ? {}
      : {
          collapseOverlappingRequestsTime:
            options.collapseOverlappingRequestsTime,
        }),
    produceMany: async (requests) => {
      options.onProducerCall?.();
      await Promise.resolve();
      return requests.map(({ id }) => {
        const producerError = options.producerErrors?.get(id);
        if (producerError !== undefined) return producerError;
        return {
          content: id,
          directives: {
            freshUntilAge: 60,
            maxStale: {
              withoutRevalidation: 60,
              whileRevalidate: 60,
              ifError: 60,
            },
          },
        };
      });
    },
  });
}


type WrapperKind = "single" | "bulk" | "hashed" | "bulk-hashed";
function makeCall(kind: WrapperKind, store: MemoryStore) {
  const cache = new Cache(singleTypeCacheOptions<string>()({ name: kind, store }));
  const result = { content: "value", directives: { freshUntilAge: 60 } };
  const call = (onStore: OnStore) =>
    kind === "single"
      ? wrapProducer({ cache, produce: async () => result }).get(
          { id: "key" },
          { onStore },
        )
      : kind === "bulk"
        ? wrapProducer({
            cache,
            produceMany: async (requests) => requests.map(() => result),
          }).getMany([{ id: "key" }], { onStore })
        : kind === "hashed"
          ? wrapHashedInputProducer({
              cache,
              hashInput: (input: string) => input,
              produce: async () => result,
            }).get("key", { onStore })
          : wrapHashedInputProducer({
              cache,
              hashInput: (input: string) => input,
              produceMany: async (inputs) => inputs.map(() => result),
            }).getMany(["key"], { onStore });
  return { call, cache };
}

describe("onStore across all producer wrappers", () => {
  for (const kind of ["single", "bulk", "hashed", "bulk-hashed"] as const) {
    it(`${kind} exposes persistence without delaying the result`, async () => {
      const store = makeGatedMemoryStore();
      const { call, cache } = makeCall(kind, store.store);
      const captured = Promise.withResolvers<{ stored: Promise<void> }>();
      let calls = 0;
      await call((stored) => { calls += 1; captured.resolve({ stored }); });
      const { stored } = await captured.promise;
      assert.equal(calls, 1);
      assert.equal(await Promise.race([stored.then(() => true), nextTurn(false)]), false);
      store.release();
      await stored;
      assert.equal(store.isStored(), true);
      await cache.close();
    });
    it(`${kind} rejects the store promise without rejecting the result`, async () => {
      const store = makeGatedMemoryStore();
      const { call, cache } = makeCall(kind, store.store);
      const captured = Promise.withResolvers<{ stored: Promise<void> }>();
      await call((stored) => captured.resolve({ stored }));
      const { stored } = await captured.promise;
      const failure = new Error("store failed");
      const rejected = assert.rejects(stored, (error) => error === failure);
      store.fail(failure);
      await rejected;
      await cache.close();
    });
  }
  it("waits for every foreground store before rejecting the aggregate", async () => {
    const memory = new MemoryStore();
    const first = deferred();
    const second = deferred();
    const original = memory.store.bind(memory);
    memory.store = async (entries) => {
      await (entries[0]?.entry.id === "bypass" ? first.promise : second.promise);
      return await original(entries);
    };
    const captured = Promise.withResolvers<{ stored: Promise<void> }>();
    await makeWrappedProducer(memory, { maxBatchSize: 1 }).getMany(
      [{ id: "bypass", directives: { maxAge: 0 } }, { id: "miss" }],
      { onStore: (stored) => captured.resolve({ stored }) },
    );
    const { stored } = await captured.promise;
    const failure = new Error("first store failed");
    const rejected = assert.rejects(stored, (error) => error === failure);
    first.reject(failure);
    assert.equal(await Promise.race([stored.then(() => true, () => true), nextTurn(false)]), false);
    second.resolve();
    await rejected;
    await memory.close();
  });
  it("reports a fulfilled promise on cache hits", async () => {
    const store = makeGatedMemoryStore();
    const { call, cache } = makeCall("single", store.store);
    store.release();
    const captured = Promise.withResolvers<{ stored: Promise<void> }>();
    await call((stored) => captured.resolve({ stored }));
    await (await captured.promise).stored;
    let calls = 0;
    await call((stored) => { calls += 1; assert.ok(stored instanceof Promise); });
    assert.equal(calls, 1);
    await cache.close();
  });
  it("reports a fulfilled promise for empty bulk calls", async () => {
    const cache = new Cache(singleTypeCacheOptions<string>()({ name: "empty", store: new MemoryStore() }));
    const captured = Promise.withResolvers<{ stored: Promise<void> }>();
    const produce = wrapProducer({ cache, produceMany: async () => [] });
    assert.deepEqual(
      await produce.getMany([], {
        onStore: (stored) => captured.resolve({ stored }),
      }),
      [],
    );
    await (
      await captured.promise
    ).stored;
    await cache.close();
  });
});

it("collapsed callers observe the same pending write", async () => {
  const store = makeGatedMemoryStore();
  const produce = makeWrappedProducer(store.store);
  const first = Promise.withResolvers<{ stored: Promise<void> }>();
  const second = Promise.withResolvers<{ stored: Promise<void> }>();
  await Promise.all([
    produce.getMany([{ id: "key" }], {
      onStore: (stored) => first.resolve({ stored }),
    }),
    produce.getMany([{ id: "key" }], {
      onStore: (stored) => second.resolve({ stored }),
    }),
  ]);
  const a = (await first.promise).stored;
  const b = (await second.promise).stored;
  assert.equal(await Promise.race([Promise.all([a, b]).then(() => true), nextTurn(false)]), false);
  store.release();
  await Promise.all([a, b]);
});

it("synchronous hook errors reject the wrapper without cancelling the write", async () => {
  const store = makeGatedMemoryStore();
  const failure = new Error("hook failed");
  await assert.rejects(
    makeWrappedProducer(store.store).getMany([{ id: "key" }], {
      onStore: () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  store.release();
  await store.stored;
});

it("ignored rejected store promises do not reject the wrapper", async () => {
  const memory = new MemoryStore();
  memory.store = async () => {
    throw new Error("ignored store failure");
  };
  await makeWrappedProducer(memory).getMany([{ id: "key" }], {
    onStore: () => {},
  });
  await nextTurn();
  await memory.close();
});

for (const mode of ["background", "fallback"] as const) {
  it(`single ${mode} exposes no foreground writes`, async () => {
    const memory = new MemoryStore();
    const cache = new Cache(singleTypeCacheOptions<string>()({ name: mode, store: memory }));
    await cache.store([{ id: "key", content: "cached", directives: { freshUntilAge: 60 } }]);
    const originalGet = cache.get.bind(cache);
    cache.get = async (request, options) => {
      const lookup = await originalGet(request, options);
      assert.ok(lookup.usable);
      return mode === "background"
        ? { validatable: [], usableWhileRevalidate: lookup.usable }
        : { validatable: [], usableIfError: lookup.usable };
    };
    const gate = deferred();
    const started = deferred();
    const finished = deferred();
    const originalStore = memory.store.bind(memory);
    memory.store = async (entries) => {
      started.resolve();
      await gate.promise;
      const result = await originalStore(entries);
      finished.resolve();
      return result;
    };
    const produce = wrapProducer({
      cache,
      produce: async () => {
        if (mode === "fallback") throw new Error("producer unavailable");
        return { content: "new", directives: { freshUntilAge: 60 } };
      },
    });
    const captured = Promise.withResolvers<{ stored: Promise<void> }>();
    const result = await produce.get(
      { id: "key" },
      { onStore: (stored) => captured.resolve({ stored }) },
    );
    assert.equal(result.content, "cached");
    await (await captured.promise).stored;
    if (mode === "background") {
      await started.promise;
      gate.resolve();
      await finished.promise;
    }
    await cache.close();
  });
}
