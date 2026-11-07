import { getOne } from "./utils/utils.js";
import { normalizeParams } from "./utils/normalization.js";
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import Cache from "./Cache.js";
import { MemoryStore, resourceType, type SpecOf } from "./index.js";
import wrapProducer from "./utils/wrapProducer.js";

const batchSize = 10_000;
function makeCache() {
  const registry = {
    resources: resourceType<number>()({
      matches: (id): id is string => id.startsWith("resource:"),
    }),
  };
  const store = new MemoryStore<SpecOf<typeof registry>>();
  const cache = new Cache({
    name: "cooperative-bulk",
    resourceTypes: registry,
    store,
  });
  return { cache, store };
}
const requests = Array.from({ length: batchSize }, (_, i) => ({
  id: `resource:${i}`,
}));

it("preserves the full producer cohort and result order for a 10k cold batch", async () => {
  const { cache } = makeCache();
  const producer = mock.fn(async (reqs: readonly { id: string }[]) =>
    reqs.map((req) => ({
      content: Number(req.id.slice("resource:".length)),
      directives: { freshUntilAge: 60 },
    })),
  );
  const wrapped = wrapProducer({
    cache,
    collapseOverlappingRequestsTime: 0,
    produceMany: producer,
  });
  try {
    const result = await wrapped.getMany(requests);
    assert.equal(producer.mock.callCount(), batchSize / 20);
    assert.ok(
      producer.mock.calls.every(
        ({ arguments: [requests] }) => requests.length === 20,
      ),
    );
    assert.deepEqual(
      result.map((entry) => (entry instanceof Error ? entry : entry.content)),
      requests.map((_, i) => i),
    );
  } finally {
    await cache.close();
  }
});

it("preserves ordered cache hits for a 10k warm batch", async () => {
  const { cache } = makeCache();
  const producer = mock.fn(async () => {
    throw new Error("warm batch must not produce");
  });
  const wrapped = wrapProducer({ cache, produceMany: producer });
  try {
    await cache.store(
      requests.map((req, i) => ({
        id: req.id,
        content: i,
        directives: { freshUntilAge: 60 },
      })),
    );
    const result = await wrapped.getMany(requests);
    assert.equal(producer.mock.callCount(), 0);
    assert.deepEqual(
      result.map((entry) => (entry instanceof Error ? entry : entry.content)),
      requests.map((_, i) => i),
    );
  } finally {
    await cache.close();
  }
});

it("classifies an invalid final ID before any cache or producer side effect", async () => {
  const { cache, store } = makeCache();
  const read = mock.method(store, "get");
  const write = mock.method(store, "store");
  const producer = mock.fn(async () => []);
  const wrapped = wrapProducer({ cache, produceMany: producer });
  try {
    await assert.rejects(wrapped.getMany([...requests, { id: "invalid" }]));
    assert.equal(read.mock.callCount(), 0);
    assert.equal(write.mock.callCount(), 0);
    assert.equal(producer.mock.callCount(), 0);
  } finally {
    await cache.close();
  }
});

it("an abort during a pending cache read prevents producer execution", async () => {
  const { cache } = makeCache();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("abort during cache read");
  const read = mock.method(cache, "getMany", async () => {
    started.resolve();
    await finish.promise;
    controller.signal.throwIfAborted();
    return [];
  });
  const producer = mock.fn(async () => []);
  const wrapped = wrapProducer({ cache, produceMany: producer });
  try {
    const pending = wrapped.getMany(requests, {
      signal: controller.signal,
      autoBatch: { store: false },
    });
    const rejected = assert.rejects(pending, (error) => error === reason);
    await started.promise;
    controller.abort(reason);
    finish.resolve();
    await rejected;
    assert.equal(read.mock.callCount(), 1);
    assert.equal(producer.mock.callCount(), 0);
  } finally {
    finish.resolve();
    await cache.close();
  }
});

it("an invalid final bulk store ID prevents writes and events", async () => {
  const { cache, store } = makeCache();
  const write = mock.method(store, "store");
  let events = 0;
  const { cacheStoreEntryChannel } = await import("./diagnostics.js");
  const onStore = (message: { cache: string }) => {
    if (message.cache === cache.name) events += 1;
  };
  cacheStoreEntryChannel.subscribe(onStore);
  try {
    const inputs = [...requests, { id: "invalid" }].map((req) => ({
      id: req.id,
      content: 1,
      directives: { freshUntilAge: 60 },
    }));
    await assert.rejects(cache.store(inputs));
    assert.equal(write.mock.callCount(), 0);
    assert.equal(events, 0);
  } finally {
    cacheStoreEntryChannel.unsubscribe(onStore);
    await cache.close();
  }
});

it("a pre-aborted mixed batch publishes every aborted fetch before any read starts", async () => {
  const { cache, store } = makeCache();
  const { cacheFetchChannel } = await import("./diagnostics.js");
  const fetches: { resourceId: string; disposition: string }[] = [];
  const onFetch = (message: { resourceId: string; disposition: string }) => {
    fetches.push(message);
  };
  cacheFetchChannel.subscribe(onFetch);
  const read = mock.method(store, "get");
  const producer = mock.fn(async () => []);
  const wrapped = wrapProducer({ cache, produceMany: producer });
  const reason = new Error("already aborted");
  try {
    await assert.rejects(
      wrapped.getMany(
        [
          { id: "resource:bypass", directives: { maxAge: 0 } },
          { id: "resource:read" },
        ],
        { signal: AbortSignal.abort(reason) },
      ),
      (error) => error === reason,
    );
    assert.deepEqual(
      fetches.map(({ resourceId, disposition }) => ({
        resourceId,
        disposition,
      })),
      [
        { resourceId: "resource:bypass", disposition: "aborted" },
        { resourceId: "resource:read", disposition: "aborted" },
      ],
    );
    assert.equal(read.mock.callCount(), 0);
    assert.equal(producer.mock.callCount(), 0);
  } finally {
    cacheFetchChannel.unsubscribe(onFetch);
    await cache.close();
  }
});

// Hold one real scheduling boundary without depending on elapsed wall time.
async function pauseNextMemoryWrite() {
  const { TimeSliceBudget } = await import("./utils/time-slicing.js");
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const yieldPoint = mock.method(
    TimeSliceBudget.prototype,
    "yieldIfNeeded",
    () => {
      yieldPoint.mock.restore();
      paused.resolve();
      return resume.promise;
    },
  );
  return {
    paused: paused.promise,
    resume: resume.resolve,
    restore: () => yieldPoint.mock.restore(),
  };
}

it("a delete during a yielded MemoryStore write does not cancel the pending write", async () => {
  const { cache, store } = makeCache();
  await cache.store([
    { id: "resource:overlap", content: 1, directives: { freshUntilAge: 60 } },
  ]);
  const gate = await pauseNextMemoryWrite();
  const pending = cache.store([
    { id: "resource:overlap", content: 2, directives: { freshUntilAge: 60 } },
  ]);
  try {
    await gate.paused;
    await cache.delete("resource:overlap");
    assert.deepEqual(
      await getOne(store, {
        id: "resource:overlap",
        params: normalizeParams<import("./types/index.js").AnyParams>(
          (name) => name,
          (_name, value) => value,
          {},
        ),
      }),
      [],
    );
    gate.resume();
    await pending;
    assert.equal(
      (
        await getOne(store, {
          id: "resource:overlap",
          params: normalizeParams<import("./types/index.js").AnyParams>(
            (name) => name,
            (_name, value) => value,
            {},
          ),
        })
      )[0]?.content,
      2,
    );
  } finally {
    gate.resume();
    gate.restore();
    await pending;
    await cache.close();
  }
});

it("awaiting a yielded MemoryStore write before deleting keeps the slot absent", async () => {
  const { cache, store } = makeCache();
  const gate = await pauseNextMemoryWrite();
  const pending = cache.store([
    { id: "resource:dependent", content: 2, directives: { freshUntilAge: 60 } },
  ]);
  try {
    await gate.paused;
    gate.resume();
    await pending;
    assert.equal(
      (
        await getOne(store, {
          id: "resource:dependent",
          params: normalizeParams<import("./types/index.js").AnyParams>(
            (name) => name,
            (_name, value) => value,
            {},
          ),
        })
      )[0]?.content,
      2,
    );
    await cache.delete("resource:dependent");
    assert.deepEqual(
      await getOne(store, {
        id: "resource:dependent",
        params: normalizeParams<import("./types/index.js").AnyParams>(
          (name) => name,
          (_name, value) => value,
          {},
        ),
      }),
      [],
    );
  } finally {
    gate.resume();
    gate.restore();
    await pending;
    await cache.close();
  }
});
