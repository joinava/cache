import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { bulkMemoryStore } from "../test/fixtures.js";
import {
  ACCEPT_ANY_REGISTRY,
  captureChannels,
  freshFor100,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import wrapProducer from "./utils/wrapProducer.js";

import {
  spiedStore,
  batchedCacheOver,
  lookup,
  suiteOptions,
  type Spec,
} from "../test/readBatchingHelpers.js";

describe("read dispatch diagnostics", () => {
  it("separates queue wait, physical dispatch duration, and logical wait", async (t) => {
    const { cacheReadStoreChannel, cacheReadChannel } =
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
    const physical: import("./diagnostics.js").CacheReadStoreMessage[] = [];
    const logical: import("./diagnostics.js").CacheReadMessage[] = [];
    const onPhysical = (
      message: import("./diagnostics.js").CacheReadStoreMessage,
    ) => {
      if (message.cache === cache.name) physical.push(message);
    };
    const onLogical = (
      message: import("./diagnostics.js").CacheReadMessage,
    ) => {
      if (message.cache === cache.name) logical.push(message);
    };
    cacheReadStoreChannel.subscribe(onPhysical);
    cacheReadChannel.subscribe(onLogical);
    t.after(async () => {
      cacheReadStoreChannel.unsubscribe(onPhysical);
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
    const { cacheReadStoreChannel } = await import("./diagnostics.js");
    const { store } = spiedStore({
      beforeGetMany: async () => {
        throw new Error("offline");
      },
    });
    const cache = batchedCacheOver(store);
    const messages: import("./diagnostics.js").CacheReadStoreMessage[] = [];
    const onRead = (
      message: import("./diagnostics.js").CacheReadStoreMessage,
    ) => {
      if (message.cache === cache.name) messages.push(message);
    };
    cacheReadStoreChannel.subscribe(onRead);
    t.after(async () => {
      cacheReadStoreChannel.unsubscribe(onRead);
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

describe("Store read diagnostics compatibility", suiteOptions, () => {
  for (const bulk of [false, true]) {
    it(`reports cancellation for a rejected direct ${bulk ? "bulk" : "single"} read`, async (t) => {
      const { cacheReadStoreChannel } = await import("./diagnostics.js");
      const store = bulk ? bulkMemoryStore<Spec>() : new MemoryStore<Spec>();
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const rejectAfterGate = async () => {
        started.resolve();
        await gate.promise;
        throw new Error("underlying read rejected");
      };
      if ("getMany" in store) t.mock.method(store, "getMany", rejectAfterGate);
      else t.mock.method(store, "get", rejectAfterGate);
      const cache = new Cache({
        store,
        name: `direct-cancel-${bulk}`,
        resourceTypes: ACCEPT_ANY_REGISTRY,
      });
      const messages: import("./diagnostics.js").CacheReadStoreMessage[] = [];
      const observe = (
        message: import("./diagnostics.js").CacheReadStoreMessage,
      ) => {
        if (message.cache === cache.name) messages.push(message);
      };
      cacheReadStoreChannel.subscribe(observe);
      t.after(async () => {
        cacheReadStoreChannel.unsubscribe(observe);
        await cache.close();
      });
      const controller = new AbortController();
      const read = cache.get(lookup("a"), {
        autoBatch: false,
        signal: controller.signal,
      });
      const rejected = assert.rejects(read);
      await started.promise;
      controller.abort();
      await rejected;
      assert.equal(messages.length, 0);
      gate.resolve();
      await cache.close();
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.operation, bulk ? "getMany" : "get");
      assert.equal(messages[0]?.outcome, "cancelled");
      assert.equal(messages[0]?.failedRequestCount, 0);
      assert.equal(messages[0]?.requestCount, 1);
      assert.equal(messages[0]?.entryCount, 0);
      assert.equal(messages[0]?.queueWaitTotalMs, 0);
    });
  }

  for (const autoBatch of [undefined, false] as const) {
    it(`reports partial slots as failure for ${autoBatch === false ? "direct" : "automatic"} reads`, async (t) => {
      const { cacheReadStoreChannel } = await import("./diagnostics.js");
      const store = bulkMemoryStore<Spec>();
      const cache = batchedCacheOver(store);
      await cache.store([
        { id: "good", content: "good", directives: freshFor100 },
      ]);
      const primitive = store.getMany.bind(store);
      t.mock.method(
        store,
        "getMany",
        async (...args: Parameters<typeof primitive>) => {
          const slots = await primitive(...args);
          return slots.map((slot, index) =>
            index === 0 ? new Error("bad slot") : slot,
          );
        },
      );
      const messages: import("./diagnostics.js").CacheReadStoreMessage[] = [];
      const observe = (
        message: import("./diagnostics.js").CacheReadStoreMessage,
      ) => {
        if (message.cache === cache.name) messages.push(message);
      };
      cacheReadStoreChannel.subscribe(observe);
      t.after(async () => {
        cacheReadStoreChannel.unsubscribe(observe);
        await cache.close();
      });
      const result = await cache.getMany(
        [lookup("bad"), lookup("good")],
        autoBatch === false ? { autoBatch } : undefined,
      );
      assert.ok(result[0] instanceof Error);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.outcome, "failure");
      assert.equal(messages[0]?.requestCount, 2);
      assert.equal(messages[0]?.failedRequestCount, 1);
      assert.equal(messages[0]?.entryCount, 1);
    });
  }
});

for (const settlement of ["queued", "success", "failure"] as const) {
  it(`preserves automatic Store accounting after ${settlement} cancellation`, async (t) => {
    const { cacheReadStoreChannel } = await import("./diagnostics.js");
    const scheduled = Promise.withResolvers<() => void>();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { store } = spiedStore({
      beforeGetMany: async () => {
        started.resolve();
        await gate.promise;
        if (settlement === "failure")
          throw new Error("Store failed after caller cancellation");
      },
    });
    const cache = new Cache({
      store,
      name: `automatic-cancel-${settlement}`,
      resourceTypes: ACCEPT_ANY_REGISTRY,
      readBatching: { batchScheduleFn: scheduled.resolve },
    });
    const messages: import("./diagnostics.js").CacheReadStoreMessage[] = [];
    const observe = (
      message: import("./diagnostics.js").CacheReadStoreMessage,
    ) => {
      if (message.cache === cache.name) messages.push(message);
    };
    cacheReadStoreChannel.subscribe(observe);
    t.after(async () => {
      cacheReadStoreChannel.unsubscribe(observe);
      await cache.close();
    });
    const controller = new AbortController();
    const read = cache.get(lookup("a"), { signal: controller.signal });
    const rejected = assert.rejects(read);
    const dispatch = await scheduled.promise;
    if (settlement !== "queued") {
      dispatch();
      await started.promise;
    }
    controller.abort();
    await rejected;
    assert.equal(messages.length, 0);
    dispatch();
    gate.resolve();
    await cache.close();
    if (settlement === "queued") assert.equal(messages.length, 0);
    else {
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.operation, "getMany");
      assert.equal(messages[0]?.outcome, settlement);
      assert.equal(
        messages[0]?.failedRequestCount,
        settlement === "failure" ? 1 : 0,
      );
    }
  });
}

it("publishes physical reads only on the v4 read-store channel", async () => {
  const { channel } = await import("node:diagnostics_channel");
  const current = channel("@zingage/cache:read-store");
  const previous = channel("@zingage/cache:read-batch");
  let currentEvents = 0;
  let previousEvents = 0;
  const onCurrent = () => {
    currentEvents += 1;
  };
  const onPrevious = () => {
    previousEvents += 1;
  };
  current.subscribe(onCurrent);
  previous.subscribe(onPrevious);
  try {
    for (const store of [new MemoryStore<Spec>(), bulkMemoryStore<Spec>()]) {
      const cache = new Cache({
        store,
        name: "read-store-wire",
        resourceTypes: ACCEPT_ANY_REGISTRY,
      });
      try {
        await cache.get(lookup("a"), { autoBatch: false });
      } finally {
        await cache.close();
      }
    }
    assert.equal(currentEvents, 2);
    assert.equal(previousEvents, 0);
  } finally {
    current.unsubscribe(onCurrent);
    previous.unsubscribe(onPrevious);
  }
});
