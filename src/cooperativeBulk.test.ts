import assert from "node:assert/strict";
import { it, mock } from "node:test";
import Cache from "./Cache.js";
import {
  MemoryStore,
  resourceType,
  type AnyParams,
  type NormalizedParams,
  type SpecOf,
} from "./index.js";
import { wrapBulkProducer } from "./utils/wrapBulkProducer.js";

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
  const wrapped = wrapBulkProducer(
    { cache, collapseOverlappingRequestsTime: 0 },
    producer,
  );
  try {
    const result = await wrapped(requests);
    assert.equal(producer.mock.callCount(), 1);
    assert.equal(producer.mock.calls[0]!.arguments[0].length, batchSize);
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
  const wrapped = wrapBulkProducer({ cache }, producer);
  try {
    await cache.store(
      requests.map((req, i) => ({
        id: req.id,
        content: i,
        directives: { freshUntilAge: 60 },
      })),
    );
    const result = await wrapped(requests);
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
  const read = mock.method(store, "getMany");
  const write = mock.method(store, "store");
  const producer = mock.fn(async () => []);
  const wrapped = wrapBulkProducer({ cache }, producer);
  try {
    await assert.rejects(wrapped([...requests, { id: "invalid" }]));
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
  const wrapped = wrapBulkProducer({ cache }, producer);
  try {
    const pending = wrapped(requests, { signal: controller.signal });
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

it("single MemoryStore writes remain immediately visible without awaiting their promise", async () => {
  const { cache, store } = makeCache();
  try {
    await cache.store([
      {
        id: "resource:template",
        content: 0,
        directives: { freshUntilAge: 60 },
      },
    ]);
    const { usable } = await cache.get({
      id: "resource:template",
      params: {},
      directives: {},
    });
    assert.ok(usable);
    const pending = store.store([
      {
        entry: { ...usable, id: "resource:immediate" },
        maxStoreForSeconds: 60,
      },
    ]);
    const read = await store.get(
      "resource:immediate",
      {} as NormalizedParams<AnyParams>,
    );
    assert.equal(read.length, 1);
    await pending;
  } finally {
    await cache.close();
  }
});

it("an invalid final bulk store ID prevents writes and events", async () => {
  const { cache, store } = makeCache();
  const write = mock.method(store, "store");
  let events = 0;
  cache.emitter.on("store", () => {
    events += 1;
  });
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
  const read = mock.method(store, "getMany");
  const producer = mock.fn(async () => []);
  const wrapped = wrapBulkProducer({ cache }, producer);
  const reason = new Error("already aborted");
  try {
    await assert.rejects(
      wrapped(
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
