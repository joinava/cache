import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bulkMemoryStore,
  cacheOver,
  lookup,
  spiedStore,
  suiteOptions,
  type Spec,
} from "../test/fixtures.js";
import { captureChannels, freshFor100 } from "../test/v2AcceptanceHelpers.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";

describe("read dispatch diagnostics", () => {
  it("separates queue wait, physical dispatch duration, and logical wait", async (t) => {
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
    const cache = cacheOver(store, {
      name: "read-clock",
      readBatching: { batchScheduleFn: (run) => scheduled.push(run) },
    });
    const capture = captureChannels(cache.name, { measurements: true });
    t.after(async () => {
      capture.stop();
      await cache.close();
    });
    const pending = cache.getMany([lookup("a"), lookup("b")]);
    clock.now = 70;
    scheduled.forEach((run) => run());
    await started.promise;
    assert.equal(capture.readStore.length, 0);
    assert.equal(capture.read.length, 0);
    clock.now = 110;
    gate.resolve();
    await pending;
    assert.equal(capture.readStore.length, 1);
    assert.equal(capture.readStore[0]?.queueWaitTotalMs, 40);
    assert.equal(capture.readStore[0]?.durationMs, 40);
    assert.equal(capture.readStore[0]?.requestCount, 2);
    assert.deepEqual(
      capture.read.map((message) => message.durationMs),
      [60, 60],
    );
  });

  it("counts one whole-operation failure separately from its affected slots", async (t) => {
    const { store } = spiedStore({
      beforeGetMany: async () => {
        throw new Error("offline");
      },
    });
    const cache = cacheOver(store);
    const capture = captureChannels(cache.name, { measurements: true });
    t.after(async () => {
      capture.stop();
      await cache.close();
    });
    const results = await cache.getMany([lookup("a"), lookup("b")], {
      autoBatch: false,
    });
    assert.equal(results[0], results[1]);
    assert.equal(capture.readStore.length, 1);
    assert.equal(capture.readStore[0]?.outcome, "failure");
    assert.equal(capture.readStore[0]?.failedRequestCount, 2);
    assert.equal(capture.readStore[0]?.queueWaitTotalMs, 0);
    assert.equal(capture.readStore[0]?.autoBatched, false);
  });
});

describe("read-store channel", suiteOptions, () => {
  for (const bulk of [false, true]) {
    it(`reports cancellation for a rejected direct ${bulk ? "bulk" : "single"} read`, async (t) => {
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const rejectAfterGate = async () => {
        started.resolve();
        await gate.promise;
        throw new Error("underlying read rejected");
      };
      const singleReadStore = () => {
        const single = new MemoryStore<Spec>();
        t.mock.method(single, "get", rejectAfterGate);
        return single;
      };
      const store = bulk
        ? spiedStore({ beforeGetMany: rejectAfterGate }).store
        : singleReadStore();
      const cache = cacheOver(store, { name: "direct-cancel" });
      const capture = captureChannels(cache.name, { measurements: true });
      t.after(async () => {
        capture.stop();
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
      assert.equal(capture.readStore.length, 0);
      gate.resolve();
      await cache.close();
      assert.equal(capture.readStore.length, 1);
      const [message] = capture.readStore;
      assert.equal(message?.operation, bulk ? "getMany" : "get");
      assert.equal(message?.outcome, "cancelled");
      assert.equal(message?.failedRequestCount, 0);
      assert.equal(message?.requestCount, 1);
      assert.equal(message?.entryCount, 0);
      assert.equal(message?.queueWaitTotalMs, 0);
    });
  }

  for (const autoBatch of [undefined, false] as const) {
    it(`reports partial slots as failure for ${autoBatch === false ? "direct" : "automatic"} reads`, async (t) => {
      const { store } = spiedStore({
        slotErrors: { bad: new Error("bad slot") },
      });
      const cache = cacheOver(store);
      await cache.store([
        { id: "good", content: "good", directives: freshFor100 },
      ]);
      const capture = captureChannels(cache.name);
      t.after(async () => {
        capture.stop();
        await cache.close();
      });
      const result = await cache.getMany(
        [lookup("bad"), lookup("good")],
        autoBatch === false ? { autoBatch } : undefined,
      );
      assert.ok(result[0] instanceof Error);
      assert.equal(capture.readStore.length, 1);
      const [message] = capture.readStore;
      assert.equal(message?.outcome, "failure");
      assert.equal(message?.requestCount, 2);
      assert.equal(message?.failedRequestCount, 1);
      assert.equal(message?.entryCount, 1);
    });
  }

  for (const settlement of ["queued", "success", "failure"] as const) {
    it(`preserves automatic Store accounting after ${settlement} cancellation`, async (t) => {
      const scheduled = Promise.withResolvers<() => void>();
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const { store } = spiedStore({
        beforeGetMany: async () => {
          started.resolve();
          await gate.promise;
          if (settlement === "failure") {
            throw new Error("Store failed after caller cancellation");
          }
        },
      });
      const cache = cacheOver(store, {
        name: `automatic-cancel-${settlement}`,
        readBatching: { batchScheduleFn: scheduled.resolve },
      });
      const capture = captureChannels(cache.name);
      t.after(async () => {
        capture.stop();
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
      assert.equal(capture.readStore.length, 0);
      dispatch();
      gate.resolve();
      await cache.close();
      if (settlement === "queued") assert.equal(capture.readStore.length, 0);
      else {
        assert.equal(capture.readStore.length, 1);
        const [message] = capture.readStore;
        assert.equal(message?.operation, "getMany");
        assert.equal(message?.outcome, settlement);
        assert.equal(
          message?.failedRequestCount,
          settlement === "failure" ? 1 : 0,
        );
      }
    });
  }

  it("publishes one read-store message per physical read, for get-only and getMany Stores", async () => {
    for (const store of [new MemoryStore<Spec>(), bulkMemoryStore<Spec>()]) {
      const cache = cacheOver(store, { name: "read-store-wire" });
      const capture = captureChannels(cache.name);
      try {
        await cache.get(lookup("a"), { autoBatch: false });
        assert.equal(capture.readStore.length, 1);
      } finally {
        capture.stop();
        await cache.close();
      }
    }
  });
});
