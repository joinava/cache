import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { bulkMemoryStore } from "../test/fixtures.js";
import {
  ACCEPT_ANY_REGISTRY,
  freshFor100,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import wrapProducer from "./utils/wrapProducer.js";

import { suiteOptions, type Spec } from "../test/readBatchingHelpers.js";

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
// is a closure that carries per-call context. The default scheduler both
// merges callers and splits at 20, so those producers need a supported
// opt-out. This suite fixes that opt-out and shows that the defaults differ.
describe("v4 producer one-call-per-invocation opt-out", suiteOptions, () => {
  const callerIds = (caller: string) =>
    Array.from({ length: 24 }, (_, index) => `${caller}:${String(index)}`);

  const runTwoConcurrentCallers = async (
    optOut: boolean,
  ): Promise<readonly (readonly string[])[]> => {
    const cache = new Cache({
      store: bulkMemoryStore<Spec>(),
      name: `producer-opt-out-${String(optOut)}`,
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
    // Seed hits so that each caller's producer call holds only its misses.
    await cache.store(
      ["a:0", "a:7", "b:3"].map((id) => ({
        id,
        content: id,
        directives: freshFor100,
      })),
    );
    const calls: string[][] = [];
    const client = wrapProducer({
      cache,
      ...(optOut ? { producerBatching: { maxBatchSize: Infinity } } : {}),
      produceMany: async (requests) => {
        calls.push(requests.map(({ id }) => id));
        await nextTurn();
        return requests.map(({ id }) => ({
          content: id,
          directives: freshFor100,
        }));
      },
    });
    const options = optOut ? { autoBatch: { producer: false as const } } : {};
    const [a, b] = await Promise.all(
      ["a", "b"].map(
        async (caller) =>
          await client.getMany(
            callerIds(caller).map((id) => ({ id })),
            options,
          ),
      ),
    );
    for (const [caller, results] of [
      ["a", a!],
      ["b", b!],
    ] as const) {
      assert.deepEqual(
        results.map((entry) =>
          entry instanceof Error ? entry : entry.content,
        ),
        callerIds(caller),
      );
    }
    await client.close();
    await cache.close();
    return calls;
  };

  it("gives each direct caller one producer call with only its own misses", async () => {
    const calls = await runTwoConcurrentCallers(true);
    const sorted = [...calls].sort((x, y) => x[0]!.localeCompare(y[0]!));
    assert.deepEqual(sorted, [
      callerIds("a").filter((id) => id !== "a:0" && id !== "a:7"),
      callerIds("b").filter((id) => id !== "b:3"),
    ]);
  });

  it("merges or splits the same callers without the opt-out", async () => {
    const calls = await runTwoConcurrentCallers(false);
    const mixesCallers = calls.some(
      (ids) => new Set(ids.map((id) => id.split(":")[0])).size > 1,
    );
    assert.ok(
      mixesCallers || calls.length > 2,
      `expected merged or split calls, got ${JSON.stringify(calls)}`,
    );
  });
});
