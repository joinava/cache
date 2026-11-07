import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import {
  bulkMemoryStore,
  postgresEnvironmentIsConfigured,
  postgresStoreFixture,
} from "../test/fixtures.js";
import {
  ACCEPT_ANY_REGISTRY,
  captureChannels,
  freshFor100,
  uniqueCacheName,
  waitUntil,
} from "../test/v2AcceptanceHelpers.js";
import Cache, { singleTypeCacheOptions } from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import type { CacheSpec } from "./types/00_CacheSpec.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * The automatic read batching contract: the `get()` calls of one event-loop turn share
 * one `store.getMany()` call, and nothing else about a `get()` changes. Each
 * request still gets its own lookup result and its own `read` message.
 */

type Spec = CacheSpec<string, string>;

/**
 * A MemoryStore whose reads are spied on. `beforeGetMany` runs inside every
 * `getMany` call before the store reads, so a test can hold a batch's query
 * open.
 */
function spiedStore(options?: { beforeGetMany?: () => Promise<void> }) {
  const store = bulkMemoryStore<Spec>();
  const getMany = store.getMany.bind(store);
  const getManySpy = mock.method(
    store,
    "getMany",
    async (...args: Parameters<typeof getMany>) => {
      await options?.beforeGetMany?.();
      return getMany(...args);
    },
  );
  return {
    store,
    /** The number of requests in each `getMany` call, in call order. */
    getManyRequestCounts: () =>
      getManySpy.mock.calls.map(({ arguments: [requests] }) => requests.length),
  };
}

const batchedCacheOver = (store: ReturnType<typeof bulkMemoryStore<Spec>>) =>
  new Cache({
    store,
    name: uniqueCacheName("batch-reads"),
    resourceTypes: ACCEPT_ANY_REGISTRY,
  });

const lookup = (id: string, params: Record<string, string> = {}) => ({
  id,
  params,
  directives: {},
});

// A read that never settles would otherwise hang the run (node:test waits for
// a pending test forever), so each suite fails after a bound instead.
const suiteOptions = { timeout: 20_000 };

describe("Cache with batchReads", suiteOptions, () => {
  it("serves concurrent gets from one getMany call, with each request's own result", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const batched = batchedCacheOver(store);
    const unbatched = new Cache({
      store,
      name: uniqueCacheName("unbatched"),
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    await batched.store([
      { id: "plain", content: "plain", directives: freshFor100 },
      {
        id: "by-format",
        vary: { format: "json" },
        content: "json",
        directives: freshFor100,
      },
    ]);

    // Ten requests: hits, misses, and two requests for one id whose params
    // select different variants.
    const requests = [
      lookup("plain"),
      lookup("by-format", { format: "json" }),
      lookup("by-format", { format: "html" }),
      lookup("plain", { format: "html" }),
      ...Array.from({ length: 6 }, (_, i) => lookup(`missing:${String(i)}`)),
    ];

    const capture = captureChannels(batched.name);
    try {
      const batchedResults = await Promise.all(
        requests.map(async (req) => batched.get(req)),
      );

      assert.deepEqual(getManyRequestCounts(), [10]);
      assert.deepEqual(
        batchedResults.map((it) => it.usable?.content),
        ["plain", "json", undefined, "plain", ...Array(6).fill(undefined)],
      );

      // One `read` message per request, each naming its own request's outcome.
      assert.deepEqual(
        capture.read.map(({ resourceId, found }) => [resourceId, found]),
        requests.map(({ id }, i) => [
          id,
          batchedResults[i]?.usable === undefined ? "none" : "usable",
        ]),
      );

      // The same lookups without readBatching: one store.get each, and the same
      // results.
      const unbatchedResults = await Promise.all(
        requests.map(async (req) => unbatched.get(req, { autoBatch: false })),
      );
      assert.deepEqual(getManyRequestCounts(), [10, ...Array(10).fill(1)]);
      assert.deepEqual(batchedResults, unbatchedResults);
    } finally {
      capture.stop();
    }
  });

  it("gathers every get of one event-loop turn, including gets after microtask hops", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = batchedCacheOver(store);

    const first = cache.get(lookup("a"));
    // Promise continuations run in the same turn, so a get that a few awaits
    // delay still joins the batch. A flush at the end of the microtask queue
    // would have sent "a" alone.
    for (const _ of Array.from({ length: 5 })) {
      await Promise.resolve();
    }
    const second = cache.get(lookup("b"));
    await Promise.all([first, second]);

    assert.deepEqual(getManyRequestCounts(), [2]);
  });

  it("dispatches before the next setImmediate, and a later get starts the next batch", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = batchedCacheOver(store);

    const first = cache.get(lookup("a"));
    // DataLoader dispatches after Promise continuations and before the
    // next check phase.
    await nextTurn();
    assert.deepEqual(getManyRequestCounts(), [1]);

    await first;
    await cache.get(lookup("b"));
    assert.deepEqual(getManyRequestCounts(), [1, 1]);
  });

  it("splits a flush of 1,200 requests into getMany calls of at most 20", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = batchedCacheOver(store);
    const ids = Array.from({ length: 1200 }, (_, i) => `id:${String(i)}`);
    await cache.store(
      ids.map((id) => ({ id, content: id, directives: freshFor100 })),
    );

    const results = await Promise.all(
      ids.map(async (id) => cache.get(lookup(id))),
    );

    // README.md and the batchReads docs state the default 20 cap.
    assert.deepEqual(getManyRequestCounts(), Array(60).fill(20));
    assert.deepEqual(
      results.map((it) => it.usable?.content),
      ids,
    );
  });

  it("rejects only the request whose signal aborts while it waits, and drops it from the query", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = batchedCacheOver(store);
    const controller = new AbortController();
    const reason = new Error("caller gave up");

    const capture = captureChannels(cache.name);
    try {
      const pending = [
        cache.get(lookup("a")),
        cache.get(lookup("b"), { signal: controller.signal }),
        cache.get(lookup("c")),
      ];
      controller.abort(reason);
      const [a, b, c] = await Promise.allSettled(pending);

      assert.equal(a?.status, "fulfilled");
      assert.deepEqual(b, { status: "rejected", reason });
      assert.equal(c?.status, "fulfilled");
      assert.deepEqual(getManyRequestCounts(), [2]);
      assert.deepEqual(
        capture.read
          .filter(({ found }) => found !== "aborted")
          .map(({ resourceId }) => resourceId),
        ["a", "c"],
      );
    } finally {
      capture.stop();
    }
  });

  it("rejects a request at once when its signal aborts while its batch's query runs", async () => {
    const query = Promise.withResolvers<void>();
    const { store, getManyRequestCounts } = spiedStore({
      beforeGetMany: async () => query.promise,
    });
    const cache = batchedCacheOver(store);
    const controller = new AbortController();
    const reason = new Error("caller gave up");

    const aborted = cache.get(lookup("a"), { signal: controller.signal });
    const other = cache.get(lookup("b"));
    await waitUntil(
      () => getManyRequestCounts().length === 1,
      "the batch's getMany call to start",
    );
    controller.abort(reason);

    // The query is still held open, so only an abort listener can settle the
    // aborted request this soon.
    const settledWhileQueryRuns = await Promise.race([
      aborted.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      nextTurn().then(() => "still pending"),
    ]);
    assert.equal(settledWhileQueryRuns, reason);

    query.resolve();
    assert.equal((await other).usable, undefined);
    assert.deepEqual(getManyRequestCounts(), [2]);
  });

  it("rejects every request in a failed getMany call, with one read-failed message each", async () => {
    const failure = new Error("store is down");
    const { store } = spiedStore({
      beforeGetMany: async () => {
        throw failure;
      },
    });
    const cache = batchedCacheOver(store);
    const ids = Array.from({ length: 10 }, (_, i) => `id:${String(i)}`);

    const capture = captureChannels(cache.name);
    try {
      const settled = await Promise.allSettled(
        ids.map(async (id) => cache.get(lookup(id))),
      );

      assert.deepEqual(
        settled,
        ids.map(() => ({ status: "rejected", reason: failure })),
      );
      assert.deepEqual(
        capture.read.map(({ resourceId, found }) => [resourceId, found]),
        ids.map((id) => [id, "read-failed"]),
      );
      assert.ok(
        capture.read.every(
          (message) =>
            message.found === "read-failed" && message.error === failure,
        ),
      );
    } finally {
      capture.stop();
    }
  });

  it("preserves each batch's first reader context when close forces dispatch", async () => {
    const context = new AsyncLocalStorage<string>();
    const observed: (string | undefined)[] = [];
    const scheduled: (() => void)[] = [];
    const { store, getManyRequestCounts } = spiedStore({
      beforeGetMany: async () => {
        observed.push(context.getStore());
      },
    });
    const cache = new Cache({
      store,
      name: uniqueCacheName("context"),
      resourceTypes: ACCEPT_ANY_REGISTRY,
      readBatching: {
        maxBatchSize: 1,
        batchScheduleFn: (dispatch) => {
          scheduled.push(dispatch);
        },
      },
    });
    const a = context.run("reader-a", () => cache.get(lookup("a")));
    const b = context.run("reader-b", () => cache.get(lookup("b")));
    await context.run("closer", () => cache.close());
    await Promise.all([a, b]);
    assert.deepEqual(observed, ["reader-a", "reader-b"]);
    // The scheduled callbacks still exist after a forced flush; neither a
    // second close nor invoking those callbacks may execute a batch twice.
    await cache.close();
    context.run("scheduler", () => scheduled.forEach((dispatch) => dispatch()));
    assert.deepEqual(getManyRequestCounts(), [1, 1]);
  });

  it("keeps result positions when the middle read aborts before dispatch", async () => {
    const { store } = spiedStore();
    const cache = batchedCacheOver(store);
    await cache.store(
      ["a", "b", "c"].map((id) => ({
        id,
        content: id,
        directives: freshFor100,
      })),
    );
    const controller = new AbortController();
    const pending = [
      cache.get(lookup("a")),
      cache.get(lookup("b"), { signal: controller.signal }),
      cache.get(lookup("c")),
    ];
    controller.abort();
    const results = await Promise.allSettled(pending);
    assert.equal(
      results[0]?.status === "fulfilled" && results[0].value.usable?.content,
      "a",
    );
    assert.equal(results[1]?.status, "rejected");
    assert.equal(
      results[2]?.status === "fulfilled" && results[2].value.usable?.content,
      "c",
    );
  });

  it("starts queued reads before close() closes the store", async () => {
    const events: string[] = [];
    const { store } = spiedStore({
      beforeGetMany: async () => {
        events.push("getMany");
      },
    });
    const close = store.close.bind(store);
    mock.method(store, "close", async () => {
      events.push("close");
      return close();
    });
    const cache = batchedCacheOver(store);
    await cache.store([{ id: "a", content: "a", directives: freshFor100 }]);

    // Both reads are queued, not yet flushed, when close() starts.
    const reads = [cache.get(lookup("a")), cache.get(lookup("b"))];
    await cache.close();
    const [a, b] = await Promise.all(reads);

    assert.deepEqual(events, ["getMany", "close"]);
    assert.equal(a?.usable?.content, "a");
    assert.equal(b?.usable, undefined);
  });

  it("drains an accepted read before releasing the Store", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { store } = spiedStore({
      beforeGetMany: async () => {
        started.resolve();
        await gate.promise;
      },
    });
    const cleanup = mock.method(store, "close");
    const cache = batchedCacheOver(store);
    const read = cache.get(lookup("a"));
    const closing = cache.close();
    await started.promise;
    assert.equal(cleanup.mock.callCount(), 0);
    assert.equal(cache.close(), closing);
    gate.resolve();
    await Promise.all([read, closing]);
    assert.equal(cleanup.mock.callCount(), 1);
  });

  it("rejects a get that arrives after close() starts", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = batchedCacheOver(store);

    const closing = cache.close();
    await assert.rejects(cache.get(lookup("a")), /Store has been closed/);
    await closing;

    assert.deepEqual(getManyRequestCounts(), []);
  });

  it("passes custom scheduling and batch size to DataLoader without caching reads", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const callbacks: (() => void)[] = [];
    const cache = new Cache({
      store,
      name: uniqueCacheName("custom-batching"),
      resourceTypes: ACCEPT_ANY_REGISTRY,
      readBatching: {
        maxBatchSize: 2,
        batchScheduleFn: (dispatch) => {
          callbacks.push(dispatch);
        },
      },
    });
    const request = lookup("same");
    const pending = [
      cache.get(request),
      cache.get(request),
      cache.get(lookup("other")),
    ];
    assert.deepEqual(getManyRequestCounts(), []);
    callbacks.splice(0).forEach((dispatch) => dispatch());
    await Promise.all(pending);
    assert.deepEqual(getManyRequestCounts(), [2, 1]);
    await cache.store([
      { id: "same", content: "updated", directives: freshFor100 },
    ]);
    const repeated = cache.get(request);
    callbacks.splice(0).forEach((dispatch) => dispatch());
    assert.equal((await repeated).usable?.content, "updated");
    assert.deepEqual(getManyRequestCounts(), [2, 1, 1]);
    const last = cache.get(request);
    await cache.close();
    await last;
    callbacks.splice(0).forEach((dispatch) => dispatch());
    assert.deepEqual(getManyRequestCounts(), [2, 1, 1, 1]);
  });

  it("is forwarded by singleTypeCacheOptions", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = new Cache(
      singleTypeCacheOptions<string>()({
        store,
        name: uniqueCacheName("batch-reads-single-type"),
        readBatching: {},
      }),
    );

    await Promise.all(["a", "b", "c"].map(async (id) => cache.get(lookup(id))));

    assert.deepEqual(getManyRequestCounts(), [3]);
  });
});

describe("wrapProducer over a batchReads cache", suiteOptions, () => {
  it("reads the cache for 10 concurrent wrapped calls with one store read", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = batchedCacheOver(store);
    const ids = Array.from({ length: 10 }, (_, i) => `id:${String(i)}`);
    // Half the ids are cached; the other half miss and reach the producer.
    await cache.store(
      ids.slice(0, 5).map((id) => ({
        id,
        content: `cached:${id}`,
        directives: freshFor100,
      })),
    );
    const load = wrapProducer({
      cache,
      produce: async (req) => ({
        content: `produced:${req.id}`,
        directives: freshFor100,
      }),
    });

    // The shape of `EmrVisitService.getByIds`: one wrapped call per id, all
    // started in one turn.
    const results = await Promise.all(
      ids.map(async (id) => load.get({ id, directives: {} })),
    );

    assert.deepEqual(getManyRequestCounts(), [10]);
    assert.deepEqual(
      results.map(({ content }) => content),
      ids.map((id, i) => (i < 5 ? `cached:${id}` : `produced:${id}`)),
    );
  });
});

describe(
  "Cache with batchReads over PostgresStore",
  postgresEnvironmentIsConfigured()
    ? suiteOptions
    : { skip: "Postgres environment variables are not configured" },
  () => {
    it("reads 10 concurrent gets with one SQL statement", async () => {
      const fixture = postgresStoreFixture();
      const queryCount = () => fixture.queryMock.mock.callCount();
      try {
        const cache = new Cache({
          store: fixture.postgresStore,
          name: uniqueCacheName("batch-reads-postgres"),
          resourceTypes: ACCEPT_ANY_REGISTRY,
          readBatching: {},
        });
        const ids = Array.from({ length: 10 }, (_, i) => `id:${String(i)}`);
        await cache.store(
          ids.map((id) => ({ id, content: id, directives: freshFor100 })),
        );

        const before = queryCount();
        const results = await Promise.all(
          ids.map(async (id) => cache.get(lookup(id))),
        );

        assert.equal(queryCount() - before, 1);
        assert.deepEqual(
          results.map((it) => it.usable?.content),
          ids,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  },
);

describe("v4 read participation", () => {
  it("dispatches a direct known set without waiting for the automatic queue", async (t) => {
    const { store, getManyRequestCounts } = spiedStore();
    const scheduled: (() => void)[] = [];
    const cache = new Cache({
      store,
      name: "direct-known-set",
      resourceTypes: ACCEPT_ANY_REGISTRY,
      readBatching: { batchScheduleFn: (run) => scheduled.push(run) },
    });
    t.after(async () => await cache.close());
    const queued = cache.get(lookup("queued"));
    await cache.getMany([lookup("a"), lookup("b")], { autoBatch: false });
    assert.deepEqual(getManyRequestCounts(), [2]);
    scheduled.forEach((run) => run());
    await queued;
    assert.deepEqual(getManyRequestCounts(), [2, 1]);
  });

  it("never accumulates single-only Store reads", async (t) => {
    const store = new MemoryStore<Spec>();
    const read = t.mock.method(store, "get");
    const schedule = t.mock.fn();
    const cache = new Cache({
      store,
      name: "single-prompt",
      resourceTypes: ACCEPT_ANY_REGISTRY,
      readBatching: { batchScheduleFn: schedule },
    });
    t.after(async () => await cache.close());
    await cache.getMany([lookup("a"), lookup("b")]);
    assert.equal(read.mock.callCount(), 2);
    assert.equal(schedule.mock.callCount(), 0);
  });

  it("does not cancel a dispatched shared operation when every caller aborts", async (t) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { store, getManyRequestCounts } = spiedStore({
      beforeGetMany: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const cleanup = t.mock.method(store, "close");
    const cache = batchedCacheOver(store);
    const controller = new AbortController();
    const read = cache.get(lookup("a"), { signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(read);
    const closing = cache.close();
    assert.equal(cleanup.mock.callCount(), 0);
    release.resolve();
    await closing;
    assert.deepEqual(getManyRequestCounts(), [1]);
    assert.equal(cleanup.mock.callCount(), 1);
  });

  it("keeps per-slot successes and rejects malformed output", async (t) => {
    const store = bulkMemoryStore<Spec>();
    const cache = batchedCacheOver(store);
    t.after(async () => await cache.close());
    await cache.store([
      { id: "hit", content: "value", directives: freshFor100 },
    ]);
    const original = store.getMany.bind(store);
    const failure = new TypeError("custom operational failure");
    t.mock.method(
      store,
      "getMany",
      async (requests: Parameters<typeof original>[0]) => {
        const results = await original(requests);
        return results.map((value, index) =>
          requests[index]?.id === "failed" ? failure : value,
        );
      },
    );
    const results = await cache.getMany([
      lookup("hit"),
      lookup("failed"),
      lookup("miss"),
    ]);
    assert.ok(!(results[0] instanceof Error));
    assert.equal(results[0].usable?.content, "value");
    assert.equal(results[1], failure);
    assert.ok(!(results[2] instanceof Error));
    assert.equal(results[2].usable, undefined);
    t.mock.method(store, "getMany", async () => []);
    await assert.rejects(
      cache.getMany([lookup("hit")]),
      /one entry array or Error/,
    );
  });

  it("rejects explicit true for JavaScript callers", async (t) => {
    const { store } = spiedStore();
    const cache = batchedCacheOver(store);
    t.after(async () => await cache.close());
    await assert.rejects(
      Reflect.apply(cache.get.bind(cache), cache, [
        lookup("a"),
        { autoBatch: true },
      ]),
      /omitted or false/,
    );
  });
});

describe("read dispatch diagnostics", () => {
  it("separates queue wait, physical dispatch duration, and logical wait", async (t) => {
    const { cacheReadBatchChannel, cacheReadChannel } =
      await import("./diagnostics.js");
    const clock = { now: 50 };
    t.mock.method(performance, "now", () => clock.now);
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { store } = spiedStore({
      beforeGetMany: async () => {
        started.resolve();
        await gate.promise;
      },
    });
    const scheduled: (() => void)[] = [];
    const cache = new Cache({
      store,
      name: "read-clock",
      resourceTypes: ACCEPT_ANY_REGISTRY,
      readBatching: { batchScheduleFn: (run) => scheduled.push(run) },
    });
    const physical: import("./diagnostics.js").CacheReadBatchMessage[] = [];
    const logical: import("./diagnostics.js").CacheReadMessage[] = [];
    const onPhysical = (
      message: import("./diagnostics.js").CacheReadBatchMessage,
    ) => {
      if (message.cache === cache.name) physical.push(message);
    };
    const onLogical = (
      message: import("./diagnostics.js").CacheReadMessage,
    ) => {
      if (message.cache === cache.name) logical.push(message);
    };
    cacheReadBatchChannel.subscribe(onPhysical);
    cacheReadChannel.subscribe(onLogical);
    t.after(async () => {
      cacheReadBatchChannel.unsubscribe(onPhysical);
      cacheReadChannel.unsubscribe(onLogical);
      await cache.close();
    });
    const pending = cache.getMany([lookup("a"), lookup("b")]);
    clock.now = 70;
    scheduled.forEach((run) => run());
    await started.promise;
    assert.equal(physical.length, 0);
    assert.equal(logical.length, 0);
    clock.now = 110;
    gate.resolve();
    await pending;
    assert.equal(physical.length, 1);
    assert.equal(physical[0]?.queueWaitTotalMs, 40);
    assert.equal(physical[0]?.durationMs, 40);
    assert.equal(physical[0]?.requestCount, 2);
    assert.deepEqual(
      logical.map((message) => message.durationMs),
      [60, 60],
    );
  });

  it("counts one whole-operation failure separately from its affected slots", async (t) => {
    const { cacheReadBatchChannel } = await import("./diagnostics.js");
    const { store } = spiedStore({
      beforeGetMany: async () => {
        throw new Error("offline");
      },
    });
    const cache = batchedCacheOver(store);
    const messages: import("./diagnostics.js").CacheReadBatchMessage[] = [];
    const onRead = (
      message: import("./diagnostics.js").CacheReadBatchMessage,
    ) => {
      if (message.cache === cache.name) messages.push(message);
    };
    cacheReadBatchChannel.subscribe(onRead);
    t.after(async () => {
      cacheReadBatchChannel.unsubscribe(onRead);
      await cache.close();
    });
    const results = await cache.getMany([lookup("a"), lookup("b")], {
      autoBatch: false,
    });
    assert.equal(results[0], results[1]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.outcome, "failure");
    assert.equal(messages[0]?.failedRequestCount, 2);
    assert.equal(messages[0]?.queueWaitTotalMs, 0);
    assert.equal(messages[0]?.automatic, false);
  });
});

describe("v4 producer scheduling", suiteOptions, () => {
  it("shares overlapping requests and directly dispatches a queued peer without dispatching unrelated work", async () => {
    const cache = new Cache({
      store: new MemoryStore<Spec>(),
      name: "producer-direct-join",
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    const scheduled = Promise.withResolvers<() => void>();
    const produced = Promise.withResolvers<void>();
    const calls: string[][] = [];
    const client = wrapProducer({
      cache,
      producerBatching: {
        batchScheduleFn: (dispatch) => scheduled.resolve(dispatch),
      },
      produceMany: async (requests) => {
        calls.push(requests.map(({ id }) => id));
        await produced.promise;
        return requests.map(({ id }) => ({
          content: id,
          directives: freshFor100,
        }));
      },
    });
    const automatic = client.getMany([{ id: "a" }, { id: "b" }]);
    const dispatch = await scheduled.promise;
    await nextTurn();
    const direct = client.get({ id: "b" }, { autoBatch: { producer: false } });
    await nextTurn();
    assert.deepEqual(calls, [["b"]]);
    dispatch();
    assert.deepEqual(calls, [["b"], ["a"]]);
    produced.resolve();
    assert.deepEqual(
      (await automatic).map((entry) =>
        entry instanceof Error ? entry : entry.content,
      ),
      ["a", "b"],
    );
    assert.equal((await direct).content, "b");
    dispatch();
    assert.equal(calls.length, 2);
    await client.close();
    await cache.close();
  });

  it("removes cancelled queued participation but retains other callers", async () => {
    const cache = new Cache({
      store: new MemoryStore<Spec>(),
      name: "producer-cancellation",
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    const scheduled = Promise.withResolvers<() => void>();
    const producer = mock.fn(async (requests: readonly { id: string }[]) =>
      requests.map(({ id }) => ({ content: id, directives: freshFor100 })),
    );
    const client = wrapProducer({
      cache,
      produceMany: producer,
      producerBatching: { batchScheduleFn: scheduled.resolve },
    });
    const cancelled = new AbortController();
    const abandoned = client.get({ id: "a" }, { signal: cancelled.signal });
    const rejected = assert.rejects(abandoned, { name: "AbortError" });
    const kept = client.get({ id: "b" });
    const dispatch = await scheduled.promise;
    await nextTurn();
    cancelled.abort();
    await rejected;
    dispatch();
    assert.equal((await kept).content, "b");
    assert.deepEqual(
      producer.mock.calls[0]!.arguments[0].map(({ id }) => id),
      ["b"],
    );
    await client.close();
    await cache.close();
  });

  it("waits for the direct known set but feeds automatic misses from independent Store invocations", async () => {
    for (const automatic of [true, false]) {
      const slowRead = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const store = bulkMemoryStore<Spec>();
      const original = store.getMany.bind(store);
      mock.method(
        store,
        "getMany",
        async (...args: Parameters<typeof original>) => {
          if (args[0].some(({ id }) => id === "slow")) {
            started.resolve();
            await slowRead.promise;
          }
          return original(...args);
        },
      );
      const cache = new Cache({
        store,
        name: `producer-readiness-${String(automatic)}`,
        resourceTypes: ACCEPT_ANY_REGISTRY,
        readBatching: { maxBatchSize: 1 },
      });
      const producer = mock.fn(async (requests: readonly { id: string }[]) =>
        requests.map(({ id }) => ({ content: id, directives: freshFor100 })),
      );
      const client = wrapProducer({ cache, produceMany: producer });
      const read = client.getMany(
        [{ id: "ready" }, { id: "slow" }],
        automatic ? {} : { autoBatch: { producer: false } },
      );
      await started.promise;
      await nextTurn();
      assert.equal(producer.mock.callCount(), automatic ? 1 : 0);
      if (automatic)
        assert.deepEqual(
          producer.mock.calls[0]!.arguments[0].map(({ id }) => id),
          ["ready"],
        );
      slowRead.resolve();
      await read;
      if (!automatic)
        assert.deepEqual(
          producer.mock.calls[0]!.arguments[0].map(({ id }) => id),
          ["ready", "slow"],
        );
      await client.close();
      await cache.close();
    }
  });

  it("flushes queued production and waits for accepted reads and writes during close", async () => {
    const cache = new Cache({
      store: new MemoryStore<Spec>(),
      name: "producer-close",
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    const readGate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const writeGate = Promise.withResolvers<void>();
    const originalRead = cache.get.bind(cache);
    mock.method(
      cache,
      "get",
      async (...args: Parameters<typeof originalRead>) => {
        entered.resolve();
        await readGate.promise;
        return originalRead(...args);
      },
    );
    const originalStore = cache.store.bind(cache);
    mock.method(
      cache,
      "store",
      async (...args: Parameters<typeof originalStore>) => {
        await writeGate.promise;
        return originalStore(...args);
      },
    );
    const client = wrapProducer({
      cache,
      produceMany: async (requests) =>
        requests.map(({ id }) => ({ content: id, directives: freshFor100 })),
      producerBatching: { batchScheduleFn: () => {} },
    });
    const accepted = client.get({ id: "a" });
    await entered.promise;
    const close = client.close();
    assert.equal(client.close(), close);
    await assert.rejects(client.get({ id: "new" }), /closed/);
    readGate.resolve();
    assert.equal((await accepted).content, "a");
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await nextTurn();
    assert.equal(closed, false);
    writeGate.resolve();
    await close;
    await cache.close();
  });
});

describe("v4 pending producer sharing", suiteOptions, () => {
  it("shares only pending work within the joining age and removes completed production immediately", async (t) => {
    const clock = { now: 10000 };
    t.mock.method(Date, "now", () => clock.now);
    const cache = new Cache({
      store: new MemoryStore<Spec>(),
      name: "producer-sharing-age",
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    const gates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const producer = mock.fn(async () => {
      const index = producer.mock.callCount();
      await gates[index]!.promise;
      return {
        content: String(index),
        directives: { freshUntilAge: 60, storeFor: 0 },
      };
    });
    const client = wrapProducer({ cache, produce: producer });
    const first = client.get({ id: "a" });
    await nextTurn();
    clock.now += 3000;
    const joined = client.get({ id: "a" });
    await nextTurn();
    assert.equal(producer.mock.callCount(), 1);
    clock.now += 1;
    const later = client.get({ id: "a" });
    await nextTurn();
    assert.equal(producer.mock.callCount(), 2);
    gates[0]!.resolve();
    assert.equal((await first).content, "0");
    assert.equal((await joined).content, "0");
    gates[1]!.resolve();
    assert.equal((await later).content, "1");
    const completed = client.get({ id: "a" });
    await nextTurn();
    assert.equal(producer.mock.callCount(), 3);
    gates[2]!.resolve();
    assert.equal((await completed).content, "2");
    await client.close();
    await cache.close();
  });
});

describe(
  "wrapper shutdown after partial contract failure",
  suiteOptions,
  () => {
    it("drains a sibling read that starts production after the public bulk call rejects", async (t) => {
      const cache = new Cache({
        store: new MemoryStore<Spec>(),
        name: "producer-failed-sibling",
        resourceTypes: ACCEPT_ANY_REGISTRY,
      });
      const slow = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const { CacheContractError } = await import("./utils/utils.js");
      const read = cache.get.bind(cache);
      t.mock.method(cache, "get", async (...args: Parameters<typeof read>) => {
        if (args[0].id === "invalid")
          throw new CacheContractError("invalid lookup");
        entered.resolve();
        await slow.promise;
        return read(...args);
      });
      const producer = mock.fn(async ({ id }: { id: string }) => ({
        content: id,
        directives: freshFor100,
      }));
      const client = wrapProducer({ cache, produce: producer });
      const pending = client.getMany([{ id: "invalid" }, { id: "slow" }]);
      await assert.rejects(pending, CacheContractError);
      await entered.promise;
      let finished = false;
      const close = client.close().then(() => {
        finished = true;
      });
      await nextTurn();
      assert.equal(finished, false);
      slow.resolve();
      await close;
      assert.equal(producer.mock.callCount(), 1);
      assert.equal((await cache.get(lookup("slow"))).usable?.content, "slow");
      await cache.close();
    });
  },
);

describe("producer duration boundaries", suiteOptions, () => {
  it("separates queue and invocation time from every logical known-set slot", async (t) => {
    const clock = { now: 0 };
    t.mock.method(performance, "now", () => clock.now);
    const cache = new Cache({
      store: new MemoryStore<Spec>(),
      name: "producer-duration",
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    await cache.store([
      { id: "hit", content: "cached", directives: freshFor100 },
    ]);
    const scheduled = Promise.withResolvers<() => void>();
    const producerGate = Promise.withResolvers<void>();
    const client = wrapProducer({
      cache,
      producerBatching: { batchScheduleFn: scheduled.resolve },
      produceMany: async (requests) => {
        await producerGate.promise;
        return requests.map(({ id }) => ({
          content: id,
          directives: freshFor100,
        }));
      },
    });
    const capture = captureChannels(cache.name);
    try {
      const result = client.getMany([{ id: "hit" }, { id: "a" }, { id: "b" }]);
      const dispatch = await scheduled.promise;
      await nextTurn();
      assert.equal(capture.fetch.length, 0);
      clock.now = 5;
      dispatch();
      clock.now = 12;
      producerGate.resolve();
      assert.equal((await result).length, 3);
      assert.equal(capture.produce.length, 1);
      const operation = capture.produce[0]!;
      assert.equal(operation.operation, "produceMany");
      assert.equal(operation.automatic, true);
      assert.equal(operation.requestCount, 2);
      assert.equal(operation.failedRequestCount, 0);
      assert.equal(operation.operationFailed, false);
      assert.equal(operation.collapsedCallerCount, 1);
      assert.equal(operation.queueWaitTotalMs, 10);
      assert.equal(operation.durationMs, 7);
      assert.deepEqual(
        capture.fetch.map(({ durationMs }) => durationMs),
        [12, 12, 12],
      );
      await client.close();
    } finally {
      capture.stop();
      await cache.close();
    }
  });
});

describe("normalized producer compatibility", suiteOptions, () => {
  for (const normalizationFails of [false, true]) {
    it(
      normalizationFails
        ? "keeps fallback requests independent when normalization fails"
        : "shares normalized requests while passing the original parameters",
      async () => {
        const cache = new Cache({
          store: new MemoryStore<Spec>(),
          name: "normalized-sharing",
          resourceTypes: ACCEPT_ANY_REGISTRY,
          normalizeParamValue: (_name, value) => {
            if (normalizationFails) throw new Error("normalization failed");
            return typeof value === "string" ? value.toLowerCase() : value;
          },
        });
        const gate = Promise.withResolvers<void>();
        const producer = mock.fn(
          async ({ params }: { params: Readonly<Record<string, unknown>> }) => {
            await gate.promise;
            return {
              content: String(params["language"]),
              directives: freshFor100,
            };
          },
        );
        const client = wrapProducer({ cache, produce: producer });
        const first = client.get({ id: "a", params: { language: "EN" } });
        const second = client.get({ id: "a", params: { language: "en" } });
        await nextTurn();
        assert.equal(producer.mock.callCount(), normalizationFails ? 2 : 1);
        assert.equal(
          producer.mock.calls[0]!.arguments[0].params["language"],
          "EN",
        );
        gate.resolve();
        const results = await Promise.all([first, second]);
        assert.deepEqual(
          results.map(({ content }) => content),
          normalizationFails ? ["EN", "en"] : ["EN", "EN"],
        );
        await client.close();
        await cache.close();
      },
    );
  }
});

describe("Cache mutation drain", suiteOptions, () => {
  it("drains accepted writes and deletes after operation failure, then reports cleanup failure", async (t) => {
    const store = new MemoryStore<Spec>();
    const writeGate = Promise.withResolvers<void>();
    const deleteGate = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    const deleteStarted = Promise.withResolvers<void>();
    const writeFailure = new Error("write failed");
    const cleanupFailure = new Error("cleanup failed");
    const events: string[] = [];
    t.mock.method(store, "store", async () => {
      writeStarted.resolve();
      await writeGate.promise;
      events.push("write settled");
      throw writeFailure;
    });
    t.mock.method(store, "delete", async () => {
      deleteStarted.resolve();
      await deleteGate.promise;
      events.push("delete settled");
    });
    t.mock.method(store, "close", async () => {
      events.push("cleanup");
      throw cleanupFailure;
    });
    const cache = new Cache({
      store,
      name: "mutation-drain",
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    const write = assert.rejects(
      cache.store([{ id: "a", content: "a", directives: freshFor100 }]),
      (error) => error === writeFailure,
    );
    const deletion = cache.delete("b");
    await Promise.all([writeStarted.promise, deleteStarted.promise]);
    const closing = cache.close();
    const failedCleanup = assert.rejects(
      closing,
      (error) => error === cleanupFailure,
    );
    assert.equal(cache.close(), closing);
    writeGate.resolve();
    await write;
    await nextTurn();
    assert.deepEqual(events, ["write settled"]);
    deleteGate.resolve();
    await Promise.all([deletion, failedCleanup]);
    assert.deepEqual(events, ["write settled", "delete settled", "cleanup"]);
  });
});
