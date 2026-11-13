import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PendingPromisesTracker } from "./pendingPromisesTracker.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PendingPromisesTracker", () => {
  it("tracks a promise until it settles, and returns it unchanged", async () => {
    const tracker = new PendingPromisesTracker();
    const gate = Promise.withResolvers<string>();

    const tracked = tracker.track(gate.promise);
    assert.equal(tracked, gate.promise);
    assert.equal(tracker.size, 1);

    gate.resolve("done");
    await tracked;
    await tick();
    assert.equal(tracker.size, 0);
  });

  it("untracks a rejected promise without an unhandled rejection", async () => {
    const tracker = new PendingPromisesTracker();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const gate = Promise.withResolvers<never>();
      const tracked = tracker.track(gate.promise);
      gate.reject(new Error("boom"));
      await assert.rejects(tracked, /boom/);
      await tick();

      assert.equal(tracker.size, 0);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("run tracks the work before start runs, and turns a synchronous throw into a rejection", async () => {
    const tracker = new PendingPromisesTracker();
    const sizes: number[] = [];

    await tracker.run(async () => {
      sizes.push(tracker.size);
    });
    const thrown = tracker.run((): Promise<void> => {
      throw new Error("sync");
    });

    assert.deepEqual(sizes, [1]);
    await assert.rejects(thrown, /sync/);
  });

  it("drain waits for promises tracked while it waits", async () => {
    const tracker = new PendingPromisesTracker();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    void tracker.track(
      first.promise.then(() => {
        void tracker.track(second.promise);
      }),
    );

    let drained = false;
    const draining = tracker.drain().then(() => {
      drained = true;
    });
    first.resolve();
    await tick();
    assert.equal(drained, false);

    second.resolve();
    await draining;
    assert.equal(tracker.size, 0);
  });

  it("drain resolves when a tracked promise rejects", async () => {
    const tracker = new PendingPromisesTracker();
    void tracker.track(Promise.reject(new Error("boom"))).catch(() => {});

    await tracker.drain();
    assert.equal(tracker.size, 0);
  });
});
