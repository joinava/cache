import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "../types/index.js";
import {
  Batcher,
  type BatchItem,
  type DispatchedItem,
  type DispatchInfo,
} from "./batcher.js";
import { TaskSharer } from "../scheduling/taskSharer.js";

function item(input: string, signal?: AbortSignal): BatchItem<string> {
  return { input, signal };
}

/**
 * A batcher whose flush runs only when the test calls `flush`. Each dispatch
 * is recorded, and resolves every item with its input in upper case.
 */
function recordingBatcher(
  options: { maxBatchSize?: number; logger?: Logger } = {},
) {
  const dispatches: DispatchedItem<string>[][] = [];
  const infos: DispatchInfo[] = [];
  const pendingFlushes: (() => void)[] = [];
  const batcher = new Batcher<string, string>({
    ...options,
    batchScheduleFn: (callback) => pendingFlushes.push(callback),
    dispatch: async (items, info) => {
      dispatches.push([...items]);
      infos.push(info);
      return items.map(({ input }) => input.toUpperCase());
    },
  });
  const runScheduledFlushes = () =>
    pendingFlushes.splice(0).forEach((callback) => callback());
  const inputs = () =>
    dispatches.map((items) => items.map(({ input }) => input));
  return {
    batcher,
    dispatches,
    infos,
    inputs,
    pendingFlushes,
    runScheduledFlushes,
  };
}

/** The handles of `enqueued`. Fails the test when an item was not queued. */
function handlesOf<Handle>(
  enqueued: readonly { readonly handle: Handle | undefined }[],
): Handle[] {
  return enqueued.map(({ handle }) => {
    assert.ok(handle, "the item was not queued");
    return handle;
  });
}

describe("Batcher", () => {
  it("accumulates entries until the flush, and splits them at maxBatchSize", async () => {
    const { batcher, dispatches, infos, inputs, runScheduledFlushes } =
      recordingBatcher({ maxBatchSize: 2 });

    const first = batcher.enqueue([item("a")]);
    const second = batcher.enqueue([item("b"), item("c")]);
    assert.equal(dispatches.length, 0);

    runScheduledFlushes();
    assert.deepEqual(inputs(), [["a", "b"], ["c"]]);
    assert.ok(infos.every(({ autoBatched }) => autoBatched));
    assert.deepEqual(
      await Promise.all([...first, ...second].map(({ result }) => result)),
      ["A", "B", "C"],
    );
  });

  it("schedules one dispatch per batch, as DataLoader does, and never sends a full batch early", () => {
    const { batcher, inputs, pendingFlushes } = recordingBatcher({
      maxBatchSize: 2,
    });

    batcher.enqueue([item("a"), item("b"), item("c")]);
    assert.equal(pendingFlushes.length, 2);
    assert.deepEqual(inputs(), []);

    pendingFlushes[0]!();
    assert.deepEqual(inputs(), [["a", "b"]]);
    pendingFlushes[1]!();
    assert.deepEqual(inputs(), [["a", "b"], ["c"]]);
  });

  it("dispatches every entry when batchScheduleFn runs its callback synchronously", async () => {
    const dispatched: string[][] = [];
    const batcher = new Batcher<string, string>({
      maxBatchSize: 2,
      batchScheduleFn: (callback) => callback(),
      dispatch: async (items) => {
        dispatched.push(items.map(({ input }) => input));
        return items.map(({ input }) => input);
      },
    });

    const entries = batcher.enqueue([item("a"), item("b"), item("c")]);
    assert.deepEqual(dispatched, [["a", "b"], ["c"]]);
    assert.deepEqual(await Promise.all(entries.map(({ result }) => result)), [
      "a",
      "b",
      "c",
    ]);
  });

  it("lets the open batch take a new entry in place of a cancelled one", async () => {
    const { batcher, inputs, pendingFlushes, runScheduledFlushes } =
      recordingBatcher({ maxBatchSize: 2 });
    const cancel = new AbortController();

    const [cancelled] = batcher.enqueue([item("a", cancel.signal), item("b")]);
    cancel.abort(new Error("gone"));
    await assert.rejects(cancelled!.result);
    batcher.enqueue([item("c")]);
    assert.equal(pendingFlushes.length, 1);

    runScheduledFlushes();
    assert.deepEqual(inputs(), [["b", "c"]]);
  });

  it("close sends every pending batch now, batches later entries on the default schedule, and resolves once idle", async () => {
    const { batcher, inputs, pendingFlushes } = recordingBatcher({
      maxBatchSize: 2,
    });

    batcher.enqueue([item("a"), item("b"), item("c")]);
    const closed = batcher.close();
    assert.equal(batcher.close(), closed);
    assert.deepEqual(inputs(), [["a", "b"], ["c"]]);

    // The owner's scheduler is dropped, so these wait for the default
    // schedule instead of the test's flush callbacks.
    const flushesBefore = pendingFlushes.length;
    const late = batcher.enqueue([item("d"), item("e"), item("f")]);
    assert.equal(pendingFlushes.length, flushesBefore);
    assert.equal(inputs().length, 2);

    await closed;
    assert.deepEqual(inputs().slice(2), [["d", "e"], ["f"]]);
    assert.deepEqual(await Promise.all(late.map(({ result }) => result)), [
      "D",
      "E",
      "F",
    ]);
  });

  it("flush sends every pending batch now, batches later entries on the default schedule, and stays open", async () => {
    const warnings: string[] = [];
    const { batcher, inputs, pendingFlushes } = recordingBatcher({
      maxBatchSize: 2,
      logger: (_component, level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });

    batcher.enqueue([item("a"), item("b"), item("c")]);
    batcher.flush();
    assert.deepEqual(inputs(), [["a", "b"], ["c"]]);

    const flushesBefore = pendingFlushes.length;
    const late = batcher.enqueue([item("d")]);
    assert.equal(pendingFlushes.length, flushesBefore);
    assert.deepEqual(await Promise.all(late.map(({ result }) => result)), [
      "D",
    ]);
    assert.deepEqual(inputs().slice(2), [["d"]]);
    assert.deepEqual(warnings, []);
  });

  it("runs a batch that close sends early in the closer's context, or with preserveAsyncContext in its opener's", async () => {
    const context = new AsyncLocalStorage<string>();
    const observed = await Promise.all(
      [false, true].map(async (preserveAsyncContext) => {
        const seen: (string | undefined)[] = [];
        const batcher = new Batcher<string, string>({
          preserveAsyncContext,
          batchScheduleFn: () => {},
          dispatch: async (items) => {
            seen.push(context.getStore());
            return items.map(({ input }) => input);
          },
        });
        context.run("opener", () => batcher.enqueue([item("a")]));
        await context.run("closer", () => batcher.close());
        return seen;
      }),
    );
    assert.deepEqual(observed, [["closer"], ["opener"]]);
  });

  it("after close, warns on enqueue and batches on the default schedule", async () => {
    const warnings: string[] = [];
    const { batcher, inputs, pendingFlushes } = recordingBatcher({
      logger: (_component, level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });

    await batcher.close();
    const entries = batcher.enqueue([item("a"), item("b")]);
    assert.deepEqual(warnings, ["enqueue called after close"]);
    assert.equal(pendingFlushes.length, 0, "the owner's scheduler is dropped");
    assert.deepEqual(inputs(), []);

    assert.deepEqual(await Promise.all(entries.map(({ result }) => result)), [
      "A",
      "B",
    ]);
    assert.deepEqual(inputs(), [["a", "b"]]);
  });

  it("dispatches the handles' still-queued entries as one unsplit call, and skips running ones", () => {
    const { batcher, dispatches, infos, inputs, runScheduledFlushes } =
      recordingBatcher({ maxBatchSize: 1 });

    const [queuedByOther] = batcher.enqueue([item("a")]);
    const mine = batcher.enqueue([item("b"), item("c")]);
    void batcher.dispatchNow(handlesOf([queuedByOther!, ...mine]));
    assert.deepEqual(inputs(), [["a", "b", "c"]]);
    assert.equal(infos[0]!.autoBatched, false);

    // The entries are running, so neither a second dispatchNow nor the
    // scheduled flush sends them again.
    void batcher.dispatchNow(handlesOf(mine));
    runScheduledFlushes();
    assert.equal(dispatches.length, 1);
  });

  it("dispatchNow sends new items with the handles' queued entries, never in a batch, and rejects a cancelled item", async () => {
    const { batcher, infos, inputs, pendingFlushes, runScheduledFlushes } =
      recordingBatcher({ maxBatchSize: 1 });

    const [queued] = batcher.enqueue([item("a")]);
    const flushesBefore = pendingFlushes.length;
    const reason = new Error("gone");
    const [b, cancelled, c] = batcher.dispatchNow(handlesOf([queued!]), [
      item("b"),
      item("x", AbortSignal.abort(reason)),
      item("c"),
    ]);
    assert.equal(pendingFlushes.length, flushesBefore, "no batch was opened");
    assert.deepEqual(inputs(), [["a", "b", "c"]]);
    assert.deepEqual(infos, [{ autoBatched: false }]);
    await assert.rejects(cancelled!, reason);
    assert.deepEqual(await Promise.all([queued!.result, b!, c!]), [
      "A",
      "B",
      "C",
    ]);
    runScheduledFlushes();
    assert.equal(inputs().length, 1);
  });

  it("rejects an already-cancelled item at enqueue, gives it no handle, and queues the others", async () => {
    const { batcher, inputs, runScheduledFlushes } = recordingBatcher({
      maxBatchSize: 2,
    });
    const reason = new Error("gone");

    const [a, cancelled, b] = batcher.enqueue([
      item("a"),
      item("x", AbortSignal.abort(reason)),
      item("b"),
    ]);
    assert.equal(cancelled!.handle, undefined);
    await assert.rejects(cancelled!.result, reason);

    runScheduledFlushes();
    assert.deepEqual(inputs(), [["a", "b"]], "it took no slot in the batch");
    assert.deepEqual(await Promise.all([a!.result, b!.result]), ["A", "B"]);
  });

  it("drops a queued entry when its task's signal aborts, but not a running one", async () => {
    const { batcher, inputs, runScheduledFlushes } = recordingBatcher();
    const cancelQueued = new AbortController();
    const cancelRunning = new AbortController();

    const [queued] = batcher.enqueue([item("a", cancelQueued.signal)]);
    cancelQueued.abort(new Error("gone"));
    await assert.rejects(queued!.result, { message: "gone" });

    const [running] = batcher.enqueue([item("b", cancelRunning.signal)]);
    runScheduledFlushes();
    cancelRunning.abort();
    assert.equal(await running!.result, "B");
    assert.deepEqual(inputs(), [["b"]]);
  });

  it("with a sharer, sends a direct call's new and still-queued ridden work as one dispatch", async () => {
    const { batcher, inputs, runScheduledFlushes } = recordingBatcher();
    const sharer = new TaskSharer<
      string,
      string,
      ReturnType<typeof batcher.enqueue>[number]["handle"]
    >({
      collapseTasksMs: 1_000,
      makeKey: (input) => input,
      schedule: (toStart) =>
        batcher.enqueue(
          toStart.map((view) => ({ input: view.input, signal: view.signal })),
        ),
    });

    // An automatic caller queues "a" and waits for the flush.
    const [auto] = sharer.startOrRideTasks([{ input: "a" }]);

    // A direct caller rides "a" and starts "b", then dispatches both now.
    const direct = sharer.startOrRideTasks([{ input: "a" }, { input: "b" }]);
    void batcher.dispatchNow(
      direct.flatMap(({ handle }) => (handle ? [handle] : [])),
    );

    assert.deepEqual(inputs(), [["a", "b"]]);
    runScheduledFlushes();
    assert.equal(inputs().length, 1);
    assert.deepEqual(
      await Promise.all([auto, ...direct].map((outcome) => outcome!.result)),
      ["A", "A", "B"],
    );
  });
});
