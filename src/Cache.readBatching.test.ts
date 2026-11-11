import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import {
  cacheOver,
  lookup,
  postgresEnvironmentIsConfigured,
  postgresStoreFixture,
  spiedStore,
  suiteOptions,
  type Spec,
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
import wrapProducer from "./utils/wrapProducer.js";

/**
 * The read-batching contract: for a Store with `getMany`, the `get()` calls of
 * one event-loop turn share `store.getMany()` calls of at most
 * `readBatching.maxBatchSize` requests, and nothing else about a `get()`
 * changes. Each request still gets its own lookup result and its own `read`
 * message.
 */
describe("Cache read batching", suiteOptions, () => {
  it("serves concurrent gets from one getMany call, with each request's own result", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = cacheOver(store);
    await cache.store([
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

    const capture = captureChannels(cache.name);
    try {
      const batchedResults = await Promise.all(
        requests.map(async (req) => cache.get(req)),
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

      // The same lookups with `autoBatch: false` on each call: one
      // single-request getMany call each, and the same results.
      const directResults = await Promise.all(
        requests.map(async (req) => cache.get(req, { autoBatch: false })),
      );
      assert.deepEqual(getManyRequestCounts(), [10, ...Array(10).fill(1)]);
      assert.deepEqual(batchedResults, directResults);
    } finally {
      capture.stop();
    }
  });

  it("gathers every get of one event-loop turn, including gets after microtask hops", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = cacheOver(store);

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
    const cache = cacheOver(store);

    const first = cache.get(lookup("a"));
    // The default scheduler dispatches after Promise continuations and before
    // the next check phase.
    await nextTurn();
    assert.deepEqual(getManyRequestCounts(), [1]);

    await first;
    await cache.get(lookup("b"));
    assert.deepEqual(getManyRequestCounts(), [1, 1]);
  });

  it("splits a flush of 1,200 requests into getMany calls of at most 20", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = cacheOver(store);
    const ids = Array.from({ length: 1200 }, (_, i) => `id:${String(i)}`);
    await cache.store(
      ids.map((id) => ({ id, content: id, directives: freshFor100 })),
    );

    const results = await Promise.all(
      ids.map(async (id) => cache.get(lookup(id))),
    );

    // The default `readBatching.maxBatchSize` is 20 (README.md, `CacheOptions.readBatching`).
    assert.deepEqual(getManyRequestCounts(), Array(60).fill(20));
    assert.deepEqual(
      results.map((it) => it.usable?.content),
      ids,
    );
  });

  it("rejects only the request whose signal aborts while it waits, and drops it from the query", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = cacheOver(store);
    await cache.store(
      ["a", "b", "c"].map((id) => ({
        id,
        content: id,
        directives: freshFor100,
      })),
    );
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

      assert.equal(a?.status === "fulfilled" && a.value.usable?.content, "a");
      assert.deepEqual(b, { status: "rejected", reason });
      assert.equal(c?.status === "fulfilled" && c.value.usable?.content, "c");
      assert.deepEqual(getManyRequestCounts(), [2]);
      assert.deepEqual(
        capture.read.map(({ resourceId }) => resourceId),
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
    const cache = cacheOver(store);
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
    const cache = cacheOver(store);
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
    const cache = cacheOver(store, {
      name: "context",
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
    const cache = cacheOver(store);
    await cache.store([{ id: "a", content: "a", directives: freshFor100 }]);

    // Both reads are queued, not yet flushed, when close() starts.
    const reads = [cache.get(lookup("a")), cache.get(lookup("b"))];
    await cache.close();
    const [a, b] = await Promise.all(reads);

    assert.deepEqual(events, ["getMany", "close"]);
    assert.equal(a?.usable?.content, "a");
    assert.equal(b?.usable, undefined);
  });

  it("honors readBatching.batchScheduleFn and maxBatchSize, and never serves a read from a previous batch", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const callbacks: (() => void)[] = [];
    const cache = cacheOver(store, {
      name: "custom-batching",
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

  it("singleTypeCacheOptions forwards readBatching.maxBatchSize", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = new Cache(
      singleTypeCacheOptions<string>()({
        store,
        name: uniqueCacheName("batch-reads-single-type"),
        readBatching: { maxBatchSize: 2 },
      }),
    );

    await Promise.all(["a", "b", "c"].map(async (id) => cache.get(lookup(id))));

    assert.deepEqual(getManyRequestCounts(), [2, 1]);
  });
});

describe("wrapProducer over a read-batching cache", suiteOptions, () => {
  it("reads the cache for 10 concurrent wrapped calls with one store read", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = cacheOver(store);
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
  "Cache read batching over PostgresStore",
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

describe("autoBatch: false (direct Store reads)", suiteOptions, () => {
  it("dispatches a direct known set without waiting for the automatic queue", async (t) => {
    const { store, getManyRequestCounts } = spiedStore();
    const scheduled: (() => void)[] = [];
    const cache = cacheOver(store, {
      name: "direct-known-set",
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

  it("applies readBatching.maxBatchSize only to automatic accumulation", async (t) => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = cacheOver(store, {
      name: "direct-limit",
      readBatching: { maxBatchSize: 2 },
    });
    t.after(async () => await cache.close());
    const ids = ["a", "b", "c", "d", "e"].map((id) => lookup(id));
    await cache.getMany(ids, { autoBatch: false });
    assert.deepEqual(getManyRequestCounts(), [5]);
    await cache.getMany(ids);
    assert.deepEqual(getManyRequestCounts(), [5, 2, 2, 1]);
    const client = wrapProducer({
      cache,
      produceMany: async (requests) =>
        await Promise.resolve(
          requests.map(({ id }) => ({ content: id, directives: freshFor100 })),
        ),
    });
    await client.getMany(
      ["f", "g", "h"].map((id) => ({ id })),
      { autoBatch: { store: false } },
    );
    await client.close();
    assert.deepEqual(getManyRequestCounts(), [5, 2, 2, 1, 3]);
  });

  it("never accumulates single-only Store reads", async (t) => {
    const store = new MemoryStore<Spec>();
    const read = t.mock.method(store, "get");
    const schedule = t.mock.fn();
    const cache = cacheOver(store, {
      name: "single-prompt",
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
    const cache = cacheOver(store);
    const controller = new AbortController();
    const read = cache.get(lookup("a"), { signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(read);
    const closing = cache.close();
    assert.equal(cache.close(), closing);
    assert.equal(cleanup.mock.callCount(), 0);
    release.resolve();
    await closing;
    assert.deepEqual(getManyRequestCounts(), [1]);
    assert.equal(cleanup.mock.callCount(), 1);
  });

  it("keeps per-slot successes and rejects malformed output", async (t) => {
    const failure = new TypeError("custom operational failure");
    const { store } = spiedStore({ slotErrors: { failed: failure } });
    const cache = cacheOver(store);
    t.after(async () => await cache.close());
    await cache.store([
      { id: "hit", content: "value", directives: freshFor100 },
    ]);
    const capture = captureChannels(cache.name);
    try {
      const results = await cache.getMany([
        lookup("hit"),
        lookup("failed"),
        lookup("miss"),
        lookup("hit"),
      ]);
      assert.ok(!(results[0] instanceof Error));
      assert.equal(results[0].usable?.content, "value");
      assert.equal(results[1], failure);
      assert.ok(!(results[2] instanceof Error));
      assert.equal(results[2].usable, undefined);
      assert.ok(!(results[3] instanceof Error));
      assert.equal(results[3].usable?.content, "value");
      // Only the failed slot reports a read failure.
      assert.equal(
        capture.read.filter(({ found }) => found === "read-failed").length,
        1,
      );
    } finally {
      capture.stop();
    }
    // A get rejects with its own slot's Error.
    await assert.rejects(
      cache.get(lookup("failed")),
      (error) => error === failure,
    );
    t.mock.method(store, "getMany", async () => []);
    await assert.rejects(
      cache.getMany([lookup("hit")]),
      /one entry array or Error/,
    );
  });
});
