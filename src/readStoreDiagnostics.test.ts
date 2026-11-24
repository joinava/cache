import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
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

/**
 * An upper bound for the queue wait of a read that nothing held back. The
 * wait is the real time from submit to the Store call, so it is not exactly 0.
 */
const SOON_MS = 15;

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
    const pending = Promise.all(
      [lookup("a"), lookup("b")].map(async (request) => cache.get(request)),
    );
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
    // The real time from submit to the Store call: small, but not 0.
    assert.ok(capture.readStore[0]!.queueWaitTotalMs! < SOON_MS);
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
      const read = cache.getMany([lookup("a")], {
        signal: controller.signal,
        autoBatch: false,
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
      assert.ok(message!.queueWaitTotalMs! < SOON_MS);
    });
  }

  it("does not cancel a Store call that carries the reads of two callers", async (t) => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { store, getManyRequestCounts } = spiedStore({
      beforeGetMany: async () => {
        started.resolve();
        await gate.promise;
      },
    });
    const cache = cacheOver(store, { name: "direct-mixed-cancel" });
    const capture = captureChannels(cache.name);
    t.after(async () => {
      capture.stop();
      await cache.close();
    });
    const controller = new AbortController();
    // Both reads skip the accumulation wait in one turn, so they share one
    // Store call. Only one of the two callers has this signal, so the Store
    // call does not get it.
    const cancelled = cache.get(lookup("a"), {
      signal: controller.signal,
      autoBatch: false,
    });
    const kept = cache.get(lookup("b"), { autoBatch: false });
    const rejected = assert.rejects(cancelled);
    await started.promise;
    controller.abort();
    await rejected;
    gate.resolve();
    assert.equal((await kept).usable, undefined);

    assert.deepEqual(getManyRequestCounts(), [2]);
    assert.equal(capture.readStore.length, 1);
    assert.equal(capture.readStore[0]?.outcome, "success");
    assert.equal(capture.readStore[0]?.autoBatched, false);
  });

  it("reports a Store call as automatic unless every read in it skipped the wait", async (t) => {
    const { store, getManyRequestCounts } = spiedStore();
    const scheduled: (() => void)[] = [];
    const cache = cacheOver(store, {
      name: "mixed-auto-batched",
      readBatching: { batchScheduleFn: (run) => scheduled.push(run) },
    });
    const capture = captureChannels(cache.name);
    t.after(async () => {
      capture.stop();
      await cache.close();
    });

    const accumulated = cache.get(lookup("a"));
    // The schedule makes "a" ready in the turn in which "b" skips the wait,
    // so one Store call takes both.
    const direct = cache.get(lookup("b"), { autoBatch: false });
    scheduled.forEach((run) => run());
    await Promise.all([accumulated, direct]);
    await cache.get(lookup("c"), { autoBatch: false });

    assert.deepEqual(getManyRequestCounts(), [2, 1]);
    assert.deepEqual(
      capture.readStore.map(({ autoBatched }) => autoBatched),
      [true, false],
    );
  });

  for (const mode of ["automatic", "direct"] as const) {
    it(`reports partial slots as failure for ${mode} reads`, async (t) => {
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
      const requests = [lookup("bad"), lookup("good")];
      const result =
        mode === "direct"
          ? await cache.getMany(requests, { autoBatch: false })
          : await Promise.all(
              requests.map(async (request) =>
                cache.get(request).catch((error: unknown) => error),
              ),
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

  /**
   * A cache whose automatic reads wait for the returned `dispatch`, over a
   * Store whose call stays open until `gate` resolves, and then fails if
   * `fails` is set.
   */
  const gatedAutomaticReads = (
    t: { after: (fn: () => Promise<void>) => void },
    name: string,
    fails: boolean,
  ) => {
    const scheduled = Promise.withResolvers<() => void>();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { store } = spiedStore({
      beforeGetMany: async () => {
        started.resolve();
        await gate.promise;
        if (fails) throw new Error("Store failed after caller cancellation");
      },
    });
    const cache = cacheOver(store, {
      name,
      readBatching: { batchScheduleFn: scheduled.resolve },
    });
    const capture = captureChannels(cache.name);
    t.after(async () => {
      capture.stop();
      await cache.close();
    });
    return { cache, capture, scheduled: scheduled.promise, started, gate };
  };

  it("emits nothing for an automatic read that is cancelled while it waits", async (t) => {
    const { cache, capture, scheduled, gate } = gatedAutomaticReads(
      t,
      "automatic-cancel-queued",
      false,
    );
    const controller = new AbortController();
    const rejected = assert.rejects(
      cache.get(lookup("a"), { signal: controller.signal }),
    );
    const dispatch = await scheduled;
    controller.abort();
    await rejected;
    dispatch();
    gate.resolve();
    await cache.close();
    assert.equal(capture.readStore.length, 0);
  });

  for (const fails of [false, true]) {
    const settlement = fails ? "failure" : "success";

    it(`cancels an automatic Store call whose reads all carry the aborted signal (Store ${settlement})`, async (t) => {
      const { cache, capture, scheduled, started, gate } = gatedAutomaticReads(
        t,
        `automatic-cancel-own-${settlement}`,
        fails,
      );
      const controller = new AbortController();
      // Two reads of one caller: every read of the Store call carries the
      // same signal, so the Store call gets it.
      const rejected = Promise.all(
        ["a", "b"].map(async (id) =>
          assert.rejects(cache.get(lookup(id), { signal: controller.signal })),
        ),
      );
      (await scheduled)();
      await started.promise;
      controller.abort();
      await rejected;
      assert.equal(capture.readStore.length, 0);
      gate.resolve();
      await cache.close();

      assert.equal(capture.readStore.length, 1);
      const [message] = capture.readStore;
      assert.equal(message?.operation, "getMany");
      assert.equal(message?.autoBatched, true);
      assert.equal(message?.requestCount, 2);
      // The Store call saw the abort, whatever the Store did after it.
      assert.equal(message?.outcome, "cancelled");
      assert.equal(message?.failedRequestCount, 0);
    });

    it(`preserves automatic Store accounting after ${settlement} cancellation when another caller shares the Store call`, async (t) => {
      const { cache, capture, scheduled, started, gate } = gatedAutomaticReads(
        t,
        `automatic-cancel-shared-${settlement}`,
        fails,
      );
      const controller = new AbortController();
      const rejected = assert.rejects(
        cache.get(lookup("a"), { signal: controller.signal }),
      );
      // This read has no signal, so the Store call gets none: the other
      // caller must not lose the call.
      const kept = cache.get(lookup("b")).then(
        () => "fulfilled",
        () => "rejected",
      );
      (await scheduled)();
      await started.promise;
      controller.abort();
      await rejected;
      assert.equal(capture.readStore.length, 0);
      gate.resolve();
      assert.equal(await kept, fails ? "rejected" : "fulfilled");
      await cache.close();

      assert.equal(capture.readStore.length, 1);
      const [message] = capture.readStore;
      assert.equal(message?.operation, "getMany");
      assert.equal(message?.outcome, settlement);
      assert.equal(message?.failedRequestCount, fails ? 2 : 0);
    });

    it(`keeps an automatic Store call (Store ${settlement}) while a caller with another signal still waits`, async (t) => {
      const { cache, capture, scheduled, started, gate } = gatedAutomaticReads(
        t,
        `automatic-cancel-one-of-two-${settlement}`,
        fails,
      );
      const cancelled = new AbortController();
      const waiting = new AbortController();
      const rejected = assert.rejects(
        cache.get(lookup("a"), { signal: cancelled.signal }),
      );
      // This read has another signal, which does not abort: the Store call
      // must complete for its caller.
      const kept = cache.get(lookup("b"), { signal: waiting.signal }).then(
        () => "fulfilled",
        () => "rejected",
      );
      (await scheduled)();
      await started.promise;
      cancelled.abort();
      await rejected;
      gate.resolve();
      assert.equal(await kept, fails ? "rejected" : "fulfilled");
      await cache.close();

      assert.equal(capture.readStore.length, 1);
      const [message] = capture.readStore;
      assert.equal(message?.requestCount, 2);
      assert.equal(message?.outcome, settlement);
      // Nothing listens to a caller's signal after the Store call is done.
      assert.equal(getEventListeners(waiting.signal, "abort").length, 0);
    });

    it(`cancels an automatic Store call (Store ${settlement}) when its callers with different signals have all aborted`, async (t) => {
      const { cache, capture, scheduled, started, gate } = gatedAutomaticReads(
        t,
        `automatic-cancel-all-different-${settlement}`,
        fails,
      );
      const controllers = [new AbortController(), new AbortController()];
      const rejections = controllers.map(async ({ signal }, index) =>
        assert.rejects(cache.get(lookup(`id-${index}`), { signal })),
      );
      (await scheduled)();
      await started.promise;
      controllers[0]?.abort();
      await rejections[0];
      controllers[1]?.abort();
      await rejections[1];
      assert.equal(capture.readStore.length, 0);
      gate.resolve();
      await cache.close();

      assert.equal(capture.readStore.length, 1);
      const [message] = capture.readStore;
      assert.equal(message?.requestCount, 2);
      // The Store call saw the abort only after the last caller cancelled.
      assert.equal(message?.outcome, "cancelled");
      assert.equal(message?.failedRequestCount, 0);
    });
  }

  it("publishes one read-store message per physical read, for get-only and getMany Stores", async () => {
    for (const store of [new MemoryStore<Spec>(), bulkMemoryStore<Spec>()]) {
      const cache = cacheOver(store, { name: "read-store-wire" });
      const capture = captureChannels(cache.name);
      try {
        await cache.getMany([lookup("a")], { autoBatch: false });
        assert.equal(capture.readStore.length, 1);
      } finally {
        capture.stop();
        await cache.close();
      }
    }
  });
});
