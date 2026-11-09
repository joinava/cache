import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import {
  ACCEPT_ANY_REGISTRY,
  freshFor100,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import wrapProducer from "./utils/wrapProducer.js";

import {
  lookup,
  suiteOptions,
  type Spec,
} from "../test/readBatchingHelpers.js";

describe(
  "wrapper shutdown after partial contract failure",
  suiteOptions,
  () => {
    it("drains a sibling read that starts production after the public bulk call rejects", async (t) => {
      const cache = new Cache({
        store: new MemoryStore<Spec>(),
        name: "producer-failed-sibling",
        resourceTypes: ACCEPT_ANY_REGISTRY,
      });
      const slow = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const { CacheContractError } = await import("./utils/utils.js");
      const read = cache.get.bind(cache);
      t.mock.method(cache, "get", async (...args: Parameters<typeof read>) => {
        if (args[0].id === "invalid")
          throw new CacheContractError("invalid lookup");
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
  },
);

describe("Cache mutation drain", suiteOptions, () => {
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
    const cache = new Cache({
      store,
      name: "mutation-drain",
      resourceTypes: ACCEPT_ANY_REGISTRY,
    });
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
});
