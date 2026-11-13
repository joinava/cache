import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  setImmediate as nextTurn,
  setTimeout as sleep,
} from "node:timers/promises";

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

describe("Cache pending writes", suiteOptions, () => {
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

    const write = cache.store([resource("a", "pending")]);
    const lookupResult = cache.get(lookup("a"));
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

    void cache.store([
      { id: "a", content: "pending", directives: { freshUntilAge: 0.05 } },
    ]);
    // Past the 50 ms freshness lifetime, while the write is still pending.
    await sleep(100);

    assert.equal((await cache.get(lookup("a"))).usable, undefined);
  });

  it("reports the write behind a pending entry, also after the write settles", async (t) => {
    const writeGate = Promise.withResolvers<void>();
    const store = bulkMemoryStore<Spec>();
    const cache = cacheOver(store);
    t.after(() => cache.close());
    await cache.store([resource("persisted", "stored")]);
    const write = store.store.bind(store);
    mock.method(store, "store", async (...args: Parameters<typeof write>) => {
      await writeGate.promise;
      return await write(...args);
    });

    const stored = cache.store([resource("a", "pending")]);
    const [pending, persisted] = await Promise.all([
      cache.get(lookup("a")),
      cache.get(lookup("persisted")),
    ]);
    const reported = cache.writeFor(pending.usable!);
    let settled = false;
    void reported?.then(() => {
      settled = true;
    });
    await nextTurn();
    assert.equal(settled, false);

    writeGate.resolve();
    await stored;
    await reported;
    assert.equal(settled, true);
    assert.equal(cache.writeFor(pending.usable!), reported);
    assert.equal(cache.writeFor(persisted.usable!), undefined);
  });

  it("does not serve a pending write after close starts", async (t) => {
    const writeGate = Promise.withResolvers<void>();
    const cache = new Cache({
      store: gatedWriteStore(writeGate.promise),
      name: uniqueCacheName("closed-pending"),
      resourceTypes: ACCEPT_ANY_REGISTRY,
      onGetAfterClose: "act-empty",
    });
    const write = cache.store([resource("a", "pending")]);
    // close() waits for the write, so the entry stays pending while closed.
    const closing = cache.close();
    t.after(async () => {
      writeGate.resolve();
      await Promise.all([write, closing]);
    });

    assert.deepEqual(await cache.get(lookup("a")), { validatable: [] });
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
    // Only an id with pending resources needs its params normalized.
    const pendingWrite = cache.store([resource("a", "pending")]);

    const [failed, read] = await cache.getUnbatched([
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
});
