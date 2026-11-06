import assert from "node:assert/strict";
import { test } from "node:test";
import Cache, { singleTypeCacheOptions } from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import { cacheReadChannel, type CacheReadMessage } from "./diagnostics.js";

const request = (id: string) => ({ id, params: {}, directives: {} });

test("automatic batches isolate per-request store failures", async (t) => {
  const store = new MemoryStore();
  const cache = new Cache(
    singleTypeCacheOptions<string>()({ name: "partial-store", store }),
  );
  t.after(async () => await cache.close());
  await cache.store([
    { id: "hit", content: "value", directives: { freshUntilAge: 60 } },
  ]);
  const original = store.getMany.bind(store);
  const failure = new Error("one resource unavailable");
  t.mock.method(
    store,
    "getMany",
    async (requests: Parameters<typeof original>[0]) => {
      const results = await original(requests);
      return results.map((entries, index) =>
        requests[index]?.id === "failed" ? failure : entries,
      );
    },
  );
  const messages: CacheReadMessage[] = [];
  const onRead = (message: CacheReadMessage) => {
    if (message.cache === cache.name) messages.push(message);
  };
  cacheReadChannel.subscribe(onRead);
  t.after(() => {
    cacheReadChannel.unsubscribe(onRead);
  });
  const [hit, failed, miss, duplicateHit] = await Promise.allSettled([
    cache.get(request("hit")),
    cache.get(request("failed")),
    cache.get(request("miss")),
    cache.get(request("hit")),
  ]);
  assert.equal(hit?.status, "fulfilled");
  if (hit?.status === "fulfilled")
    assert.equal(hit.value.usable?.content, "value");
  assert.equal(failed?.status, "rejected");
  if (failed?.status === "rejected") assert.equal(failed.reason, failure);
  assert.equal(miss?.status, "fulfilled");
  if (miss?.status === "fulfilled") assert.equal(miss.value.usable, undefined);
  assert.equal(duplicateHit?.status, "fulfilled");
  if (duplicateHit?.status === "fulfilled")
    assert.equal(duplicateHit.value.usable?.content, "value");
  assert.equal(
    messages.filter((message) => message.found === "read-failed").length,
    1,
  );
});

test("explicit Cache.getMany retains whole-call rejection for a store error slot", async (t) => {
  const store = new MemoryStore();
  const cache = new Cache(
    singleTypeCacheOptions<string>()({ name: "explicit-partial-store", store }),
  );
  t.after(async () => await cache.close());
  const failure = new Error("one resource unavailable");
  t.mock.method(store, "getMany", async () => [[], failure]);
  await assert.rejects(
    cache.getMany([request("hit"), request("failed")]),
    (error) => error === failure,
  );
});
