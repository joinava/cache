import assert from "node:assert/strict";
import { it } from "node:test";
import type { DispatchInfo } from "../batcher/batcher.js";
import { SingleProducerScheduler } from "./wrapSingleProducer.js";

const defaults = {
  logger: undefined,
  retain: () => () => {},
  collapseTasksMs: 1_000,
  makeKey: (request: string) => request,
};

it("sends each started task as its own invocation, and shares equal keys", async () => {
  const calls: { values: string[]; info: DispatchInfo }[] = [];
  const scheduler = new SingleProducerScheduler<string, string>({
    ...defaults,
    dispatch: async (requests, info) => {
      const values = requests.map(({ request }) => request);
      calls.push({ values, info });
      return await Promise.resolve(values);
    },
  });
  const outcomes = scheduler.startOrRideTasks([
    { request: "a" },
    { request: "b" },
    { request: "a" },
  ]);

  assert.deepEqual(await Promise.all(outcomes.map(({ promise }) => promise)), [
    "a",
    "b",
    "a",
  ]);
  assert.deepEqual(
    outcomes.map(({ rode }) => rode),
    [false, false, true],
  );
  assert.deepEqual(calls, [
    { values: ["a"], info: { autoBatched: false } },
    { values: ["b"], info: { autoBatched: false } },
  ]);
  await scheduler.close();
});

it("rejects a task whose slot is an Error, and wraps a non-Error rejection", async () => {
  const slotError = new Error("slot");
  const scheduler = new SingleProducerScheduler<string, string>({
    ...defaults,
    dispatch: async ([task]) => {
      if (task!.request === "slot") return [slotError];
      // oxlint-disable-next-line no-throw-literal -- the case under test
      throw "not an Error";
    },
  });
  const [slot, thrown] = scheduler.startOrRideTasks([
    { request: "slot" },
    { request: "thrown" },
  ]);

  await assert.rejects(slot!.promise, slotError);
  await assert.rejects(thrown!.promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    return true;
  });
  await scheduler.close();
});

it("ends each task's lease once the task settles", async () => {
  const events: string[] = [];
  const release = Promise.withResolvers<string[]>();
  const scheduler = new SingleProducerScheduler<string, string>({
    ...defaults,
    retain: (request) => {
      events.push(`retain ${request}`);
      return () => events.push(`release ${request}`);
    },
    dispatch: async () => release.promise,
  });
  const [outcome] = scheduler.startOrRideTasks([{ request: "a" }]);

  assert.deepEqual(events, ["retain a"]);
  release.resolve(["a"]);
  assert.equal(await outcome!.promise, "a");
  assert.deepEqual(events, ["retain a", "release a"]);
  await scheduler.close();
});

it("close waits for running tasks", async () => {
  const release = Promise.withResolvers<string[]>();
  const scheduler = new SingleProducerScheduler<string, string>({
    ...defaults,
    dispatch: async () => release.promise,
  });
  const [outcome] = scheduler.startOrRideTasks([{ request: "a" }]);
  let closed = false;
  const closing = scheduler.close().then(() => {
    closed = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve(["a"]);
  await closing;
  assert.equal(await outcome!.promise, "a");
});
