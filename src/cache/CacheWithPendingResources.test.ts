import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import Cache from "./Cache.js";
import {
  bulkMemoryStore,
  cacheOver,
  lookup,
  spiedStore,
  suiteOptions,
  type Spec,
} from "../../test/fixtures.js";
import {
  ACCEPT_ANY_REGISTRY,
  freshFor100,
  uniqueCacheName,
} from "../../test/v2AcceptanceHelpers.js";
import { CacheWithPendingResources } from "./CacheWithPendingResources.js";

const noLog = () => {};

const resource = (id: string, content: string) => ({
  id,
  content,
  directives: freshFor100,
  date: new Date(),
});

/** A bulk memory store whose writes wait for `writeGate`. */
function gatedWriteStore(writeGate: Promise<void>) {
  const store = bulkMemoryStore<Spec>();
  const write = store.store.bind(store);
  mock.method(store, "store", async (...args: Parameters<typeof write>) => {
    await writeGate;
    return await write(...args);
  });
  return store;
}

describe("CacheWithPendingResources", suiteOptions, () => {
  it("takes the pending snapshot before the Store read starts", async (t) => {
    const writeGate = Promise.withResolvers<void>();
    const readGate = Promise.withResolvers<void>();
    const storeAnswered = Promise.withResolvers<void>();
    const store = gatedWriteStore(writeGate.promise);
    const read = store.getMany.bind(store);
    mock.method(store, "getMany", async (...args: Parameters<typeof read>) => {
      const results = await read(...args);
      storeAnswered.resolve();
      await readGate.promise;
      return results;
    });
    const cache = cacheOver(store);
    t.after(() => cache.close());
    const overlay = new CacheWithPendingResources(cache, noLog);

    const write = overlay.store([resource("a", "pending")]);
    const lookupResult = overlay.get(lookup("a"));
    // The Store has read a miss. Now the write lands and leaves the overlay,
    // before the read returns.
    await storeAnswered.promise;
    writeGate.resolve();
    await write;
    readGate.resolve();

    assert.equal((await lookupResult).usable?.content, "pending");
  });

  it("dates a dateless resource at write time, not at its first lookup", async (t) => {
    const writeGate = Promise.withResolvers<void>();
    const cache = cacheOver(gatedWriteStore(writeGate.promise));
    t.after(async () => {
      writeGate.resolve();
      await cache.close();
    });
    const overlay = new CacheWithPendingResources(cache, noLog);

    void overlay.store([
      { id: "a", content: "pending", directives: { freshUntilAge: 0.05 } },
    ]);
    // Past the 50 ms freshness lifetime, while the write is still pending.
    await sleep(100);

    assert.equal((await overlay.get(lookup("a"))).usable, undefined);
  });

  it("reports the write behind a pending entry, also after the write settles", async (t) => {
    const cache = cacheOver();
    t.after(() => cache.close());
    await cache.store([resource("persisted", "stored")]);
    const overlay = new CacheWithPendingResources(cache, noLog);

    const write = overlay.store([resource("a", "pending")]);
    const [pending, persisted] = await Promise.all([
      overlay.get(lookup("a")),
      overlay.get(lookup("persisted")),
    ]);
    await write;

    assert.equal(overlay.writeFor(pending.usable!), write);
    assert.equal(overlay.writeFor(persisted.usable!), undefined);
  });

  it("fails only the getUnbatched slot whose params cannot be normalized, and leaves it out of the Store call", async (t) => {
    const writeGate = Promise.withResolvers<void>();
    const { store, getManyRequestCounts } = spiedStore();
    const cache = new Cache({
      store,
      name: uniqueCacheName("overlay-normalization"),
      resourceTypes: ACCEPT_ANY_REGISTRY,
      normalizeParamValue: (_name, value) => {
        if (value === "bad") throw new Error("normalization failed");
        return value;
      },
    });
    t.after(() => cache.close());
    const write = store.store.bind(store);
    mock.method(store, "store", async (...args: Parameters<typeof write>) => {
      await writeGate.promise;
      return await write(...args);
    });
    const overlay = new CacheWithPendingResources(cache, noLog);
    // Only an id with pending resources needs its params normalized.
    const pendingWrite = overlay.store([resource("a", "pending")]);

    const [failed, read] = await overlay.getUnbatched([
      lookup("a", { language: "bad" }),
      lookup("b"),
    ]);
    writeGate.resolve();
    await pendingWrite;

    assert.ok(failed instanceof Error);
    assert.equal(failed.message, "normalization failed");
    assert.ok(!(read instanceof Error));
    assert.equal(read?.usable, undefined);
    assert.deepEqual(getManyRequestCounts(), [1]);
  });

  it("drain waits for started writes and leaves the cache open", async (t) => {
    const writeGate = Promise.withResolvers<void>();
    const cache = cacheOver(gatedWriteStore(writeGate.promise));
    t.after(() => cache.close());
    const overlay = new CacheWithPendingResources(cache, noLog);

    void overlay.store([resource("a", "pending")]);
    const drained = overlay.drain();
    assert.equal(
      await Promise.race([
        drained.then(() => "drained"),
        sleep(20).then(() => "waiting"),
      ]),
      "waiting",
    );

    writeGate.resolve();
    await drained;
    assert.equal(cache.closed, false);
  });
});
