import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  Cache,
  MemoryStore,
  singleTypeCacheOptions,
  wrapBulkProducer,
  wrapProducer,
  wrapHashedInputProducer,
  wrapBulkHashedInputProducer,
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
    producerErrors?: ReadonlyMap<string, Error>;
  } = {},
) {
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      store,
      name: "cache_wait_for_store_test",
    }),
  );
  return wrapBulkProducer(
    {
      cache,
      ...(options.collapseOverlappingRequestsTime === undefined
        ? {}
        : {
            collapseOverlappingRequestsTime:
              options.collapseOverlappingRequestsTime,
          }),
    },
    async (requests) => {
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
  );
}

describe("wrapBulkProducer waitForStore", () => {
  it("waits for the gated store before returning", async () => {
    const store = makeGatedMemoryStore();
    const wrapped = makeWrappedProducer(store.store);
    const call = wrapped([{ id: "wait" }], {
      waitForStore: { maxWaitMs: 1_000 },
    });
    await store.started;

    const settledBeforeRelease = await Promise.race([
      call.then(() => true),
      nextTurn(false),
    ]);
    assert.strictEqual(settledBeforeRelease, false);

    store.release();
    const storedBeforeReturn = await Promise.race([
      store.stored.then(() => true),
      call.then(() => false),
    ]);
    assert.strictEqual(storedBeforeReturn, true);
    await call;
  });

  it("reports a timeout and returns the producer result", async () => {
    const store = makeGatedMemoryStore();
    const wrapped = makeWrappedProducer(store.store);
    const onUnstored = mock.fn();
    const call = wrapped([{ id: "timeout" }], {
      waitForStore: { maxWaitMs: 10, onUnstored },
    });
    await store.started;

    const results = await call;

    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(onUnstored.mock.calls[0]?.arguments[0], {
      reason: "timed-out",
    });
    store.release();
    await store.stored;
  });

  it("reports a store failure and returns the producer result", async () => {
    const store = makeGatedMemoryStore();
    const producerError = new Error("producer failed");
    const storeError = new Error("store failed");
    const wrapped = makeWrappedProducer(store.store, {
      producerErrors: new Map([["failure", producerError]]),
    });
    const onUnstored = mock.fn();
    const call = wrapped([{ id: "failure" }, { id: "success" }], {
      waitForStore: { maxWaitMs: 1_000, onUnstored },
    });
    await store.started;
    store.fail(storeError);

    const results = await call;

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0], producerError);
    assert.deepStrictEqual(onUnstored.mock.calls[0]?.arguments[0], {
      reason: "store-failed",
      error: storeError,
    });
  });

  it("reports a per-item producer error and returns all results", async () => {
    const store = makeGatedMemoryStore();
    const producerError = new Error("producer failed");
    const wrapped = makeWrappedProducer(store.store, {
      producerErrors: new Map([["producer-error", producerError]]),
    });
    const onUnstored = mock.fn();
    const call = wrapped([{ id: "producer-error" }, { id: "success" }], {
      waitForStore: { maxWaitMs: 1_000, onUnstored },
    });
    await store.started;
    store.release();

    const results = await call;

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0], producerError);
    assert.strictEqual(store.isStored(), true);
    assert.deepStrictEqual(onUnstored.mock.calls[0]?.arguments[0], {
      reason: "producer-error",
      error: producerError,
    });
  });

  it("reports a producer error when every item fails", async () => {
    const store = makeGatedMemoryStore();
    const producerError = new Error("producer failed");
    const wrapped = makeWrappedProducer(store.store, {
      producerErrors: new Map([
        ["producer-error-1", producerError],
        ["producer-error-2", producerError],
      ]),
    });
    const onUnstored = mock.fn();

    const results = await wrapped(
      [{ id: "producer-error-1" }, { id: "producer-error-2" }],
      { waitForStore: { maxWaitMs: 1_000, onUnstored } },
    );

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0], producerError);
    assert.strictEqual(results[1], producerError);
    assert.strictEqual(store.isStored(), false);
    assert.deepStrictEqual(onUnstored.mock.calls[0]?.arguments[0], {
      reason: "producer-error",
      error: producerError,
    });
  });

  it("waits for every group when one group reports a producer error", async () => {
    const store = makeGatedMemoryStore();
    const producerError = new Error("producer failed");
    const wrapped = makeWrappedProducer(store.store, {
      producerErrors: new Map([["bypass-error", producerError]]),
    });
    const onUnstored = mock.fn();
    const state = { settled: false };
    const call = wrapped(
      [{ id: "bypass-error", directives: { maxAge: 0 } }, { id: "miss" }],
      {
        waitForStore: { maxWaitMs: 1_000, onUnstored },
      },
    ).then((results) => {
      state.settled = true;
      return results;
    });
    await store.started;
    await nextTurn();
    assert.strictEqual(state.settled, false);

    store.release();
    const results = await call;

    assert.strictEqual(state.settled, true);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0], producerError);
    assert.strictEqual(store.isStored(), true);
    assert.deepStrictEqual(
      onUnstored.mock.calls.map((call) => call.arguments[0]),
      [{ reason: "producer-error", error: producerError }],
    );
  });

  it("returns before the store finishes when waitForStore is unset", async () => {
    const store = makeGatedMemoryStore();
    const wrapped = makeWrappedProducer(store.store);

    const results = await wrapped([{ id: "no-wait" }]);
    await store.started;

    assert.strictEqual(results.length, 1);
    assert.strictEqual(store.isStored(), false);
    store.release();
    await store.stored;
  });

  it("waits for the shared store when this call joins a producer", async () => {
    const store = makeGatedMemoryStore();
    const producerCalls = mock.fn();
    const wrapped = makeWrappedProducer(store.store, {
      collapseOverlappingRequestsTime: 3,
      onProducerCall: producerCalls,
    });
    const requests = [{ id: "collapsed" }];
    const producerCall = wrapped(requests);
    const riderCall = wrapped(requests, {
      waitForStore: { maxWaitMs: 1_000 },
    });
    await store.started;
    const producerResults = await producerCall;

    const riderSettledBeforeRelease = await Promise.race([
      riderCall.then(() => true),
      nextTurn(false),
    ]);
    assert.strictEqual(producerResults.length, 1);
    assert.strictEqual(producerCalls.mock.callCount(), 1);
    assert.strictEqual(riderSettledBeforeRelease, false);

    store.release();
    const riderResults = await riderCall;

    assert.strictEqual(riderResults.length, 1);
    assert.strictEqual(producerCalls.mock.callCount(), 1);
    await store.stored;
  });

  it("waits for bypassed items to store", async () => {
    const store = makeGatedMemoryStore();
    const wrapped = makeWrappedProducer(store.store);
    const call = wrapped([{ id: "bypass", directives: { maxAge: 0 } }], {
      waitForStore: { maxWaitMs: 1_000 },
    });
    await store.started;

    const settledBeforeRelease = await Promise.race([
      call.then(() => true),
      nextTurn(false),
    ]);
    assert.strictEqual(settledBeforeRelease, false);

    store.release();
    const results = await call;

    assert.strictEqual(results.length, 1);
    await store.stored;
  });

  it("rejects when the caller aborts during the store wait", async () => {
    const store = makeGatedMemoryStore();
    const wrapped = makeWrappedProducer(store.store);
    const controller = new AbortController();
    const call = wrapped([{ id: "abort" }], {
      signal: controller.signal,
      waitForStore: { maxWaitMs: 1_000 },
    });
    await store.started;
    controller.abort(new Error("caller aborted"));

    await assert.rejects(call, /caller aborted/);
    store.release();
    await store.stored;
  });
});


describe("persistence waits across all producer wrappers", () => {
  for (const kind of ["single", "bulk", "hashed", "bulk-hashed"] as const) {
    it(`${kind} waits for its store before returning`, async () => {
      const store = makeGatedMemoryStore();
      const cache = new Cache(singleTypeCacheOptions<string>()({ name: kind, store: store.store }));
      const options = { waitForStore: { maxWaitMs: 1_000 } };
      const result = { content: "value", directives: { freshUntilAge: 60 } };
      const call = kind === "single"
        ? wrapProducer({ cache }, async () => result)({ id: "key" }, options)
        : kind === "bulk"
          ? wrapBulkProducer({ cache }, async (requests) => requests.map(() => result))([{ id: "key" }], options)
          : kind === "hashed"
            ? wrapHashedInputProducer({ cache, hashInput: (input: string) => input, produce: async () => result })("key", options)
            : wrapBulkHashedInputProducer({ cache, hashInput: (input: string) => input, produce: async (inputs) => inputs.map(() => result) })(["key"], options);
      await store.started;
      assert.equal(await Promise.race([call.then(() => true), nextTurn(false)]), false);
      store.release();
      await call;
      assert.equal(store.isStored(), true);
      await cache.close();
    });
  }
});


it("single producer reports failed persistence when a producer error serves stale content", async () => {
  const cache = new Cache(singleTypeCacheOptions<string>()({ name: "stale-fallback", store: new MemoryStore() }));
  await cache.store([{ id: "key", content: "stale", directives: { freshUntilAge: 60 } }]);
  const originalGet = cache.get.bind(cache);
  cache.get = async (request, options) => {
    const lookup = await originalGet(request, options);
    assert.ok(lookup.usable);
    return { validatable: [], usableIfError: lookup.usable };
  };
  const error = new Error("producer unavailable");
  const onUnstored = mock.fn();
  const produce = wrapProducer({ cache }, async () => { throw error; });
  const result = await produce({ id: "key" }, { waitForStore: { maxWaitMs: 1_000, onUnstored } });
  assert.equal(result.content, "stale");
  assert.deepEqual(onUnstored.mock.calls[0]?.arguments, [{ reason: "producer-error", error }]);
  await cache.close();
});
