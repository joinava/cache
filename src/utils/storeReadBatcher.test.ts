import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheReadBatchChannel,
  cacheReadChannel,
  type CacheReadBatchMessage,
  type CacheReadMessage,
} from "../diagnostics.js";
import Cache, { singleTypeCacheOptions } from "../Cache.js";
import MemoryStore from "../stores/MemoryStore/MemoryStore.js";

const request = (id: string) => ({ id, params: {}, directives: {} });

test("separates queue wait, store duration, and logical read duration", async (t) => {
  const store = new MemoryStore();
  const schedule = Promise.withResolvers<() => void>();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const batches: CacheReadBatchMessage[] = [];
  const reads: CacheReadMessage[] = [];
  const onBatch = (message: CacheReadBatchMessage) => {
    batches.push(message);
  };
  const onRead = (message: CacheReadMessage) => {
    reads.push(message);
  };
  cacheReadBatchChannel.subscribe(onBatch);
  cacheReadChannel.subscribe(onRead);
  t.after(() => {
    cacheReadBatchChannel.unsubscribe(onBatch);
    cacheReadChannel.unsubscribe(onRead);
  });
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      name: "timed-batch",
      store,
      batchReads: {
        maxBatchSize: 2,
        batchScheduleFn: (dispatch) => schedule.resolve(dispatch),
      },
    }),
  );
  t.after(async () => {
    gate.resolve();
    await cache.close();
  });
  await cache.store([
    { id: "a", content: "value", directives: { freshUntilAge: 60 } },
  ]);
  const original = store.getMany.bind(store);
  store.getMany = async (requests, options) => {
    started.resolve();
    await gate.promise;
    return await original(requests, options);
  };
  const clock = { now: 10 };
  t.mock.method(performance, "now", () => clock.now);
  const first = cache.get(request("a"));
  clock.now = 20;
  const second = cache.get(request("b"));
  clock.now = 50;
  (await schedule.promise)();
  await started.promise;
  clock.now = 80;
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0]?.usable?.content, "value");
  assert.equal(results[1]?.usable, undefined);
  assert.deepEqual(batches, [
    {
      cache: "timed-batch",
      outcome: "success",
      requestCount: 2,
      entryCount: 1,
      durationMs: 30,
      queueWaitTotalMs: 70,
    },
  ]);
  assert.deepEqual(
    reads.map((read) => read.durationMs),
    [70, 60],
  );
});

test("reports a failed batch and preserves the store error for every caller", async (t) => {
  const messages: CacheReadBatchMessage[] = [];
  const subscriber = (message: CacheReadBatchMessage) => {
    messages.push(message);
  };
  cacheReadBatchChannel.subscribe(subscriber);
  t.after(() => {
    cacheReadBatchChannel.unsubscribe(subscriber);
  });
  const store = new MemoryStore();
  const failure = new Error("store unavailable");
  store.getMany = async () => {
    throw failure;
  };
  const cache = new Cache(
    singleTypeCacheOptions<string>()({ name: "failed-batch", store }),
  );
  t.after(async () => await cache.close());
  const results = await Promise.allSettled([
    cache.get(request("a")),
    cache.get(request("b")),
  ]);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, failure);
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.outcome, "failure");
  assert.equal(messages[0]?.requestCount, 2);
  assert.equal(messages[0]?.entryCount, 0);
});

test("does not count requests cancelled before dispatch", async (t) => {
  const schedule = Promise.withResolvers<() => void>();
  const messages: CacheReadBatchMessage[] = [];
  const subscriber = (message: CacheReadBatchMessage) => {
    messages.push(message);
  };
  cacheReadBatchChannel.subscribe(subscriber);
  t.after(() => {
    cacheReadBatchChannel.unsubscribe(subscriber);
  });
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      name: "cancelled-batch",
      store: new MemoryStore(),
      batchReads: { batchScheduleFn: (dispatch) => schedule.resolve(dispatch) },
    }),
  );
  t.after(async () => await cache.close());
  const controller = new AbortController();
  const cancelled = cache.get(request("cancelled"), {
    signal: controller.signal,
  });
  const failure = new Error("cancelled");
  const rejected = assert.rejects(cancelled, (error) => error === failure);
  const live = cache.get(request("live"));
  controller.abort(failure);
  (await schedule.promise)();
  await Promise.all([rejected, live]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.requestCount, 1);
});

test("direct getMany reports logical read timing without an automatic batch event", async (t) => {
  const batches: CacheReadBatchMessage[] = [];
  const reads: CacheReadMessage[] = [];
  const onBatch = (message: CacheReadBatchMessage) => {
    batches.push(message);
  };
  const onRead = (message: CacheReadMessage) => {
    reads.push(message);
  };
  cacheReadBatchChannel.subscribe(onBatch);
  cacheReadChannel.subscribe(onRead);
  t.after(() => {
    cacheReadBatchChannel.unsubscribe(onBatch);
    cacheReadChannel.unsubscribe(onRead);
  });
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      name: "direct-bulk",
      store: new MemoryStore(),
    }),
  );
  t.after(async () => await cache.close());
  await cache.getMany([request("a"), request("b")]);
  assert.equal(batches.length, 0);
  assert.equal(reads.length, 2);
  assert.ok(
    reads.every(
      (read) => read.durationMs !== undefined && read.durationMs >= 0,
    ),
  );
});
