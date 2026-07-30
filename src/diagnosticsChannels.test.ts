import { expect } from "chai";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "timers/promises";

import {
  captureChannels,
  expectCachePathFetch,
  expectProducerPathFetch,
  expectProduceMessage,
  expectRejection,
  memoryStoreFor,
  uniqueCacheName,
  V2_CHANNEL_NAMES,
  waitUntil,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  CACHE_FETCH_CHANNEL_NAME,
  CACHE_PRODUCE_CHANNEL_NAME,
  CACHE_READ_CHANNEL_NAME,
  CACHE_STORE_ENTRY_CHANNEL_NAME,
  cacheFetchChannel,
  cacheProduceChannel,
  cacheReadChannel,
  cacheStoreEntryChannel,
  bulkProducerByIdType,
  idStartsWith,
  producerByIdType,
  resourceType,
  wrapBulkProducer,
  wrapComputingProducer,
  type CacheFetchMessage,
  type CacheProduceMessage,
  type CacheReadMessage,
  type CacheStoreEntryMessage,
  type ResourceTypes,
} from "./index.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * Conformance tests for the four §6.5 diagnostics channels: exact channel
 * names, full message payloads (field-by-field), the documented emission
 * points (read per lookup, fetch per logical call at SETTLEMENT, produce per
 * actual producer invocation, store-entry per stored entry), and correct
 * `{ cache, resourceType }` attribution everywhere -- including supplemental
 * writes attributed to their OWN resource type. Ends with §7's golden
 * end-to-end simulation.
 */

const registry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<string>()({ matches: idStartsWith("biz:") }),
} satisfies ResourceTypes;

const soleVisitsRegistry = {
  visits: resourceType<string>()({
    matches: (id): id is string => typeof id === "string",
  }),
} satisfies ResourceTypes;

const freshFor100 = { freshUntilAge: 100 };
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

/** Directives whose entry is, ~1s after `date`, stale but within a long SWR window. */
const swrWindowDirectives = {
  freshUntilAge: 0.5,
  maxStale: { withoutRevalidation: 0, whileRevalidate: 3600, ifError: 3600 },
};

/** Directives whose entry is, ~1s after `date`, stale, outside SWR, within if-error. */
const ifErrorWindowDirectives = {
  freshUntilAge: 0.5,
  maxStale: { withoutRevalidation: 0, whileRevalidate: 0, ifError: 3600 },
};

const makeHarness = (label: string) => {
  const name = uniqueCacheName(label);
  const store = memoryStoreFor(registry);
  const cache = new Cache({
    store: store,
    name,
    resourceTypes: registry,
  });
  return { name, store, cache };
};

const sortByResourceId = <T extends { resourceId: string }>(
  messages: readonly T[],
): T[] =>
  [...messages].sort((a, b) =>
    a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
  );

describe("diagnostics channels (§6.5)", () => {
  describe("channel names and typed-channel exports", () => {
    it("exports exactly the documented channel-name constants", () => {
      expect(CACHE_READ_CHANNEL_NAME).to.equal("@zingage/cache:read");
      expect(CACHE_FETCH_CHANNEL_NAME).to.equal("@zingage/cache:fetch");
      expect(CACHE_PRODUCE_CHANNEL_NAME).to.equal("@zingage/cache:produce");
      expect(CACHE_STORE_ENTRY_CHANNEL_NAME).to.equal(
        "@zingage/cache:store-entry",
      );
    });

    it("the typed channel objects publish on those exact names and support subscribe/unsubscribe", async () => {
      const { name, cache } = makeHarness("typed-channels");

      expect(cacheReadChannel.name).to.equal(V2_CHANNEL_NAMES.read);
      expect(cacheFetchChannel.name).to.equal(V2_CHANNEL_NAMES.fetch);
      expect(cacheProduceChannel.name).to.equal(V2_CHANNEL_NAMES.produce);
      expect(cacheStoreEntryChannel.name).to.equal(V2_CHANNEL_NAMES.storeEntry);

      const reads: CacheReadMessage[] = [];
      const fetches: CacheFetchMessage[] = [];
      const produces: CacheProduceMessage[] = [];
      const storeEntries: CacheStoreEntryMessage[] = [];
      const onRead = (m: CacheReadMessage) => {
        if (m.cache === name) reads.push(m);
      };
      const onFetch = (m: CacheFetchMessage) => {
        if (m.cache === name) fetches.push(m);
      };
      const onProduce = (m: CacheProduceMessage) => {
        if (m.cache === name) produces.push(m);
      };
      const onStoreEntry = (m: CacheStoreEntryMessage) => {
        if (m.cache === name) storeEntries.push(m);
      };
      cacheReadChannel.subscribe(onRead);
      cacheFetchChannel.subscribe(onFetch);
      cacheProduceChannel.subscribe(onProduce);
      cacheStoreEntryChannel.subscribe(onStoreEntry);
      try {
        const producer = mock.fn(async (req: { readonly id: string }) => ({
          content: `content-${req.id}`,
          directives: freshFor100,
        }));
        const getSite = wrapProducer(
          cache,
          {},
          producerByIdType(cache, { site_day: producer }),
        );
        await getSite({ id: "site:typed" });
        await waitUntil(
          () => storeEntries.length >= 1 && produces.length >= 1,
          "typed channels received the miss cascade",
        );

        expect(reads.length).to.be.at.least(1);
        expect(fetches.length).to.be.at.least(1);
        expect(produces.length).to.be.at.least(1);
        expect(storeEntries.length).to.be.at.least(1);
      } finally {
        expect(cacheReadChannel.unsubscribe(onRead)).to.equal(true);
        expect(cacheFetchChannel.unsubscribe(onFetch)).to.equal(true);
        expect(cacheProduceChannel.unsubscribe(onProduce)).to.equal(true);
        expect(cacheStoreEntryChannel.unsubscribe(onStoreEntry)).to.equal(true);
        await cache.close();
      }
    });
  });

  describe("read channel (§6.5.1)", () => {
    it("direct Cache.get on a miss publishes exactly one fully-attributed message with found: 'none'", async () => {
      const { name, cache } = makeHarness("read-miss");
      const capture = captureChannels(name);
      try {
        await cache.get({ id: "site:missing", params: {}, directives: {} });
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:missing",
            found: "none",
          },
        ]);
        // A direct read involves no wrapper: nothing else is published.
        expect(capture.fetch).to.deep.equal([]);
        expect(capture.produce).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("found: 'usable' when the request is satisfiable from cache alone", async () => {
      const { name, cache } = makeHarness("read-usable");
      await cache.store([
        { id: "site:a", content: "fresh", directives: freshFor100 },
      ]);
      const capture = captureChannels(name);
      try {
        const res = await cache.get({
          id: "site:a",
          params: {},
          directives: {},
        });
        expect(res.usable?.content).to.equal("fresh");
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable",
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("found: 'usable-while-revalidate' when only usable paired with a background refresh", async () => {
      const { name, cache } = makeHarness("read-swr");
      await cache.store([
        {
          id: "site:a",
          content: "stale",
          directives: swrWindowDirectives,
          date: secondsAgo(1),
        },
      ]);
      const capture = captureChannels(name);
      try {
        const res = await cache.get({
          id: "site:a",
          params: {},
          directives: {},
        });
        expect(res.usableWhileRevalidate?.content).to.equal("stale");
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable-while-revalidate",
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("found: 'usable-if-error' when only usable as a producer-failure fallback", async () => {
      const { name, cache } = makeHarness("read-if-error");
      await cache.store([
        {
          id: "site:a",
          content: "stale",
          directives: ifErrorWindowDirectives,
          date: secondsAgo(1),
        },
      ]);
      const capture = captureChannels(name);
      try {
        const res = await cache.get({
          id: "site:a",
          params: {},
          directives: {},
        });
        expect(res.usableIfError?.content).to.equal("stale");
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable-if-error",
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("merely-validatable entries report found: 'none' (conditional revalidation is reserved)", async () => {
      const { name, cache } = makeHarness("read-validatable");
      await cache.store([
        {
          id: "site:a",
          content: "expired-but-validatable",
          directives: { freshUntilAge: 0.5 },
          validators: { etag: "w/1" },
          date: secondsAgo(1),
        },
      ]);
      const capture = captureChannels(name);
      try {
        const res = await cache.get({
          id: "site:a",
          params: {},
          directives: {},
        });
        // Self-check of the fixture: the entry really is merely validatable.
        expect(res.usable).to.equal(undefined);
        expect(res.usableWhileRevalidate).to.equal(undefined);
        expect(res.usableIfError).to.equal(undefined);
        expect(res.validatable).to.have.lengthOf(1);

        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "none",
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("getMany publishes one message PER request (duplicates included), each independently attributed", async () => {
      const { name, cache } = makeHarness("read-getmany");
      await cache.store([
        { id: "site:a", content: "fresh", directives: freshFor100 },
      ]);
      const capture = captureChannels(name);
      try {
        await cache.getMany([
          { id: "site:a", params: {}, directives: {} },
          { id: "biz:b", params: {}, directives: {} },
          { id: "site:a", params: {}, directives: {} },
        ]);
        expect(capture.read).to.have.lengthOf(3);
        expect(sortByResourceId(capture.read)).to.deep.equal([
          {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:b",
            found: "none",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable",
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("after close with 'act-empty'/'no-op': reads still publish (found: 'none'), store() returns [], delete() no-ops", async () => {
      // An act-empty read is still a lookup the
      // channel reports, and a no-op store returns an empty results array.
      const name = uniqueCacheName("read-after-close");
      const store = memoryStoreFor(registry);
      const cache = new Cache({
        store: store,
        name,
        resourceTypes: registry,
        onGetAfterClose: "act-empty",
        onStoreAfterClose: "no-op",
      });
      await cache.close();
      const capture = captureChannels(name);
      try {
        const res = await cache.get({
          id: "site:a",
          params: {},
          directives: {},
        });
        expect(res.usable).to.equal(undefined);
        expect(res.validatable).to.deep.equal([]);
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "none",
          },
        ]);

        const storeResults = await cache.store([
          { id: "site:a", content: "late", directives: freshFor100 },
        ]);
        expect(storeResults).to.deep.equal([]);
        expect(capture.storeEntry).to.deep.equal([]);

        // Deletes are writes, so they follow onStoreAfterClose too: under
        // "no-op" a post-close delete resolves without touching the store.
        store.delete = async () => {
          throw new Error("store.delete must not be called after close");
        };
        await cache.delete("site:a");
      } finally {
        capture.stop();
      }
    });

    it("a failed cache read publishes found: 'read-failed' carrying the error, and the error still propagates from Cache.get", async () => {
      const { name, store, cache } = makeHarness("read-failure");
      const readError = new Error("store exploded");
      store.get = async () => {
        throw readError;
      };
      const capture = captureChannels(name);
      try {
        const thrown = await expectRejection(() =>
          cache.get({ id: "site:a", params: {}, directives: {} }),
        );
        expect(thrown).to.equal(readError);
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "read-failed",
            error: readError,
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("a failed getMany read publishes one 'read-failed' PER request, so per-id read counts match the successful path", async () => {
      const { name, store, cache } = makeHarness("read-failure-many");
      const readError = new Error("store exploded");
      store.getMany = async () => {
        throw readError;
      };
      const capture = captureChannels(name);
      try {
        const thrown = await expectRejection(() =>
          cache.getMany([
            { id: "site:a", params: {}, directives: {} },
            { id: "biz:b", params: {}, directives: {} },
            // A duplicate gets its own message, exactly as on the success path.
            { id: "site:a", params: {}, directives: {} },
          ]),
        );
        expect(thrown).to.equal(readError);
        expect(capture.read).to.have.lengthOf(3);
        // Each is attributed to its OWN resource type, not the batch's first.
        expect(sortByResourceId(capture.read)).to.deep.equal([
          {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:b",
            found: "read-failed",
            error: readError,
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "read-failed",
            error: readError,
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "read-failed",
            error: readError,
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("an ABORTED read is not a failed read: it publishes nothing, matching the pre-aborted fast path", async () => {
      const { name, store, cache } = makeHarness("read-abort-not-failure");
      const controller = new AbortController();
      // Reject the way a signal-aware store does once the signal fires.
      store.get = async () => {
        controller.abort();
        throw new Error("aborted by signal");
      };
      const capture = captureChannels(name);
      try {
        await expectRejection(() =>
          cache.get(
            { id: "site:a", params: {}, directives: {} },
            { signal: controller.signal },
          ),
        );
        expect(capture.read).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("fetch channel (§6.5.2)", () => {
    it("served-from-cache: a hit settles the fetch without producer contact", async () => {
      const { name, cache } = makeHarness("fetch-hit");
      await cache.store([
        { id: "site:a", content: "cached", directives: freshFor100 },
      ]);
      const capture = captureChannels(name);
      const producer = mock.fn(async () => ({
        content: "never",
        directives: freshFor100,
      }));
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const res = await getSite({ id: "site:a" });
        expect(res.content).to.equal("cached");
        expect(producer.mock.callCount()).to.equal(0);

        expect(capture.fetch).to.have.lengthOf(1);
        expectCachePathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-from-cache",
          collapsed: false,
        });
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable",
          },
        ]);
        expect(capture.produce).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("served-from-producer is published at SETTLEMENT, after the producer resolves -- not at classification time", async () => {
      const { name, cache } = makeHarness("fetch-settlement");
      const capture = captureChannels(name);
      const { promise: gate, resolve: releaseProducer } =
        Promise.withResolvers<void>();
      const producer = mock.fn(async (req: { readonly id: string }) => {
        await gate;
        return { content: `content-${req.id}`, directives: freshFor100 };
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const pending = getSite({ id: "site:a" });
        await waitUntil(
          () => producer.mock.callCount() === 1,
          "producer invoked",
        );
        await delay(20);
        // The request has been classified and missed, but has NOT settled:
        // 1.6.0 published its result message here; 2.0 must not have.
        expect(capture.fetch).to.deep.equal([]);
        expect(capture.produce).to.deep.equal([]);

        releaseProducer();
        const res = await pending;
        expect(res.content).to.equal("content-site:a");
        expect(capture.fetch).to.have.lengthOf(1);
        expectProducerPathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: "site:a" }],
          collapsedCallerCount: 1,
          outcome: "success",
          minDurationMs: 15,
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("producer-error: the error propagates; the fetch message arrives only after the producer rejects", async () => {
      const { name, cache } = makeHarness("fetch-producer-error");
      const capture = captureChannels(name);
      const producerError = new Error("origin down");
      const { promise: gate, resolve: releaseProducer } =
        Promise.withResolvers<void>();
      const producer = mock.fn(async () => {
        await gate;
        throw producerError;
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const pending = getSite({ id: "site:a" });
        await waitUntil(
          () => producer.mock.callCount() === 1,
          "producer invoked",
        );
        await delay(20);
        expect(capture.fetch).to.deep.equal([]);

        releaseProducer();
        const thrown = await expectRejection(pending);
        expect(thrown).to.equal(producerError);

        expect(capture.fetch).to.have.lengthOf(1);
        expectProducerPathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "producer-error",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: "site:a" }],
          collapsedCallerCount: 1,
          outcome: "error",
          minDurationMs: 15,
        });
        expect(capture.storeEntry).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("served-stale-while-revalidating settles first; the revalidation's produce message arrives after (trigger: 'revalidation')", async () => {
      const { name, cache } = makeHarness("fetch-swr");
      await cache.store([
        {
          id: "site:a",
          content: "stale-v1",
          directives: swrWindowDirectives,
          date: secondsAgo(1),
        },
      ]);
      const capture = captureChannels(name);
      const producer = mock.fn(async () => {
        await delay(30);
        return { content: "fresh-v2", directives: freshFor100 };
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const res = await getSite({ id: "site:a" });
        expect(res.content).to.equal("stale-v1");
        expect(capture.fetch).to.have.lengthOf(1);
        expectCachePathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-stale-while-revalidating",
          collapsed: false,
        });
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable-while-revalidate",
          },
        ]);

        // The background revalidation settles AFTER the fetch already shipped.
        await waitUntil(
          () => capture.produce.length === 1,
          "revalidation produce message",
        );
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "revalidation",
          requests: [{ resourceType: "site_day", resourceId: "site:a" }],
          collapsedCallerCount: 1,
          outcome: "success",
          minDurationMs: 20,
        });
        const fetchIndex = capture.all.findIndex((m) => m.channel === "fetch");
        const produceIndex = capture.all.findIndex(
          (m) => m.channel === "produce",
        );
        expect(fetchIndex).to.be.greaterThanOrEqual(0);
        expect(produceIndex).to.be.greaterThan(fetchIndex);

        // The revalidated content lands in the cache.
        await waitUntil(
          () => capture.storeEntry.length === 1,
          "revalidated entry stored",
        );
        expect(capture.storeEntry[0]).to.deep.equal({
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          vary: {},
          validators: {},
          relationshipToExistingStoredData: undefined,
        });
        const after = await getSite({ id: "site:a" });
        expect(after.content).to.equal("fresh-v2");
        expect(producer.mock.callCount()).to.equal(1);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("a failed background revalidation reports produce outcome: 'error' while the stale serve already succeeded", async () => {
      const { name, cache } = makeHarness("fetch-swr-error");
      await cache.store([
        {
          id: "site:a",
          content: "stale-v1",
          directives: swrWindowDirectives,
          date: secondsAgo(1),
        },
      ]);
      const capture = captureChannels(name);
      const producer = mock.fn(async () => {
        await delay(10);
        throw new Error("origin down");
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const res = await getSite({ id: "site:a" });
        expect(res.content).to.equal("stale-v1");

        await waitUntil(
          () => capture.produce.length === 1,
          "failed revalidation produce message",
        );
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "revalidation",
          requests: [{ resourceType: "site_day", resourceId: "site:a" }],
          collapsedCallerCount: 1,
          outcome: "error",
        });
        // The logical request settled as a stale serve -- exactly one fetch,
        // and it is not an error disposition.
        expect(capture.fetch).to.have.lengthOf(1);
        expectCachePathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-stale-while-revalidating",
          collapsed: false,
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("served-stale-after-error: a foreground producer failure falls back to the if-error entry", async () => {
      const { name, cache } = makeHarness("fetch-stale-after-error");
      await cache.store([
        {
          id: "site:a",
          content: "stale-v1",
          directives: ifErrorWindowDirectives,
          date: secondsAgo(1),
        },
      ]);
      const capture = captureChannels(name);
      const producer = mock.fn(async () => {
        await delay(10);
        throw new Error("origin down");
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const res = await getSite({ id: "site:a" });
        expect(res.content).to.equal("stale-v1");

        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "usable-if-error",
          },
        ]);
        expect(capture.fetch).to.have.lengthOf(1);
        expectCachePathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-stale-after-error",
          collapsed: false,
        });
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: "site:a" }],
          collapsedCallerCount: 1,
          outcome: "error",
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("aborted: the fetch settles as 'aborted' BEFORE the invocation's produce message; the result is still stored", async () => {
      const { name, cache } = makeHarness("fetch-abort-mid-producer");
      const capture = captureChannels(name);
      const producer = mock.fn(async () => {
        await delay(80);
        return { content: "slow-but-stored", directives: freshFor100 };
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      const controller = new AbortController();
      try {
        const pending = getSite(
          { id: "site:a" },
          { signal: controller.signal },
        );
        await waitUntil(
          () => producer.mock.callCount() === 1,
          "producer invoked",
        );
        controller.abort(new Error("caller-gone"));
        const thrown = await expectRejection(pending);
        expect((thrown as Error).message).to.equal("caller-gone");

        // The aborted fetch settled before its invocation did (§6.5's
        // temporal decoupling): the producer is still running here (it takes
        // another ~65ms), so no produce message can exist yet.
        await waitUntil(
          () => capture.fetch.length === 1,
          "aborted fetch message",
          500,
        );
        expectProducerPathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "aborted",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expect(capture.produce).to.deep.equal([]);

        // The collapsed producer call keeps running and stores its result.
        await waitUntil(
          () => capture.produce.length === 1,
          "abandoned invocation settled",
        );
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: "site:a" }],
          collapsedCallerCount: 1,
          outcome: "success",
          minDurationMs: 50,
        });
        await waitUntil(
          () => capture.storeEntry.length === 1,
          "abandoned result stored",
        );
        const after = await getSite({ id: "site:a" });
        expect(after.content).to.equal("slow-but-stored");
        expect(producer.mock.callCount()).to.equal(1);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("an abort landing during the cache read settles as 'aborted' (emitted nothing in 1.6.0); the producer is never contacted", async () => {
      const { name, store, cache } = makeHarness("fetch-abort-during-read");
      const { promise: storeRead, resolve: releaseStoreRead } =
        Promise.withResolvers<never[]>();
      store.get = (async () => storeRead) as typeof store.get;
      const capture = captureChannels(name);
      const producer = mock.fn(async () => ({
        content: "never",
        directives: freshFor100,
      }));
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      const controller = new AbortController();
      try {
        const pending = getSite(
          { id: "site:a" },
          { signal: controller.signal },
        );
        await delay(10);
        controller.abort(new Error("cancelled-during-read"));
        releaseStoreRead([]);

        const thrown = await expectRejection(pending);
        expect((thrown as Error).message).to.equal("cancelled-during-read");

        await waitUntil(
          () => capture.fetch.length === 1,
          "aborted fetch message",
          500,
        );
        expect(producer.mock.callCount()).to.equal(0);
        expect(capture.produce).to.deep.equal([]);
        expectProducerPathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "aborted",
          directivesImpliedBypass: false,
          collapsed: false,
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("a pre-aborted signal settles as 'aborted' with no read message (the read never happened, so there is nothing to report -- distinct from a read that happened and failed)", async () => {
      const { name, cache } = makeHarness("fetch-pre-aborted");
      const capture = captureChannels(name);
      const producer = mock.fn(async () => ({
        content: "never",
        directives: freshFor100,
      }));
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      const controller = new AbortController();
      controller.abort(new Error("pre-aborted"));
      try {
        const thrown = await expectRejection(() =>
          getSite({ id: "site:a" }, { signal: controller.signal }),
        );
        expect((thrown as Error).message).to.equal("pre-aborted");

        await waitUntil(
          () => capture.fetch.length === 1,
          "aborted fetch message",
          500,
        );
        expect(producer.mock.callCount()).to.equal(0);
        expect(capture.read).to.deep.equal([]);
        expect(capture.produce).to.deep.equal([]);
        expectProducerPathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "aborted",
          directivesImpliedBypass: false,
          collapsed: false,
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("riders: a concurrent identical request performs its own read, then rides the in-flight invocation -- no new produce, fetch collapsed: true, collapsedCallerCount 2 (§7)", async () => {
      const { name, cache } = makeHarness("fetch-rider");
      const capture = captureChannels(name);
      // Gated rather than delayed, so the initiator's invocation is held
      // open for as long as the rider's read takes (a fixed pending window
      // flakes under suite load: the invocation settles and stores first,
      // turning the would-be rider into a cache hit).
      let releaseProducer = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseProducer = resolve;
      });
      const producer = mock.fn(async () => {
        await gate;
        return { content: "shared", directives: freshFor100 };
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const first = getSite({ id: "site:a" });
        await waitUntil(
          () => producer.mock.callCount() === 1,
          "the initiator's invocation starting",
          10_000,
        );
        const second = getSite({ id: "site:a" });
        // The rider publishes its own read BEFORE consulting the collapse
        // registry, so once its read is visible the attach has already
        // happened -- on an invocation the gate guarantees is still
        // in flight.
        await waitUntil(
          () => capture.read.length === 2,
          "the rider's own read",
          10_000,
        );
        releaseProducer();
        const [res1, res2] = await Promise.all([first, second]);
        expect(res1.content).to.equal("shared");
        expect(res2.content).to.equal("shared");
        expect(producer.mock.callCount()).to.equal(1);

        // EVERY logical request performs and reports its
        // own lookup -- the rider emits its own read -- while only the
        // producer invocation is shared (one produce message).
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "none",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "none",
          },
        ]);
        expect(capture.produce).to.have.lengthOf(1);
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: "site:a" }],
          collapsedCallerCount: 2,
          outcome: "success",
        });

        expect(capture.fetch).to.have.lengthOf(2);
        const fetches = [...capture.fetch].sort(
          (a, b) => Number(a.collapsed) - Number(b.collapsed),
        );
        expectProducerPathFetch(fetches[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProducerPathFetch(fetches[1], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: true,
        });
      } finally {
        releaseProducer();
        capture.stop();
        await cache.close();
      }
    });

    it("SWR riders: a second stale-served caller rides the in-flight revalidation -- counted in collapsedCallerCount, but its fetch stays collapsed: false (settlement-centric)", async () => {
      const { name, cache } = makeHarness("fetch-swr-rider");
      // Seeded (before capture starts) as stale but well inside the SWR
      // window, backdated so no wall-clock wait is involved.
      await cache.store([
        {
          id: "site:swr",
          content: "old",
          date: secondsAgo(30),
          directives: swrWindowDirectives,
        },
      ]);
      const capture = captureChannels(name);
      let releaseProducer = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseProducer = resolve;
      });
      const producer = mock.fn(async () => {
        await gate;
        return { content: "new", directives: freshFor100 };
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        // Both calls are served stale immediately; the first starts a
        // background revalidation (held open by the gate), the second's
        // revalidation rides it.
        const res1 = await getSite({ id: "site:swr" });
        const res2 = await getSite({ id: "site:swr" });
        expect(res1.content).to.equal("old");
        expect(res2.content).to.equal("old");

        releaseProducer();
        await waitUntil(
          () => capture.produce.length === 1,
          "the shared revalidation settling",
        );
        expect(producer.mock.callCount()).to.equal(1);

        // Both settlements were the cached entry -- neither depended on the
        // shared invocation -- so both fetches report collapsed: false,
        // while the produce message counts the rider. The channels
        // deliberately reconcile as an inequality:
        // Σ(collapsedCallerCount − 1) ≥ #collapsed-true fetches (§6.5.3).
        expect(capture.fetch).to.have.lengthOf(2);
        capture.fetch.forEach((message) => {
          expectCachePathFetch(message, {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:swr",
            disposition: "served-stale-while-revalidating",
            collapsed: false,
          });
        });
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "revalidation",
          requests: [{ resourceType: "site_day", resourceId: "site:swr" }],
          collapsedCallerCount: 2,
          outcome: "success",
        });
      } finally {
        releaseProducer();
        capture.stop();
        await cache.close();
      }
    });

    it("onCacheReadFailure default ('call-producer'): the read-failure is visible on the read channel even though the fetch settles as an ordinary producer serve", async () => {
      const { name, store, cache } = makeHarness("fetch-read-failure-default");
      const readError = new Error("store exploded");
      store.get = async () => {
        throw readError;
      };
      const capture = captureChannels(name);
      const producer = mock.fn(async () => ({
        content: "from-producer",
        directives: freshFor100,
      }));
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const res = await getSite({ id: "site:a" });
        expect(res.content).to.equal("from-producer");
        // This is the case the read-failed variant exists for: the wrapper
        // absorbs the error and substitutes an empty lookup, so the fetch below
        // is indistinguishable from a plain miss. Without this message a store
        // failing every read would look like a pure cache-miss workload.
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "read-failed",
            error: readError,
          },
        ]);
        expect(capture.fetch).to.have.lengthOf(1);
        expectProducerPathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("onCacheReadFailure: 'throw' rethrows with a 'read-failed' read message but NO fetch message (the request never reached a disposition)", async () => {
      const { name, store, cache } = makeHarness("fetch-read-failure-throw");
      const readError = new Error("store exploded");
      store.get = async () => {
        throw readError;
      };
      const capture = captureChannels(name);
      const producer = mock.fn(async () => ({
        content: "never",
        directives: freshFor100,
      }));
      const getSite = wrapProducer(
        cache,
        { onCacheReadFailure: "throw" },
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        const thrown = await expectRejection(() => getSite({ id: "site:a" }));
        expect(thrown).to.equal(readError);
        expect(producer.mock.callCount()).to.equal(0);
        // The read is reported (it happened, and it failed); the FETCH is not,
        // because the request never reached a disposition -- that asymmetry is
        // the §6.5.2 exception, and it survives the read-channel change.
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            found: "read-failed",
            error: readError,
          },
        ]);
        expect(capture.fetch).to.deep.equal([]);
        expect(capture.produce).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("wrapBulkProducer + onCacheReadFailure: 'throw': a mixed bypass+read batch emits NO fetch messages -- even after the bypass invocation settles and stores", async () => {
      const { name, store, cache } = makeHarness("fetch-bulk-throw-bypass");
      const readError = new Error("store exploded");
      store.getMany = async () => {
        throw readError;
      };
      const capture = captureChannels(name);
      const producer = mock.fn(
        async (reqs: readonly { readonly id: string }[]) =>
          reqs.map((req) => ({
            content: `ok-${req.id}`,
            directives: freshFor100,
          })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        { onCacheReadFailure: "throw" },
        bulkProducerByIdType(cache, { site_day: producer }),
      );
      try {
        // The bypass element's invocation launches before (and independently
        // of) the read; the read failure then rejects the whole call.
        const thrown = await expectRejection(() =>
          getBulk([
            { id: "site:bypass", directives: { maxAge: 0 } },
            { id: "site:read" },
          ]),
        );
        expect(thrown).to.equal(readError);

        // The in-flight bypass invocation still settles, stores its result
        // (store-on-success), and publishes its produce message -- but the
        // call rejected before delivering its answer, so no fetch message
        // may ever claim `served-from-producer` for it.
        await waitUntil(
          () => capture.produce.length === 1 && capture.storeEntry.length === 1,
          "bypass invocation settling after the call rejected",
        );
        await delay(20);
        // Only the non-bypass element reached the store, so only it reports a
        // failed read: bypass requests skip the read entirely and never appear
        // on this channel at all (not even as a failure).
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:read",
            found: "read-failed",
            error: readError,
          },
        ]);
        expect(capture.fetch).to.deep.equal([]);
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "bypass",
          requests: [{ resourceType: "site_day", resourceId: "site:bypass" }],
          collapsedCallerCount: 1,
          outcome: "success",
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("sole-type caches attribute every message to the sole resource type, even with the trivial guard", async () => {
      const name = uniqueCacheName("fetch-sole-type");
      const cache = new Cache({
        store: memoryStoreFor(soleVisitsRegistry),
        name,
        resourceTypes: soleVisitsRegistry,
      });
      const capture = captureChannels(name);
      const producer = mock.fn(async (req: { readonly id: string }) => ({
        content: `content-${req.id}`,
        directives: freshFor100,
      }));
      // A sole-type registry: the producer covers the whole registry, so it
      // goes in bare -- no helper, no declared covered set.
      const getVisits = wrapProducer(cache, {}, producer);
      try {
        await getVisits({ id: "no-structure-at-all" });
        await waitUntil(
          () => capture.storeEntry.length === 1 && capture.produce.length === 1,
          "sole-type miss cascade",
        );
        expect(capture.read[0]?.resourceType).to.equal("visits");
        expect(capture.fetch[0]?.resourceType).to.equal("visits");
        expect(capture.produce[0]?.requests).to.deep.equal([
          { resourceType: "visits", resourceId: "no-structure-at-all" },
        ]);
        expect(capture.storeEntry[0]?.resourceType).to.equal("visits");
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("produce channel (§6.5.3)", () => {
    it("durationMs measures invocation time", async () => {
      const { name, cache } = makeHarness("produce-duration");
      const capture = captureChannels(name);
      const producer = mock.fn(async () => {
        await delay(60);
        return { content: "slow", directives: freshFor100 };
      });
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        await getSite({ id: "site:a" });
        expect(capture.produce).to.have.lengthOf(1);
        const message = capture.produce[0];
        expect(message?.durationMs).to.be.a("number");
        expect(message?.durationMs).to.be.at.least(40);
        expect(message?.durationMs).to.be.below(10_000);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("wrapBulkProducer via bulkProducerByIdType: ONE invocation (and one produce message) per window whose requests[] spans types, while each sub-producer's batch stays type-pure", async () => {
      const { name, cache } = makeHarness("produce-bulk");
      const capture = captureChannels(name);
      const siteBulk = mock.fn(
        async (reqs: readonly { readonly id: string }[]) =>
          reqs.map((req) => ({
            content: `site-content-${req.id}`,
            directives: freshFor100,
          })),
      );
      const bizBulk = mock.fn(
        async (reqs: readonly { readonly id: string }[]) =>
          reqs.map((req) => ({
            content: `biz-content-${req.id}`,
            directives: freshFor100,
          })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, {
          site_day: siteBulk,
          business_slice: bizBulk,
        }),
      );
      try {
        const results = await getBulk([
          { id: "site:a" },
          { id: "biz:b" },
          { id: "site:c" },
        ]);

        // Results stay request-paired across the helper's split-and-reassemble
        // (positional, so a repeated id can't misroute).
        const contents = results.map((r) => {
          if (r instanceof Error) throw r;
          return r.content;
        });
        expect(contents).to.deep.equal([
          "site-content-site:a",
          "biz-content-biz:b",
          "site-content-site:c",
        ]);

        // Each type's SUB-producer saw one batch containing ONLY its own ids:
        // that partition is the helper's job now, not the wrapper's.
        expect(siteBulk.mock.callCount()).to.equal(1);
        expect(bizBulk.mock.callCount()).to.equal(1);
        expect(
          siteBulk.mock.calls[0]?.arguments[0]?.map((r) => r.id).sort(),
        ).to.deep.equal(["site:a", "site:c"]);
        expect(
          bizBulk.mock.calls[0]?.arguments[0]?.map((r) => r.id),
        ).to.deep.equal(["biz:b"]);

        // But the WRAPPER made a single producer invocation, so there is one
        // produce message, and its requests[] spans resource types in the
        // caller's order -- each element carrying its own resourceType (the
        // §6.5.3 invariant that all elements share one type is deleted).
        expect(capture.produce).to.have.lengthOf(1);
        expect(capture.produce[0]?.trigger).to.equal("miss");
        expect(capture.produce[0]?.outcome).to.equal("success");
        expect(capture.produce[0]?.requests).to.deep.equal([
          { resourceType: "site_day", resourceId: "site:a" },
          { resourceType: "business_slice", resourceId: "biz:b" },
          { resourceType: "site_day", resourceId: "site:c" },
        ]);

        // One read and one fetch per request element.
        expect(capture.read).to.have.lengthOf(3);
        expect(capture.fetch).to.have.lengthOf(3);
        const fetches = sortByResourceId(capture.fetch);
        expectProducerPathFetch(fetches[0], {
          cache: name,
          resourceType: "business_slice",
          resourceId: "biz:b",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProducerPathFetch(fetches[1], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProducerPathFetch(fetches[2], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:c",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("wrapBulkProducer: per-request Error elements are returned in place; their fetch settles as producer-error", async () => {
      const { name, cache } = makeHarness("produce-bulk-errors");
      const capture = captureChannels(name);
      const perRequestError = new Error("this one failed");
      const siteBulk = mock.fn(
        async (reqs: readonly { readonly id: string }[]) =>
          reqs.map((req) =>
            req.id === "site:bad"
              ? perRequestError
              : { content: `ok-${req.id}`, directives: freshFor100 },
          ),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, { site_day: siteBulk }),
      );
      try {
        const results = await getBulk([{ id: "site:ok" }, { id: "site:bad" }]);
        const first = results[0];
        if (first instanceof Error) throw first;
        expect(first.content).to.equal("ok-site:ok");
        expect(results[1]).to.equal(perRequestError);

        expect(capture.fetch).to.have.lengthOf(2);
        const fetches = sortByResourceId(capture.fetch);
        expectProducerPathFetch(fetches[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:bad",
          disposition: "producer-error",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProducerPathFetch(fetches[1], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:ok",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });

        // One invocation covered both requests:
        // `outcome` reports invocation SETTLEMENT: a resolved batch is a
        // "success" even when elements are ErrorType (those settle as
        // per-element producer-error fetches above).
        expect(capture.produce).to.have.lengthOf(1);
        expect(capture.produce[0]?.trigger).to.equal("miss");
        expect(capture.produce[0]?.outcome).to.equal("success");
        expect(
          sortByResourceId(capture.produce[0]?.requests ?? []),
        ).to.deep.equal([
          { resourceType: "site_day", resourceId: "site:bad" },
          { resourceType: "site_day", resourceId: "site:ok" },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("wrapBulkProducer: a short result array fails the whole invocation -- including through bulkProducerByIdType, which does not pad: every element settles producer-error exactly once, nothing stores, produce reports error", async () => {
      const { name, cache } = makeHarness("produce-bulk-short");
      const capture = captureChannels(name);
      // A buggy producer that returns one result for three requests. An
      // under-return poisons the positional (result, request) pairing -- a
      // dropped MIDDLE element would pair later results with the wrong
      // requests -- so elements before the gap must not report
      // served-from-producer (the call rejects; nothing is delivered),
      // elements after it must still settle, and the prefix must not store.
      //
      // Routed through the by-id-type helper on purpose: the helper leaves an
      // under-returning sub-producer's slots ABSENT rather than substituting
      // Errors, so the wrapper's check below fires exactly as it does for a
      // bare producer instead of the violation degrading into per-request
      // failures.
      const siteBulk = mock.fn(
        async (reqs: readonly { readonly id: string }[]) =>
          reqs.slice(0, 1).map((req) => ({
            content: `ok-${req.id}`,
            directives: freshFor100,
          })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, { site_day: siteBulk }),
      );
      try {
        const thrown = await expectRejection(() =>
          getBulk([{ id: "site:a" }, { id: "site:b" }, { id: "site:c" }]),
        );
        expect(thrown).to.be.instanceOf(Error);
        expect((thrown as Error).message).to.match(
          /returned results for only 1 of 3 requests/,
        );

        // One fetch per request element, every one producer-error.
        expect(capture.fetch).to.have.lengthOf(3);
        sortByResourceId(capture.fetch).forEach((message, i) => {
          expectProducerPathFetch(message, {
            cache: name,
            resourceType: "site_day",
            resourceId: ["site:a", "site:b", "site:c"][i] ?? "",
            disposition: "producer-error",
            directivesImpliedBypass: false,
            collapsed: false,
          });
        });

        // The invocation settled by rejecting (the contract violation), so
        // produce reports error -- and the untrustworthy prefix is not
        // stored.
        expect(capture.produce).to.have.lengthOf(1);
        expect(capture.produce[0]?.outcome).to.equal("error");
        expect(capture.storeEntry).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("wrapBulkProducer: a wholesale producer rejection settles every element's fetch as producer-error and rethrows", async () => {
      const { name, cache } = makeHarness("produce-bulk-wholesale");
      const capture = captureChannels(name);
      const wholesaleError = new Error("entire batch failed");
      const siteBulk = mock.fn(async () => {
        throw wholesaleError;
      });
      // A BARE producer, deliberately: rethrowing a wholesale rejection is the
      // wrapper's own contract (it can't know the thrown value is an
      // `ErrorType`). A rejection from one of `bulkProducerByIdType`'s
      // sub-producers is a different case -- the helper catches it and isolates
      // it into that type's result slots as Error elements.
      const getBulk = wrapBulkProducer(cache, {}, siteBulk);
      try {
        const thrown = await expectRejection(() =>
          getBulk([{ id: "site:a" }, { id: "site:b" }]),
        );
        expect(thrown).to.equal(wholesaleError);

        expect(capture.fetch).to.have.lengthOf(2);
        const fetches = sortByResourceId(capture.fetch);
        expectProducerPathFetch(fetches[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          disposition: "producer-error",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProducerPathFetch(fetches[1], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:b",
          disposition: "producer-error",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        // The invocation itself settled by rejecting: outcome "error".
        expect(capture.produce).to.have.lengthOf(1);
        expect(capture.produce[0]?.outcome).to.equal("error");
        expect(capture.storeEntry).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("computing wrappers publish the same channel stream, attributed with minted ids: miss emits read/produce/store-entry/fetch; hit emits read/fetch only", async () => {
      const { name, cache } = makeHarness("produce-computing-channels");
      const capture = captureChannels(name);
      const compute = wrapComputingProducer<
        { key: string },
        typeof registry,
        "site_day"
      >(
        cache,
        {},
        {
          site_day: {
            hashInput: (input): `site:${string}` => `site:${input.key}`,
            produce: async (input) => ({
              content: `computed-${input.key}`,
              directives: freshFor100,
            }),
          },
        },
      );
      try {
        await compute({ key: "k1" });
        await waitUntil(
          () => capture.storeEntry.length === 1,
          "computed result stored",
        );
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:k1",
            found: "none",
          },
        ]);
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: "site:k1" }],
          collapsedCallerCount: 1,
          outcome: "success",
        });
        expect(capture.fetch).to.have.lengthOf(1);
        expectProducerPathFetch(capture.fetch[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:k1",
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expect(capture.storeEntry[0]).to.deep.include({
          cache: name,
          resourceType: "site_day",
          resourceId: "site:k1",
        });

        // A repeat compute() is a hit: one more read + fetch, nothing else.
        await compute({ key: "k1" });
        expect(capture.read).to.have.lengthOf(2);
        expect(capture.read[1]?.found).to.equal("usable");
        expect(capture.fetch).to.have.lengthOf(2);
        expectCachePathFetch(capture.fetch[1], {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:k1",
          disposition: "served-from-cache",
          collapsed: false,
        });
        expect(capture.produce).to.have.lengthOf(1);
        expect(capture.storeEntry).to.have.lengthOf(1);
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("store-entry channel (§6.5.4)", () => {
    it("publishes one fully-attributed message per stored entry, carrying vary, validators, and the store-reported relationship", async () => {
      const { name, cache } = makeHarness("store-entry-basic");
      const capture = captureChannels(name);
      const vary = { someParam: "someValue" };
      try {
        await cache.store([
          {
            id: "site:a",
            vary,
            content: "v1",
            validators: { contentHash: "a" },
            directives: freshFor100,
          },
        ]);
        await cache.store([
          {
            id: "site:a",
            vary,
            content: "v1",
            validators: { contentHash: "a" },
            directives: freshFor100,
          },
        ]);
        await cache.store([
          {
            id: "site:a",
            vary,
            content: "v2",
            validators: { contentHash: "b" },
            directives: freshFor100,
          },
        ]);

        expect(capture.storeEntry).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            vary,
            validators: { contentHash: "a" },
            relationshipToExistingStoredData: "is-new",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            vary,
            validators: { contentHash: "a" },
            relationshipToExistingStoredData: "unchanged",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            vary,
            validators: { contentHash: "b" },
            relationshipToExistingStoredData: "changed",
          },
        ]);
        // The StoreOrigin concept was cut: the message has no initiator field.
        expect(capture.storeEntry[0]).to.not.have.property("origin");
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("relationshipToExistingStoredData is undefined when not comparable (empty validators)", async () => {
      const { name, cache } = makeHarness("store-entry-uncomparable");
      const capture = captureChannels(name);
      try {
        await cache.store([
          {
            id: "site:no-validators",
            content: "a",
            directives: freshFor100,
          },
          {
            id: "site:with-validators",
            content: "b",
            validators: { rowVersion: 1 },
            directives: freshFor100,
          },
        ]);
        expect(sortByResourceId(capture.storeEntry)).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:no-validators",
            vary: {},
            validators: {},
            relationshipToExistingStoredData: undefined,
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:with-validators",
            vary: {},
            validators: { rowVersion: 1 },
            relationshipToExistingStoredData: "is-new",
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("in-call same-slot duplicates still emit one message each; the losing duplicate's relationship is undefined", async () => {
      const { name, cache } = makeHarness("store-entry-duplicates");
      const capture = captureChannels(name);
      try {
        await cache.store([
          {
            id: "site:dup",
            content: "older",
            validators: { contentHash: "old" },
            directives: freshFor100,
            date: secondsAgo(2),
          },
          {
            id: "site:dup",
            content: "newer",
            validators: { contentHash: "new" },
            directives: freshFor100,
            date: secondsAgo(1),
          },
        ]);
        expect(capture.storeEntry).to.have.lengthOf(2);
        const relationships = capture.storeEntry
          .map((m) => m.relationshipToExistingStoredData)
          .sort((a, b) => String(a).localeCompare(String(b)));
        expect(relationships).to.deep.equal(["is-new", undefined]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("supplemental entries are attributed to THEIR OWN resource type, not the producing flow's", async () => {
      const { name, cache } = makeHarness("store-entry-supplemental");
      const capture = captureChannels(name);
      const producer = mock.fn(async () => ({
        content: "site-content",
        validators: { contentHash: "h-site" },
        directives: freshFor100,
        supplementalResources: [
          {
            id: "biz:1" as const,
            content: "slice-1",
            validators: { contentHash: "h-b1" },
            directives: freshFor100,
          },
          {
            id: "biz:2" as const,
            content: "slice-2",
            validators: { contentHash: "h-b2" },
            directives: freshFor100,
          },
        ],
      }));
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: producer }),
      );
      try {
        await getSite({ id: "site:a" });
        await waitUntil(
          () => capture.storeEntry.length === 3,
          "primary + supplemental store-entry messages",
        );
        expect(sortByResourceId(capture.storeEntry)).to.deep.equal([
          {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:1",
            vary: {},
            validators: { contentHash: "h-b1" },
            relationshipToExistingStoredData: "is-new",
          },
          {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:2",
            vary: {},
            validators: { contentHash: "h-b2" },
            relationshipToExistingStoredData: "is-new",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: "site:a",
            vary: {},
            validators: { contentHash: "h-site" },
            relationshipToExistingStoredData: "is-new",
          },
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("§7 execution pattern: the golden end-to-end simulation", () => {
    it("walks the documented message stream: miss cascade, rider, slice hit, SWR revalidation, outage", async () => {
      const name = uniqueCacheName("golden-e2e");
      const store = memoryStoreFor(registry);
      const cache = new Cache({
        store: store,
        name,
        resourceTypes: registry,
      });
      const capture = captureChannels(name);

      const siteId = "site:X" as const;
      const bizIds = ["biz:B1", "biz:B2"] as const;
      const phase = { producerHealthy: true };
      const outageError = new Error("vendor outage");
      // One-shot gate for the t=0 rider phase: holds the FIRST invocation
      // open until the rider has provably attached (a fixed pending window
      // flakes under suite load). Once released, later phases' invocations
      // pass straight through it.
      let releaseT0Invocation = () => {};
      const t0Gate = new Promise<void>((resolve) => {
        releaseT0Invocation = resolve;
      });
      const siteProducer = mock.fn(async () => {
        await t0Gate;
        await delay(25);
        if (!phase.producerHealthy) throw outageError;
        return {
          content: "site-visits-v1",
          validators: { contentHash: "h1" },
          directives: {
            freshUntilAge: 0.1,
            maxStale: {
              withoutRevalidation: 0,
              whileRevalidate: 100,
              ifError: 100,
            },
          },
          supplementalResources: bizIds.map((id) => ({
            id,
            content: `slice-${id}`,
            validators: { contentHash: `h-${id}` },
            directives: freshFor100,
          })),
        };
      });
      const bizProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `derived-${req.id}`,
        directives: freshFor100,
      }));
      const getVisits = wrapProducer(
        cache,
        {},
        producerByIdType(cache, {
          site_day: siteProducer,
          business_slice: bizProducer,
        }),
      );

      try {
        // ---- t=0: first read of site:X (miss), with a concurrent rider ----
        const initiator = getVisits({ id: siteId });
        await waitUntil(
          () => siteProducer.mock.callCount() === 1,
          "the initiator's invocation starting",
          10_000,
        );
        const rider = getVisits({ id: siteId });
        // The rider publishes its own read BEFORE consulting the collapse
        // registry, so once its read is visible it has attached to the
        // still-gated invocation.
        await waitUntil(
          () => capture.read.length === 2,
          "the rider's own read",
          10_000,
        );
        releaseT0Invocation();
        const [initiatorRes, riderRes] = await Promise.all([initiator, rider]);
        expect(initiatorRes.content).to.equal("site-visits-v1");
        expect(riderRes.content).to.equal("site-visits-v1");
        expect(siteProducer.mock.callCount()).to.equal(1);

        await waitUntil(
          () => capture.storeEntry.length === 3 && capture.fetch.length === 2,
          "t=0 miss cascade fully published",
        );

        // Both the initiator and the rider report their own lookups (§7 as
        // adjudicated); only the producer invocation is shared.
        expect(capture.read).to.deep.equal([
          {
            cache: name,
            resourceType: "site_day",
            resourceId: siteId,
            found: "none",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: siteId,
            found: "none",
          },
        ]);
        expect(capture.produce).to.have.lengthOf(1);
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: siteId }],
          collapsedCallerCount: 2,
          outcome: "success",
          minDurationMs: 15,
        });
        expect(sortByResourceId(capture.storeEntry)).to.deep.equal([
          {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:B1",
            vary: {},
            validators: { contentHash: "h-biz:B1" },
            relationshipToExistingStoredData: "is-new",
          },
          {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:B2",
            vary: {},
            validators: { contentHash: "h-biz:B2" },
            relationshipToExistingStoredData: "is-new",
          },
          {
            cache: name,
            resourceType: "site_day",
            resourceId: siteId,
            vary: {},
            validators: { contentHash: "h1" },
            relationshipToExistingStoredData: "is-new",
          },
        ]);
        const t0Fetches = [...capture.fetch].sort(
          (a, b) => Number(a.collapsed) - Number(b.collapsed),
        );
        expectProducerPathFetch(t0Fetches[0], {
          cache: name,
          resourceType: "site_day",
          resourceId: siteId,
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProducerPathFetch(t0Fetches[1], {
          cache: name,
          resourceType: "site_day",
          resourceId: siteId,
          disposition: "served-from-producer",
          directivesImpliedBypass: false,
          collapsed: true,
        });

        // §7 presents the t=0 flow as a cascade beginning
        // read -> produce -> store-entry x3, with the fetches settling after
        // the read. (The relative order of the fetch settlements vs the
        // store-entry publishes is NOT asserted: the doc leaves open whether
        // callers settle before the fire-and-forget store completes.)
        const channelOrder = capture.all.map((m) => m.channel);
        expect(channelOrder.indexOf("read")).to.equal(0);
        expect(channelOrder.indexOf("produce")).to.be.greaterThan(
          channelOrder.indexOf("read"),
        );
        expect(channelOrder.indexOf("store-entry")).to.be.greaterThan(
          channelOrder.indexOf("produce"),
        );
        expect(channelOrder.indexOf("fetch")).to.be.greaterThan(
          channelOrder.indexOf("read"),
        );

        // ---- t=1: business B1's slice, served from cache ----
        const t1Start = capture.all.length;
        const sliceRes = await getVisits({ id: "biz:B1" });
        expect(sliceRes.content).to.equal("slice-biz:B1");
        expect(bizProducer.mock.callCount()).to.equal(0);
        const t1Messages = capture.all.slice(t1Start);
        expect(t1Messages).to.have.lengthOf(2);
        expect(t1Messages[0]).to.deep.equal({
          channel: "read",
          message: {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:B1",
            found: "usable",
          },
        });
        expect(t1Messages[1]?.channel).to.equal("fetch");
        expectCachePathFetch(
          t1Messages[1]?.channel === "fetch"
            ? t1Messages[1].message
            : undefined,
          {
            cache: name,
            resourceType: "business_slice",
            resourceId: "biz:B1",
            disposition: "served-from-cache",
            collapsed: false,
          },
        );

        // ---- t=2 (> TTL, inside SWR window): stale serve + revalidation ----
        await delay(150); // site entry (freshUntilAge 0.1) is now stale
        const t2Start = capture.all.length;
        // No consumer directives: the producer's generous whileRevalidate
        // window (100s) selects the SWR path regardless of exactly how stale
        // the entry has become by now.
        const swrRes = await getVisits({ id: siteId });
        expect(swrRes.content).to.equal("site-visits-v1");
        const t2Read = capture.all[t2Start];
        expect(t2Read).to.deep.equal({
          channel: "read",
          message: {
            cache: name,
            resourceType: "site_day",
            resourceId: siteId,
            found: "usable-while-revalidate",
          },
        });
        const t2Fetch = capture.fetch.at(-1);
        expectCachePathFetch(t2Fetch, {
          cache: name,
          resourceType: "site_day",
          resourceId: siteId,
          disposition: "served-stale-while-revalidating",
          collapsed: false,
        });

        // The revalidation settles after the fetch already shipped...
        await waitUntil(
          () => capture.produce.length === 2,
          "revalidation produce message",
        );
        expectProduceMessage(capture.produce[1], {
          cache: name,
          trigger: "revalidation",
          requests: [{ resourceType: "site_day", resourceId: siteId }],
          collapsedCallerCount: 1,
          outcome: "success",
          minDurationMs: 15,
        });
        // ...and the vendor data didn't move (same contentHash), so the
        // re-stored entries report "unchanged".
        await waitUntil(
          () => capture.storeEntry.length === 6,
          "revalidation store-entry messages",
        );
        const t2StoreEntries = capture.storeEntry.slice(3);
        expect(
          sortByResourceId(t2StoreEntries).map((m) => ({
            resourceId: m.resourceId,
            resourceType: m.resourceType,
            relationship: m.relationshipToExistingStoredData,
          })),
        ).to.deep.equal([
          {
            resourceId: "biz:B1",
            resourceType: "business_slice",
            relationship: "unchanged",
          },
          {
            resourceId: "biz:B2",
            resourceType: "business_slice",
            relationship: "unchanged",
          },
          {
            resourceId: siteId,
            resourceType: "site_day",
            relationship: "unchanged",
          },
        ]);
        expect(siteProducer.mock.callCount()).to.equal(2);

        // ---- producer outage; foreground caller inside the if-error window ----
        phase.producerHealthy = false;
        await delay(150); // the revalidated entry (freshUntilAge 0.1) is stale again
        const t3Start = capture.all.length;
        const ifErrorRes = await getVisits({
          id: siteId,
          // Consumer directives put this request outside the SWR window but
          // inside the if-error window.
          directives: {
            maxStale: {
              withoutRevalidation: 0,
              whileRevalidate: 0,
              ifError: 100,
            },
          },
        });
        expect(ifErrorRes.content).to.equal("site-visits-v1");
        expect(capture.all[t3Start]).to.deep.equal({
          channel: "read",
          message: {
            cache: name,
            resourceType: "site_day",
            resourceId: siteId,
            found: "usable-if-error",
          },
        });
        expectCachePathFetch(capture.fetch.at(-1), {
          cache: name,
          resourceType: "site_day",
          resourceId: siteId,
          disposition: "served-stale-after-error",
          collapsed: false,
        });
        expect(capture.produce).to.have.lengthOf(3);
        expectProduceMessage(capture.produce[2], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: siteId }],
          collapsedCallerCount: 1,
          outcome: "error",
          minDurationMs: 15,
        });

        // ---- outage, caller OUTSIDE the if-error window: the error surfaces ----
        const t4Start = capture.all.length;
        const thrown = await expectRejection(() =>
          getVisits({
            id: siteId,
            directives: {
              maxStale: {
                withoutRevalidation: 0,
                whileRevalidate: 0,
                ifError: 0,
              },
            },
          }),
        );
        expect(thrown).to.equal(outageError);
        expect(capture.all[t4Start]).to.deep.equal({
          channel: "read",
          message: {
            cache: name,
            resourceType: "site_day",
            resourceId: siteId,
            found: "none",
          },
        });
        expectProducerPathFetch(capture.fetch.at(-1), {
          cache: name,
          resourceType: "site_day",
          resourceId: siteId,
          disposition: "producer-error",
          directivesImpliedBypass: false,
          collapsed: false,
        });
        expectProduceMessage(capture.produce[3], {
          cache: name,
          trigger: "miss",
          requests: [{ resourceType: "site_day", resourceId: siteId }],
          collapsedCallerCount: 1,
          outcome: "error",
          minDurationMs: 15,
        });

        // ---- final sweep: totals and universal attribution ----
        // (6 reads: the t=0 initiator AND rider each report one, plus one per
        // later phase.)
        expect(capture.read).to.have.lengthOf(6);
        expect(capture.fetch).to.have.lengthOf(6);
        expect(capture.produce).to.have.lengthOf(4);
        expect(capture.storeEntry).to.have.lengthOf(6);
        expect(siteProducer.mock.callCount()).to.equal(4);
        expect(bizProducer.mock.callCount()).to.equal(0);
        capture.all.forEach(({ channel, message }) => {
          expect(message.cache).to.equal(name);
          if (channel === "produce") {
            message.requests.forEach((r) => {
              expect(["site_day", "business_slice"]).to.include(r.resourceType);
            });
          } else {
            expect(["site_day", "business_slice"]).to.include(
              message.resourceType,
            );
          }
        });
      } finally {
        releaseT0Invocation();
        capture.stop();
        await cache.close();
      }
    });
  });
});
