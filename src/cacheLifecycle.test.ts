import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import {
  cacheOver,
  lookup,
  spiedStore,
  suiteOptions,
  type Spec,
} from "../test/fixtures.js";
import { freshFor100 } from "../test/v2AcceptanceHelpers.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import { CacheContractError } from "./utils/utils.js";
import wrapProducer from "./wrapProducer/wrapProducer.js";

describe("close() drains accepted work", suiteOptions, () => {
  it("drains a sibling read that starts production after the public bulk call rejects", async (t) => {
    const cache = cacheOver(new MemoryStore<Spec>(), {
      name: "producer-failed-sibling",
    });
    const slow = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const read = cache.get.bind(cache);
    t.mock.method(cache, "get", async (...args: Parameters<typeof read>) => {
      if (args[0].id === "invalid") {
        throw new CacheContractError("invalid lookup");
      }
      entered.resolve();
      await slow.promise;
      return read(...args);
    });
    const producer = mock.fn(async ({ id }: { id: string }) => ({
      content: id,
      directives: freshFor100,
    }));
    const client = wrapProducer({ cache, produce: producer });
    const pending = client.getMany([{ id: "invalid" }, { id: "slow" }]);
    await assert.rejects(pending, CacheContractError);
    await entered.promise;
    let finished = false;
    const close = client.close().then(() => {
      finished = true;
    });
    await nextTurn();
    assert.equal(finished, false);
    slow.resolve();
    await close;
    assert.equal(producer.mock.callCount(), 1);
    assert.equal((await cache.get(lookup("slow"))).usable?.content, "slow");
    await cache.close();
  });

  it("drains accepted writes and deletes after operation failure, then reports cleanup failure", async (t) => {
    const store = new MemoryStore<Spec>();
    const writeGate = Promise.withResolvers<void>();
    const deleteGate = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    const deleteStarted = Promise.withResolvers<void>();
    const writeFailure = new Error("write failed");
    const cleanupFailure = new Error("cleanup failed");
    const events: string[] = [];
    t.mock.method(store, "store", async () => {
      writeStarted.resolve();
      await writeGate.promise;
      events.push("write settled");
      throw writeFailure;
    });
    t.mock.method(store, "delete", async () => {
      deleteStarted.resolve();
      await deleteGate.promise;
      events.push("delete settled");
    });
    t.mock.method(store, "close", async () => {
      events.push("cleanup");
      throw cleanupFailure;
    });
    const cache = cacheOver(store, { name: "mutation-drain" });
    const write = assert.rejects(
      cache.store([{ id: "a", content: "a", directives: freshFor100 }]),
      (error) => error === writeFailure,
    );
    const deletion = cache.delete("b");
    await Promise.all([writeStarted.promise, deleteStarted.promise]);
    const closing = cache.close();
    const failedCleanup = assert.rejects(
      closing,
      (error) => error === cleanupFailure,
    );
    assert.equal(cache.close(), closing);
    writeGate.resolve();
    await write;
    await nextTurn();
    assert.deepEqual(events, ["write settled"]);
    deleteGate.resolve();
    await Promise.all([deletion, failedCleanup]);
    assert.deepEqual(events, ["write settled", "delete settled", "cleanup"]);
  });

  it("flushes queued production and waits for accepted reads and writes during close", async () => {
    const cache = cacheOver(new MemoryStore<Spec>(), {
      name: "producer-close",
    });
    const readGate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const writeGate = Promise.withResolvers<void>();
    const originalRead = cache.get.bind(cache);
    mock.method(
      cache,
      "get",
      async (...args: Parameters<typeof originalRead>) => {
        entered.resolve();
        await readGate.promise;
        return originalRead(...args);
      },
    );
    const originalStore = cache.store.bind(cache);
    mock.method(
      cache,
      "store",
      async (...args: Parameters<typeof originalStore>) => {
        await writeGate.promise;
        return originalStore(...args);
      },
    );
    const client = wrapProducer({
      cache,
      produceMany: async (requests) =>
        requests.map(({ id }) => ({ content: id, directives: freshFor100 })),
      producerBatching: { batchScheduleFn: () => {} },
    });
    const accepted = client.get({ id: "a" });
    await entered.promise;
    const close = client.close();
    assert.equal(client.close(), close);
    await assert.rejects(client.get({ id: "new" }), /closed/);
    readGate.resolve();
    assert.equal((await accepted).content, "a");
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await nextTurn();
    assert.equal(closed, false);
    writeGate.resolve();
    await close;
    await cache.close();
  });

  it("finishes an accepted getUnbatched read before it closes the Store", async (t) => {
    const store = new MemoryStore<Spec>();
    const events: string[] = [];
    const read = store.get.bind(store);
    t.mock.method(store, "get", async (...args: Parameters<typeof read>) => {
      events.push(`get ${args[0].id}`);
      return read(...args);
    });
    t.mock.method(store, "close", async () => {
      events.push("close");
    });
    const cache = cacheOver(store, { name: "unbatched-close" });

    // getUnbatched normalizes its requests before it reads the Store, and
    // close() starts while that normalization is pending.
    const pending = cache.getUnbatched([lookup("a"), lookup("b")]);
    const closing = cache.close();

    assert.equal((await pending).length, 2);
    await closing;
    assert.deepEqual(events, ["get a", "get b", "close"]);
  });

  it("rejects a get that arrives after close() starts", async () => {
    const { store, getManyRequestCounts } = spiedStore();
    const cache = cacheOver(store);

    const closing = cache.close();
    await assert.rejects(cache.get(lookup("a")), /Store has been closed/);
    await closing;

    assert.deepEqual(getManyRequestCounts(), []);
  });
});
