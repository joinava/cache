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
      operation: "getMany",
      failedRequestCount: 0,
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

test("direct getMany reports its Store operation and logical read timing", async (t) => {
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
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.operation, "getMany");
  assert.equal(batches[0]?.requestCount, 2);
  assert.equal(batches[0]?.failedRequestCount, 0);
  assert.equal(batches[0]?.queueWaitTotalMs, 0);
  assert.equal(reads.length, 2);
  assert.ok(
    reads.every(
      (read) => read.durationMs !== undefined && read.durationMs >= 0,
    ),
  );
});

test("direct scalar reads measure Store duration separately and report failure", async (t) => {
  const messages: CacheReadBatchMessage[] = [];
  const store = new MemoryStore();
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      name: "direct-single",
      store,
      batchReads: false,
    }),
  );
  const subscriber = (message: CacheReadBatchMessage) => {
    messages.push(message);
  };
  cacheReadBatchChannel.subscribe(subscriber);
  t.after(async () => {
    cacheReadBatchChannel.unsubscribe(subscriber);
    await cache.close();
  });
  await cache.get(request("miss"));
  const failure = new Error("direct Store failure");
  t.mock.method(store, "get", () => {
    throw failure;
  });
  await assert.rejects(
    cache.get(request("failed")),
    (error) => error === failure,
  );
  assert.deepEqual(
    messages.map(({ durationMs, ...message }) => {
      assert.ok(durationMs >= 0);
      return message;
    }),
    [
      {
        cache: cache.name,
        operation: "get",
        outcome: "success",
        requestCount: 1,
        entryCount: 0,
        failedRequestCount: 0,
        queueWaitTotalMs: 0,
      },
      {
        cache: cache.name,
        operation: "get",
        outcome: "failure",
        requestCount: 1,
        entryCount: 0,
        failedRequestCount: 1,
        queueWaitTotalMs: 0,
      },
    ],
  );
});

test("entry failures retain successful entry counts for automatic and direct reads", async (t) => {
  const store = new MemoryStore();
  const cache = new Cache(
    singleTypeCacheOptions<string>()({ name: "partial-counts", store }),
  );
  t.after(async () => await cache.close());
  await cache.store([
    { id: "hit", content: "value", directives: { freshUntilAge: 60 } },
  ]);
  const original = store.getMany.bind(store);
  const failure = new Error("one slot failed");
  t.mock.method(
    store,
    "getMany",
    async (requests: Parameters<typeof original>[0]) => {
      const results = await original(requests);
      return results.map((entries, index) =>
        requests[index]?.id === "failed" ? failure : entries,
      );
    },
  );
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
  const results = await Promise.allSettled([
    cache.get(request("hit")),
    cache.get(request("failed")),
    cache.get(request("hit")),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.equal(batches[0]?.entryCount, 2);
  assert.equal(batches[0]?.failedRequestCount, 1);
  assert.equal(batches[0]?.outcome, "failure");
  assert.equal(reads.filter((read) => read.found === "read-failed").length, 1);
  reads.length = 0;
  await assert.rejects(
    cache.getMany([request("hit"), request("failed")]),
    (error) => error === failure,
  );
  assert.equal(batches[1]?.entryCount, 1);
  assert.equal(batches[1]?.failedRequestCount, 1);
  assert.equal(batches[1]?.requestCount, 2);
  assert.equal(reads.filter((read) => read.found === "read-failed").length, 2);
});

test("cancelled queued batches and empty direct calls dispatch no Store event", async (t) => {
  const schedule = Promise.withResolvers<() => void>();
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      name: "empty-dispatch",
      store: new MemoryStore(),
      batchReads: { batchScheduleFn: (dispatch) => schedule.resolve(dispatch) },
    }),
  );
  const messages: CacheReadBatchMessage[] = [];
  const subscriber = (message: CacheReadBatchMessage) => {
    messages.push(message);
  };
  cacheReadBatchChannel.subscribe(subscriber);
  t.after(async () => {
    cacheReadBatchChannel.unsubscribe(subscriber);
    await cache.close();
  });
  await cache.getMany([]);
  const controller = new AbortController();
  const pending = cache.get(request("cancelled"), {
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending);
  controller.abort();
  (await schedule.promise)();
  await rejected;
  assert.deepEqual(messages, []);
});

test("cancelling a dispatched caller preserves eventual Store accounting", async (t) => {
  const store = new MemoryStore();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const emitted = Promise.withResolvers<CacheReadBatchMessage>();
  const original = store.getMany.bind(store);
  t.mock.method(
    store,
    "getMany",
    async (requests: Parameters<typeof original>[0]) => {
      started.resolve();
      await finish.promise;
      return await original(requests);
    },
  );
  const cache = new Cache(
    singleTypeCacheOptions<string>()({ name: "cancel-in-flight", store }),
  );
  const subscriber = (message: CacheReadBatchMessage) => {
    emitted.resolve(message);
  };
  cacheReadBatchChannel.subscribe(subscriber);
  t.after(async () => {
    finish.resolve();
    cacheReadBatchChannel.unsubscribe(subscriber);
    await cache.close();
  });
  const controller = new AbortController();
  const pending = cache.get(request("missing"), { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await started.promise;
  controller.abort();
  await rejected;
  finish.resolve();
  const message = await emitted.promise;
  assert.equal(message.outcome, "success");
  assert.equal(message.requestCount, 1);
  assert.equal(message.failedRequestCount, 0);
});

test("malformed automatic result lengths emit one failed operation", async (t) => {
  const store = new MemoryStore();
  t.mock.method(store, "getMany", async () => []);
  const cache = new Cache(
    singleTypeCacheOptions<string>()({ name: "invalid-length", store }),
  );
  const messages: CacheReadBatchMessage[] = [];
  const subscriber = (message: CacheReadBatchMessage) => {
    messages.push(message);
  };
  cacheReadBatchChannel.subscribe(subscriber);
  t.after(async () => {
    cacheReadBatchChannel.unsubscribe(subscriber);
    await cache.close();
  });
  const results = await Promise.allSettled([
    cache.get(request("a")),
    cache.get(request("b")),
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.failedRequestCount, 2);
  assert.equal(messages[0]?.outcome, "failure");
});

test("direct Store cancellation is not counted as operational failure", async (t) => {
  const store = new MemoryStore();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const messages: CacheReadBatchMessage[] = [];
  t.mock.method(store, "get", async (...args: Parameters<typeof store.get>) => {
    started.resolve();
    await finish.promise;
    args[2]?.signal?.throwIfAborted();
    return [];
  });
  const cache = new Cache(
    singleTypeCacheOptions<string>()({
      name: "direct-abort",
      store,
      batchReads: false,
    }),
  );
  const subscriber = (message: CacheReadBatchMessage) => {
    messages.push(message);
  };
  cacheReadBatchChannel.subscribe(subscriber);
  t.after(async () => {
    finish.resolve();
    cacheReadBatchChannel.unsubscribe(subscriber);
    await cache.close();
  });
  const controller = new AbortController();
  const pending = cache.get(request("cancelled"), {
    signal: controller.signal,
  });
  const rejected = assert.rejects(
    pending,
    (error) => error === controller.signal.reason,
  );
  await started.promise;
  controller.abort();
  finish.resolve();
  await rejected;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.outcome, "cancelled");
  assert.equal(messages[0]?.failedRequestCount, 0);
  assert.equal(messages[0]?.requestCount, 1);
});
