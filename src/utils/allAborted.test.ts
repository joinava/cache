import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";

import type { NonEmptyArray } from "type-party";
import { mapNonEmpty } from "type-party/runtime/nonempty.js";

import { allAborted } from "./allAborted.js";

/** The signal of each controller. */
const signalsOf = (controllers: Readonly<NonEmptyArray<AbortController>>) =>
  mapNonEmpty(controllers, ({ signal }) => signal);

/** The number of `abort` listeners on each controller's signal. */
const listenerCounts = (controllers: readonly AbortController[]) =>
  controllers.map(({ signal }) => getEventListeners(signal, "abort").length);

describe("allAborted", () => {
  it("does not accept an empty list in the types", () => {
    // Never called: only the type check of the call matters.
    const callWithEmptyList = () => {
      // @ts-expect-error -- an empty list is not a NonEmptyArray
      return allAborted([]);
    };
    assert.equal(typeof callWithEmptyList, "function");
  });

  it("gives the same signal back, and adds no listener, when every element is that signal", () => {
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
    ] as const;
    const { signal, stop } = allAborted(signalsOf(controllers));

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
    assert.equal(signal.aborted, false);
    assert.deepEqual(listenerCounts([late, early]), [1, 0]);

    const reason = new Error("late");
    late.abort(reason);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, reason);
  });

  it("gives an aborted signal when the different signals have all aborted already", () => {
    const reasons = [new Error("first"), new Error("second")] as const;
    const { signal } = allAborted(
      mapNonEmpty(reasons, (reason) => AbortSignal.abort(reason)),
    );

    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, reasons[1]);
  });

  it("stops listening on stop, and then never aborts", () => {
    const controllers = [new AbortController(), new AbortController()] as const;
    const { signal, stop } = allAborted(signalsOf(controllers));
    assert.deepEqual(listenerCounts(controllers), [1, 1]);

    controllers[0]?.abort();
    stop();
    assert.deepEqual(listenerCounts(controllers), [0, 0]);
    controllers[1]?.abort();
    assert.equal(signal.aborted, false);
  });
});
