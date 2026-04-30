import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "timers/promises";
import { raceWithSignal } from "./utils.js";

describe("raceWithSignal", () => {
  it("should return the promise result when signal is undefined", async () => {
    const result = await raceWithSignal(Promise.resolve("ok"), undefined);
    assert.equal(result, "ok");
  });

  it("should return the promise result when signal is not aborted", async () => {
    const controller = new AbortController();
    const result = await raceWithSignal(
      Promise.resolve("ok"),
      controller.signal,
    );
    assert.equal(result, "ok");
  });

  it("should reject immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already"));

    await assert.rejects(
      async () => raceWithSignal(Promise.resolve("ok"), controller.signal),
      { message: "already" },
    );
  });

  it("should reject when signal aborts before promise settles", async () => {
    const controller = new AbortController();
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow"), 200);
    });

    const resultPromise = raceWithSignal(slowPromise, controller.signal);
    await delay(10);
    controller.abort(new Error("cancelled"));

    await assert.rejects(async () => resultPromise, { message: "cancelled" });
  });

  it("should resolve if promise settles before signal aborts", async () => {
    const controller = new AbortController();
    const fastPromise = Promise.resolve("fast");

    const result = await raceWithSignal(fastPromise, controller.signal);
    assert.equal(result, "fast");

    // Aborting after settlement should have no effect.
    controller.abort(new Error("too-late"));
  });

  it("should propagate promise rejection even with a signal", async () => {
    const controller = new AbortController();
    const failingPromise = Promise.reject(new Error("boom"));

    await assert.rejects(
      async () => raceWithSignal(failingPromise, controller.signal),
      { message: "boom" },
    );
  });

  it("should use the signal's reason as the rejection value", async () => {
    const controller = new AbortController();
    const neverSettles = new Promise<string>(() => {});

    const resultPromise = raceWithSignal(neverSettles, controller.signal);
    controller.abort("custom-reason");

    try {
      await resultPromise;
      throw new Error("should have rejected");
    } catch (e) {
      assert.equal(e, "custom-reason");
    }
  });

  it("should reject with the signal reason (not the promise error) when both are already settled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("signal-reason"));
    const alreadyRejected = Promise.reject(new Error("promise-reason"));

    await assert.rejects(
      async () => raceWithSignal(alreadyRejected, controller.signal),
      { message: "signal-reason" },
    );

    // The key concern: the already-rejected promise should not cause an
    // unhandledRejection. If it does, the test runner will report it as a
    // failure. Waiting a tick gives Node's rejection tracking time to fire.
    await new Promise((r) => setTimeout(r, 0));
  });
});
