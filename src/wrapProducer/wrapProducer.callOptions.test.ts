import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { cacheOver, spiedStore, suiteOptions } from "../../test/fixtures.js";
import {
  captureChannels,
  freshFor100,
  waitUntil,
} from "../../test/v2AcceptanceHelpers.js";
import wrapProducer from "./wrapProducer.js";

/**
 * A producer whose calls stay open until the test releases them. `single`
 * and `bulk` record the same call list, so a test can wrap either.
 */
const gatedProducer = () => {
  const calls: { ids: string[]; release: () => void }[] = [];
  const counts = { running: 0, maxRunning: 0 };
  const run = async (ids: string[]) => {
    const gate = Promise.withResolvers<void>();
    const callNumber = calls.push({ ids, release: gate.resolve });
    counts.running += 1;
    counts.maxRunning = Math.max(counts.maxRunning, counts.running);
    await gate.promise;
    counts.running -= 1;
    return ids.map((id) => ({
      content: `${id}@${String(callNumber)}`,
      directives: freshFor100,
    }));
  };
  return {
    calls,
    counts,
    single: async ({ id }: { id: string }) => (await run([id]))[0]!,
    bulk: async (requests: readonly { id: string }[]) =>
      run(requests.map(({ id }) => id)),
    /** Releases call `index` once the producer has received it. */
    release: async (index: number) => {
      await waitUntil(() => calls.length > index, "calls.length > index");
      calls[index]!.release();
    },
  };
};

const bypass = { directives: { maxAge: 0 } } as const;

describe("joinInFlight: false", suiteOptions, () => {
  it("starts a new producer call instead of joining one that is running", async (t) => {
    const producer = gatedProducer();
    const cache = cacheOver();
    const client = wrapProducer({ cache, produce: producer.single });
    t.after(async () => {
      await client.close();
      await cache.close();
    });

    const beforeWrite = client.get({ id: "a", ...bypass });
    await waitUntil(
      () => producer.calls.length === 1,
      "producer.calls.length === 1",
    );
    // An ordinary bypass request joins the running call.
    const joined = client.get({ id: "a", ...bypass });
    const afterWrite = client.get(
      { id: "a", ...bypass },
      { joinInFlight: false },
    );
    await waitUntil(
      () => producer.calls.length === 2,
      "producer.calls.length === 2",
    );
    // A later ordinary request joins the newer call.
    const later = client.get({ id: "a", ...bypass });

    await producer.release(0);
    await producer.release(1);
    const results = await Promise.all([beforeWrite, joined, afterWrite, later]);

    assert.equal(producer.calls.length, 2);
    assert.equal(results[0].content, results[1].content);
    assert.equal(results[2].content, results[3].content);
    assert.notEqual(results[0].content, results[2].content);
  });

  it("lets the call's own duplicate requests share one producer call", async (t) => {
    const producer = gatedProducer();
    const cache = cacheOver();
    const client = wrapProducer({ cache, produce: producer.single });
    t.after(async () => {
      await client.close();
      await cache.close();
    });

    // A single producer's call starts at once, so the second copy finds work
    // whose producer call has started. It still joins it, because its own
    // call started that work.
    const duplicates = client.getMany(
      [
        { id: "a", ...bypass },
        { id: "a", ...bypass },
      ],
      { joinInFlight: false },
    );
    // Another call with `joinInFlight: false` does not join it.
    const other = client.get({ id: "a", ...bypass }, { joinInFlight: false });
    await producer.release(0);
    await producer.release(1);
    const [first, second] = await duplicates;
    await other;

    assert.equal(producer.calls.length, 2);
    assert.ok(!(first instanceof Error) && !(second instanceof Error));
    assert.equal(first.content, second.content);
  });

  it("still joins bulk work that waits in a batch", async (t) => {
    const producer = gatedProducer();
    const scheduled: (() => void)[] = [];
    const cache = cacheOver();
    const client = wrapProducer({
      cache,
      produceMany: producer.bulk,
      producerBatching: { batchScheduleFn: (run) => scheduled.push(run) },
    });
    t.after(async () => {
      await client.close();
      await cache.close();
    });

    const first = client.get({ id: "a", ...bypass });
    const second = client.get({ id: "a", ...bypass }, { joinInFlight: false });
    await waitUntil(() => scheduled.length === 1, "scheduled.length === 1");
    scheduled.forEach((run) => run());
    await producer.release(0);
    await Promise.all([first, second]);

    assert.deepEqual(
      producer.calls.map(({ ids }) => ids),
      [["a"]],
    );
  });
});

describe("maxConcurrentProducerCalls", suiteOptions, () => {
  it("limits a single producer's fan-out, and waiting work stays joinable", async (t) => {
    const producer = gatedProducer();
    const cache = cacheOver();
    const client = wrapProducer({
      cache,
      produce: producer.single,
      maxConcurrentProducerCalls: 2,
      // Only work that waits can be joined after this.
      collapseOverlappingRequestsTime: 0,
    });
    t.after(async () => {
      await client.close();
      await cache.close();
    });

    const many = client.getMany(["a", "b", "c", "d"].map((id) => ({ id })));
    await waitUntil(
      () => producer.calls.length === 2,
      "producer.calls.length === 2",
    );
    await nextTurn();
    assert.equal(producer.calls.length, 2);
    // "d" still waits for a slot, so this request joins it. It joins after
    // its own cache read, so give that read a turn before a slot frees.
    const rider = client.get({ id: "d" });
    await nextTurn();

    await producer.release(0);
    await producer.release(1);
    await producer.release(2);
    await producer.release(3);
    const [results, ridden] = await Promise.all([many, rider]);

    assert.equal(producer.counts.maxRunning, 2);
    assert.deepEqual(
      producer.calls.map(({ ids }) => ids),
      [["a"], ["b"], ["c"], ["d"]],
    );
    const last = results[3]!;
    assert.ok(!(last instanceof Error));
    assert.equal(ridden.content, last.content);
  });

  it("removes waiting work when its only caller aborts", async (t) => {
    const producer = gatedProducer();
    const cache = cacheOver();
    const client = wrapProducer({
      cache,
      produce: producer.single,
      maxConcurrentProducerCalls: 1,
    });
    t.after(async () => {
      await client.close();
      await cache.close();
    });
    const controller = new AbortController();
    const reason = new Error("stop");

    const running = client.get({ id: "a" });
    await waitUntil(
      () => producer.calls.length === 1,
      "producer.calls.length === 1",
    );
    const cancelled = client.get({ id: "b" }, { signal: controller.signal });
    const kept = client.get({ id: "c" });
    await nextTurn();
    await nextTurn();
    controller.abort(reason);
    await assert.rejects(cancelled, reason);

    await producer.release(0);
    await producer.release(1);
    await Promise.all([running, kept]);
    assert.deepEqual(
      producer.calls.map(({ ids }) => ids),
      [["a"], ["c"]],
    );
  });

  it("gives a bulk producer fuller batches, and counts the wait as queue time", async (t) => {
    const producer = gatedProducer();
    const cache = cacheOver();
    const client = wrapProducer({
      cache,
      produceMany: producer.bulk,
      producerBatching: { maxBatchSize: 3 },
      maxConcurrentProducerCalls: 1,
    });
    t.after(async () => {
      await client.close();
      await cache.close();
    });
    const capture = captureChannels(cache.name, { measurements: true });
    try {
      const first = client.get({ id: "a" });
      await waitUntil(
        () => producer.calls.length === 1,
        "producer.calls.length === 1",
      );
      // Separate turns: without the limit, each would be its own call.
      const waiting = [client.get({ id: "b" })];
      await nextTurn();
      await nextTurn();
      waiting.push(client.get({ id: "c" }));
      await nextTurn();
      await nextTurn();
      waiting.push(client.get({ id: "d" }), client.get({ id: "e" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(producer.calls.length, 1);

      await producer.release(0);
      await producer.release(1);
      await producer.release(2);
      await Promise.all([first, ...waiting]);

      assert.deepEqual(
        producer.calls.map(({ ids }) => ids),
        [["a"], ["b", "c", "d"], ["e"]],
      );
      assert.equal(producer.counts.maxRunning, 1);
      assert.ok(capture.produce[1]!.queueWaitTotalMs! >= 15);
    } finally {
      capture.stop();
    }
  });

  it("rejects a limit that is not a positive integer", () => {
    const cache = cacheOver();
    assert.throws(
      () =>
        wrapProducer({
          cache,
          produce: gatedProducer().single,
          maxConcurrentProducerCalls: 1.5,
        }),
      TypeError,
    );
  });
});

describe("get", suiteOptions, () => {
  it("with autoBatch.producer: false skips the producer's accumulation wait", async (t) => {
    const producer = gatedProducer();
    const scheduled: (() => void)[] = [];
    const cache = cacheOver();
    const client = wrapProducer({
      cache,
      produceMany: producer.bulk,
      producerBatching: { batchScheduleFn: (run) => scheduled.push(run) },
    });
    t.after(async () => {
      scheduled.forEach((run) => run());
      await client.close();
      await cache.close();
    });
    const capture = captureChannels(cache.name);
    try {
      const queued = client.get({ id: "queued" });
      const direct = client.get(
        { id: "a" },
        { autoBatch: { producer: false } },
      );
      // The direct call does not wait for the batch schedule.
      await producer.release(0);
      assert.equal((await direct).content, "a@1");
      assert.deepEqual(producer.calls[0]!.ids, ["a"]);
      assert.equal(capture.produce[0]!.autoBatched, false);

      scheduled.splice(0).forEach((run) => run());
      await producer.release(1);
      await queued;
    } finally {
      capture.stop();
    }
  });

  it("with autoBatch.store: false reads the Store without the accumulation wait", async (t) => {
    const { store, getManyRequestCounts } = spiedStore();
    const scheduled: (() => void)[] = [];
    const cache = cacheOver(store, {
      readBatching: { batchScheduleFn: (run) => scheduled.push(run) },
    });
    await cache.store([
      { id: "a", content: "stored", directives: freshFor100 },
    ]);
    const client = wrapProducer({
      cache,
      produce: async ({ id }) => ({ content: id, directives: freshFor100 }),
    });
    t.after(async () => {
      await client.close();
      await cache.close();
    });

    const entry = await client.get(
      { id: "a" },
      { autoBatch: { store: false } },
    );

    // The read never accumulates, so it does not arm the schedule.
    assert.equal(entry.content, "stored");
    assert.deepEqual(getManyRequestCounts(), [1]);
    assert.equal(scheduled.length, 0);
  });

  it("publishes one fetch message, reports the write, and rejects with the producer's error", async (t) => {
    const failure = new Error("origin down");
    const cache = cacheOver();
    const client = wrapProducer({
      cache,
      produce: async ({ id }) => {
        await Promise.resolve();
        if (id === "bad") throw failure;
        return { content: id, directives: freshFor100 };
      },
    });
    t.after(async () => {
      await client.close();
      await cache.close();
    });
    const capture = captureChannels(cache.name);
    try {
      const writes: Promise<void>[] = [];
      const onStore = (stored: Promise<void>) => writes.push(stored);

      const entry = await client.get({ id: "a" }, { onStore });
      await assert.rejects(client.get({ id: "bad" }, { onStore }), failure);
      const cached = await client.get({ id: "a" }, { onStore });

      assert.equal(entry.content, "a");
      assert.equal(cached.content, "a");
      // The failed call has no write to observe.
      assert.equal(writes.length, 2);
      await Promise.all(writes);
      assert.deepEqual(
        capture.fetch.map(({ resourceId, disposition }) => [
          resourceId,
          disposition,
        ]),
        [
          ["a", "served-from-producer"],
          ["bad", "producer-error"],
          ["a", "served-from-cache"],
        ],
      );
    } finally {
      capture.stop();
    }
  });
});
