import assert from "node:assert/strict";
import { describe, it, mock, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { bulkMemoryStore } from "../test/fixtures.js";
import {
  ACCEPT_ANY_REGISTRY,
  freshFor100,
  staleWhileRevalidating,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import wrapProducer from "./utils/wrapProducer.js";

import {
  lookup,
  spiedStore,
  suiteOptions,
  type Spec,
} from "../test/readBatchingHelpers.js";

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

// A producer can depend on seeing exactly one caller's misses in one
// invocation. One example is a vendor read that must run per tenant. Another
// is a closure that carries per-call context. `autoBatch: { producer: false }`
// promises that: the call's production reaches the producer as one
// invocation, whatever the producerBatching limit.
describe("v4 direct producer dispatch", suiteOptions, () => {
  const makeCache = (
    name: string,
    store: ReturnType<typeof bulkMemoryStore<Spec>> = bulkMemoryStore<Spec>(),
    readBatching?: { maxBatchSize: number },
  ) =>
    new Cache({
      store,
      name,
      resourceTypes: ACCEPT_ANY_REGISTRY,
      ...(readBatching && { readBatching }),
    });

  // A cache and a client whose producer records the ids of each call. Both
  // close after the test, also when an assertion fails.
  const recordingClient = async (
    t: TestContext,
    options: {
      name: string;
      store?: ReturnType<typeof bulkMemoryStore<Spec>>;
      readBatching?: { maxBatchSize: number };
      producerBatching?: { maxBatchSize: number };
      seed?: Parameters<ReturnType<typeof makeCache>["store"]>[0];
      content?: (id: string) => string;
      onProduce?: () => Promise<void>;
    },
  ) => {
    const cache = makeCache(options.name, options.store, options.readBatching);
    if (options.seed) await cache.store(options.seed);
    const calls: string[][] = [];
    const client = wrapProducer({
      cache,
      ...(options.producerBatching && {
        producerBatching: options.producerBatching,
      }),
      produceMany: async (requests) => {
        calls.push(requests.map(({ id }) => id));
        await options.onProduce?.();
        return requests.map(({ id }) => ({
          content: options.content?.(id) ?? id,
          directives: freshFor100,
        }));
      },
    });
    t.after(async () => {
      await client.close();
      await cache.close();
    });
    return { cache, client, calls };
  };

  const contents = (results: readonly ({ content: string } | Error)[]) =>
    results.map((entry) => (entry instanceof Error ? entry : entry.content));

  const callerIds = (caller: string) =>
    Array.from({ length: 24 }, (_, index) => `${caller}:${String(index)}`);

  const runTwoConcurrentCallers = async (t: TestContext, direct: boolean) => {
    const { client, calls } = await recordingClient(t, {
      name: `producer-direct-${String(direct)}`,
      store: bulkMemoryStore<Spec>(),
      // Seed hits so that each caller's producer call holds only its misses.
      seed: ["a:0", "a:7", "b:3"].map((id) => ({
        id,
        content: id,
        directives: freshFor100,
      })),
      onProduce: async () => {
        await nextTurn();
      },
    });
    const options = direct ? { autoBatch: { producer: false as const } } : {};
    const [a, b] = await Promise.all(
      ["a", "b"].map(
        async (caller) =>
          await client.getMany(
            callerIds(caller).map((id) => ({ id })),
            options,
          ),
      ),
    );
    assert.deepEqual(contents(a!), callerIds("a"));
    assert.deepEqual(contents(b!), callerIds("b"));
    return calls;
  };

  it("gives each direct caller one producer call with only its own misses, above the batch limit", async (t) => {
    const calls = await runTwoConcurrentCallers(t, true);
    const sorted = [...calls].sort((x, y) => x[0]!.localeCompare(y[0]!));
    assert.deepEqual(sorted, [
      callerIds("a").filter((id) => id !== "a:0" && id !== "a:7"),
      callerIds("b").filter((id) => id !== "b:3"),
    ]);
  });

  it("merges or splits the same callers under automatic accumulation", async (t) => {
    const calls = await runTwoConcurrentCallers(t, false);
    const mixesCallers = calls.some(
      (ids) => new Set(ids.map((id) => id.split(":")[0])).size > 1,
    );
    assert.ok(
      mixesCallers || calls.length > 2,
      `expected merged or split calls, got ${JSON.stringify(calls)}`,
    );
  });

  it("applies producerBatching.maxBatchSize only to automatic accumulation", async (t) => {
    const { client, calls } = await recordingClient(t, {
      name: "producer-direct-limit",
      producerBatching: { maxBatchSize: 2 },
    });
    const ids = (prefix: string) =>
      ["1", "2", "3", "4", "5"].map((index) => ({ id: `${prefix}${index}` }));
    await client.getMany(ids("direct-"), { autoBatch: { producer: false } });
    await client.getMany(ids("automatic-"));
    assert.deepEqual(calls, [
      ["direct-1", "direct-2", "direct-3", "direct-4", "direct-5"],
      ["automatic-1", "automatic-2"],
      ["automatic-3", "automatic-4"],
      ["automatic-5"],
    ]);
  });

  it("sends a direct call's misses and stale refreshes in one producer call", async (t) => {
    const refreshed = Promise.withResolvers<void>();
    const { client, calls } = await recordingClient(t, {
      name: "producer-direct-revalidation",
      // A limit of 1 proves the direct cohort is not split.
      producerBatching: { maxBatchSize: 1 },
      seed: ["stale-1", "stale-2"].map((id) => ({
        id,
        ...staleWhileRevalidating(`old ${id}`),
      })),
      content: (id) => `new ${id}`,
      onProduce: async () => {
        refreshed.resolve();
      },
    });
    const results = await client.getMany(
      ["stale-1", "miss-1", "stale-2", "miss-2"].map((id) => ({ id })),
      { autoBatch: { producer: false } },
    );
    await refreshed.promise;
    assert.deepEqual(contents(results), [
      "old stale-1",
      "new miss-1",
      "old stale-2",
      "new miss-2",
    ]);
    assert.deepEqual(calls, [["stale-1", "miss-1", "stale-2", "miss-2"]]);
  });

  it("still refreshes a direct call's stale entries when the caller cancels", async (t) => {
    // Hold the miss's Store read open until the caller has cancelled.
    const releaseRead = Promise.withResolvers<void>();
    const { store } = spiedStore({
      beforeGetMany: async (requests) => {
        if (requests.some(({ id }) => id === "miss")) await releaseRead.promise;
      },
    });
    const { cache, client, calls } = await recordingClient(t, {
      name: "producer-direct-cancelled-revalidation",
      store,
      // Separate Store reads, so the stale entry classifies before the cancel.
      readBatching: { maxBatchSize: 1 },
      seed: [{ id: "stale", ...staleWhileRevalidating("old") }],
      content: (id) => `new ${id}`,
    });
    const controller = new AbortController();
    const pending = client.getMany([{ id: "stale" }, { id: "miss" }], {
      signal: controller.signal,
      autoBatch: { producer: false },
    });
    await nextTurn();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    releaseRead.resolve();
    await client.close();
    assert.deepEqual(calls, [["stale"]]);
    assert.equal(
      (await cache.get(lookup("stale"))).usable?.content,
      "new stale",
    );
  });
});
