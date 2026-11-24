import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";

import { allAborted } from "./allAborted.js";

/** The number of `abort` listeners on each controller's signal. */
const listenerCounts = (controllers: readonly AbortController[]) =>
  controllers.map(({ signal }) => getEventListeners(signal, "abort").length);

describe("allAborted", () => {
  it("gives no signal when there is no caller", () => {
    assert.equal(allAborted([]).signal, undefined);
  });

  it("gives no signal when no caller has a signal", () => {
    assert.equal(allAborted([undefined, undefined]).signal, undefined);
  });

  it("gives no signal, and adds no listener, when only some callers have a signal", () => {
    const controllers = [new AbortController(), new AbortController()];
    const [a, b] = controllers.map(({ signal }) => signal);

    for (const signals of [
      [a, undefined, b],
      [undefined, a, b],
      [a, b, undefined],
    ]) {
      assert.equal(allAborted(signals).signal, undefined);
    }
    assert.deepEqual(listenerCounts(controllers), [0, 0]);
  });

  it("gives the callers' own signal, and adds no listener, when every caller has the same signal", () => {
    const controller = new AbortController();
    const { signal } = controller;

    assert.equal(allAborted([signal]).signal, signal);
    assert.equal(allAborted([signal, signal, signal]).signal, signal);
    assert.deepEqual(listenerCounts([controller]), [0]);
  });

  it("aborts when the last of the different signals aborts, with the reason of that signal", () => {
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    const { signal, stop } = allAborted(controllers.map((it) => it.signal));
    assert.ok(signal);

    controllers[1]?.abort(new Error("second"));
    controllers[2]?.abort(new Error("third"));
    assert.equal(signal.aborted, false);

    const last = new Error("first");
    controllers[0]?.abort(last);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, last);
    // Each signal removed its listener when it aborted.
    assert.deepEqual(listenerCounts(controllers), [0, 0, 0]);
    stop();
  });

  it("counts a signal that occurs more than once as one signal", () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = allAborted([a.signal, b.signal, a.signal, b.signal]);
    assert.ok(signal);
    assert.deepEqual(listenerCounts([a, b]), [1, 1]);

    a.abort();
    assert.equal(signal.aborted, false);
    b.abort();
    assert.equal(signal.aborted, true);
  });

  it("counts a signal that has aborted already as aborted", () => {
    const early = new AbortController();
    early.abort(new Error("early"));
    const late = new AbortController();
    const { signal } = allAborted([late.signal, early.signal]);
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    assert.deepEqual(listenerCounts([late, early]), [1, 0]);

    const reason = new Error("late");
    late.abort(reason);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, reason);
  });

  it("gives an aborted signal when the different signals have all aborted already", () => {
    const reasons = [new Error("first"), new Error("second")];
    const signals = reasons.map((reason) => AbortSignal.abort(reason));
    const { signal } = allAborted(signals);

    assert.equal(signal?.aborted, true);
    assert.equal(signal?.reason, reasons[1]);
  });

  it("stops listening on stop, and then never aborts", () => {
    const controllers = [new AbortController(), new AbortController()];
    const { signal, stop } = allAborted(controllers.map((it) => it.signal));
    assert.ok(signal);
    assert.deepEqual(listenerCounts(controllers), [1, 1]);

    controllers[0]?.abort();
    stop();
    assert.deepEqual(listenerCounts(controllers), [0, 0]);
    controllers[1]?.abort();
    assert.equal(signal.aborted, false);
  });
});
