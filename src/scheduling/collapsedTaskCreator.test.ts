import assert from "node:assert/strict";
import { describe, it } from "node:test";
import collapsedTaskCreator from "./collapsedTaskCreator.js";

const silent = () => {};

/**
 * A task creator that records each call's arguments and returns a pending
 * promise. `settle(i)` resolves call `i` with its arguments joined by ",";
 * `fail(i)` rejects it.
 */
function recordingTaskCreator() {
  const calls: { args: string[]; deferred: PromiseWithResolvers<string> }[] =
    [];
  const taskCreator = (...args: string[]) => {
    const deferred = Promise.withResolvers<string>();
    calls.push({ args, deferred });
    return deferred.promise;
  };
  return {
    calls,
    taskCreator,
    settle: (i: number) => calls[i]!.deferred.resolve(calls[i]!.args.join(",")),
    fail: (i: number, error: Error) => calls[i]!.deferred.reject(error),
  };
}

describe("collapsedTaskCreator", () => {
  it("shares one pending task between calls with the same key", async () => {
    const { calls, taskCreator, settle } = recordingTaskCreator();
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      (args) => args[0],
      silent,
    );

    const first = run("a", "1");
    const second = run("a", "2");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ["a", "1"]);

    settle(0);
    assert.deepEqual(await Promise.all([first, second]), ["a,1", "a,1"]);
  });

  it("starts a separate task for each key", async () => {
    const { calls, taskCreator, settle } = recordingTaskCreator();
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      (args) => args[0],
      silent,
    );

    const a = run("a");
    const b = run("b");
    assert.deepEqual(
      calls.map(({ args }) => args),
      [["a"], ["b"]],
    );

    settle(0);
    settle(1);
    assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  });

  it("starts a new task once the previous one has settled", async () => {
    const { calls, taskCreator, settle } = recordingTaskCreator();
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      (args) => args[0],
      silent,
    );

    const first = run("a");
    settle(0);
    assert.equal(await first, "a");

    const second = run("a");
    assert.equal(calls.length, 2);
    settle(1);
    assert.equal(await second, "a");
  });

  it("starts a new task when the pending one is older than collapseTasksMs, and keeps sharing the newer one after the older settles", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const { calls, taskCreator, settle } = recordingTaskCreator();
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      (args) => args[0],
      silent,
    );

    const first = run("a", "1");
    t.mock.timers.tick(1_000);
    const second = run("a", "2");
    assert.equal(
      calls.length,
      1,
      "a task exactly collapseTasksMs old is shared",
    );

    t.mock.timers.tick(1);
    const third = run("a", "3");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]!.args, ["a", "3"]);

    settle(0);
    assert.deepEqual(await Promise.all([first, second]), ["a,1", "a,1"]);

    const fourth = run("a", "4");
    assert.equal(
      calls.length,
      2,
      "the older task's settling keeps the newer one",
    );

    settle(1);
    assert.deepEqual(await Promise.all([third, fourth]), ["a,3", "a,3"]);
  });

  it("shares a rejection, then starts a new task", async () => {
    const { calls, taskCreator, fail, settle } = recordingTaskCreator();
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      (args) => args[0],
      silent,
    );

    const first = run("a");
    const second = run("a");
    const error = new Error("boom");
    fail(0, error);
    await assert.rejects(first, error);
    await assert.rejects(second, error);

    const third = run("a");
    assert.equal(calls.length, 2);
    settle(1);
    assert.equal(await third, "a");
  });

  it("rejects when the task creator throws synchronously, and shares nothing", async () => {
    const error = new Error("sync");
    let calls = 0;
    const run = collapsedTaskCreator(
      (fail: boolean) => {
        calls += 1;
        if (fail) throw error;
        return Promise.resolve("ok");
      },
      1_000,
      () => "same-key",
      silent,
    );

    await assert.rejects(run(true), error);
    assert.equal(await run(false), "ok");
    assert.equal(calls, 2);
  });

  it("rejects when makeKey throws, without calling the task creator", async () => {
    const error = new Error("key");
    const { calls, taskCreator } = recordingTaskCreator();
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      () => {
        throw error;
      },
      silent,
    );

    await assert.rejects(run("a"), error);
    assert.equal(calls.length, 0);
  });

  it("treats an undefined key as an ordinary key", async () => {
    const { calls, taskCreator, settle } = recordingTaskCreator();
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      () => undefined,
      silent,
    );

    const first = run("a");
    const second = run("b");
    assert.equal(calls.length, 1);

    settle(0);
    assert.deepEqual(await Promise.all([first, second]), ["a", "a"]);
  });

  it("compares non-string keys by identity", async () => {
    const { calls, taskCreator, settle } = recordingTaskCreator();
    const shared = { id: 1 };
    const keys = new Map<string, object>([
      ["a", shared],
      ["b", shared],
      ["c", { id: 1 }],
    ]);
    const run = collapsedTaskCreator(
      taskCreator,
      1_000,
      (args) => keys.get(args[0]!)!,
      silent,
    );

    const a = run("a");
    const b = run("b");
    const c = run("c");
    assert.equal(calls.length, 2);

    settle(0);
    settle(1);
    assert.deepEqual(await Promise.all([a, b, c]), ["a", "a", "c"]);
  });
});
