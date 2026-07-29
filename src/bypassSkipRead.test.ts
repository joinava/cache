import { expect } from "chai";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "timers/promises";

import {
  captureChannels,
  expectProducerPathFetch,
  expectProduceMessage,
  memoryStoreFor,
  uniqueCacheName,
  waitUntil,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  idStartsWith,
  resourceType,
  wrapBulkProducer,
  type ResourceTypes,
} from "./index.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * §6.3's bypass-skip-read behavior change: when the consumer's directives
 * request a cache bypass (`maxAge: 0`), the wrappers no longer read the cache
 * at all. `maxAge: 0` structurally guarantees producer contact (closing the
 * age<=0 / skewed-clock hole), bypass requests never appear on the read
 * channel, the result is still stored, and bypass requests collapse only
 * with identical-directive peers.
 */

const registry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<string>()({ matches: idStartsWith("biz:") }),
} satisfies ResourceTypes;

const freshFor100 = { freshUntilAge: 100 };

const makeHarness = (label: string) => {
  const name = uniqueCacheName(label);
  const store = memoryStoreFor(registry);
  const getSpy = mock.method(store, "get");
  const getManySpy = mock.method(store, "getMany");
  const cache = new Cache(store, { name, resourceTypes: registry });
  return { name, store, getSpy, getManySpy, cache };
};

describe("bypass requests skip the cache read (§6.3)", () => {
  it("a maxAge: 0 request performs NO store read, emits NO read message, reaches the producer, and its result IS stored", async () => {
    const { name, getSpy, getManySpy, cache } = makeHarness("bypass-basic");
    const capture = captureChannels(name);
    const producer = mock.fn(async () => ({
      content: "from-producer",
      directives: freshFor100,
    }));
    const getSite = wrapProducer(cache, {}, { site_day: producer });
    try {
      const res = await getSite({
        id: "site:a",
        directives: { maxAge: 0 },
      });
      expect(res.content).to.equal("from-producer");
      expect(producer.mock.callCount()).to.equal(1);

      // No store read of any shape, and nothing on the read channel.
      expect(getSpy.mock.callCount()).to.equal(0);
      expect(getManySpy.mock.callCount()).to.equal(0);
      expect(capture.read).to.deep.equal([]);

      expect(capture.fetch).to.have.lengthOf(1);
      expectProducerPathFetch(capture.fetch[0], {
        cache: name,
        resourceType: "site_day",
        resourceId: "site:a",
        disposition: "served-from-producer",
        directivesImpliedBypass: true,
        collapsed: false,
      });
      expectProduceMessage(capture.produce[0], {
        cache: name,
        trigger: "bypass",
        requests: [{ resourceType: "site_day", resourceId: "site:a" }],
        collapsedCallerCount: 1,
        outcome: "success",
      });

      // The bypassed result is still stored...
      await waitUntil(
        () => capture.storeEntry.length === 1,
        "bypass result stored",
      );
      expect(capture.storeEntry[0]).to.deep.include({
        cache: name,
        resourceType: "site_day",
        resourceId: "site:a",
      });

      // ...so a subsequent PLAIN request is served from cache without a
      // second producer call. That plain request also acts as the positive
      // control for the spy: the same store `get` spy that recorded zero
      // calls above records this read.
      const plain = await getSite({ id: "site:a" });
      expect(plain.content).to.equal("from-producer");
      expect(producer.mock.callCount()).to.equal(1);
      expect(getSpy.mock.callCount()).to.equal(1);
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

  it("bypass structurally guarantees producer contact even when a perfectly fresh entry exists", async () => {
    const { name, getSpy, cache } = makeHarness("bypass-fresh-entry");
    await cache.store([
      { id: "site:a", content: "cached-content", directives: freshFor100 },
    ]);
    const capture = captureChannels(name);
    const producer = mock.fn(async () => ({
      content: "regenerated-content",
      directives: freshFor100,
    }));
    const getSite = wrapProducer(cache, {}, { site_day: producer });
    try {
      const res = await getSite({ id: "site:a", directives: { maxAge: 0 } });
      expect(res.content).to.equal("regenerated-content");
      expect(producer.mock.callCount()).to.equal(1);
      expect(getSpy.mock.callCount()).to.equal(0);
      expect(capture.read).to.deep.equal([]);
      expectProducerPathFetch(capture.fetch[0], {
        cache: name,
        resourceType: "site_day",
        resourceId: "site:a",
        disposition: "served-from-producer",
        directivesImpliedBypass: true,
        collapsed: false,
      });
    } finally {
      capture.stop();
      await cache.close();
    }
  });

  it("regression (the age<=0 hole): an entry producer-stamped in the FUTURE (negative age, skewed clock) must NOT satisfy maxAge: 0", async () => {
    const { name, cache } = makeHarness("bypass-clock-skew");
    // A pod whose clock runs ahead stamped this entry's `date` 60s in the
    // reader's future, so its age here is NEGATIVE. Age is compared to the
    // maxAge ceiling with strict `>`, so in 1.6.0 (which read the cache
    // before honoring the bypass) this entry satisfied `maxAge: 0` and was
    // served as a "hit" against the consumer's evident intent.
    await cache.store([
      {
        id: "site:skewed",
        content: "from-the-future",
        directives: freshFor100,
        date: new Date(Date.now() + 60_000),
      },
    ]);
    const capture = captureChannels(name);
    const producer = mock.fn(async () => ({
      content: "from-producer",
      directives: freshFor100,
    }));
    const getSite = wrapProducer(cache, {}, { site_day: producer });
    try {
      const res = await getSite({
        id: "site:skewed",
        directives: { maxAge: 0 },
      });
      expect(res.content).to.equal("from-producer");
      expect(res.content).to.not.equal("from-the-future");
      expect(producer.mock.callCount()).to.equal(1);
      expectProducerPathFetch(capture.fetch[0], {
        cache: name,
        resourceType: "site_day",
        resourceId: "site:skewed",
        disposition: "served-from-producer",
        directivesImpliedBypass: true,
        collapsed: false,
      });
    } finally {
      capture.stop();
      await cache.close();
    }
  });

  it("bypass requests collapse ONLY with identical-directive peers: a concurrent plain request never rides the bypass invocation", async () => {
    const { name, cache } = makeHarness("bypass-no-cross-collapse");
    const capture = captureChannels(name);
    // Gated rather than delayed: the gate holds the bypass invocation open
    // (its result unstored) for as long as the plain request's read takes,
    // so this can't flake under suite load the way a fixed pending window
    // does (the plain read landing late once made the plain call a cache
    // hit, collapsing the two invocations this test distinguishes).
    let releaseProducer = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    const producer = mock.fn(async () => {
      await gate;
      return { content: "produced", directives: freshFor100 };
    });
    const getSite = wrapProducer(cache, {}, { site_day: producer });
    try {
      const bypassCall = getSite({
        id: "site:a",
        directives: { maxAge: 0 },
      });
      await waitUntil(
        () => producer.mock.callCount() === 1,
        "the bypass invocation starting",
        10_000,
      );
      // Same id, but different (empty) directives: the collapse key includes
      // directives, so this must trigger its own producer invocation even
      // though the bypass invocation is still in flight. Under the
      // cross-collapse bug this wait times out (callCount stays 1) instead
      // of deadlocking.
      const plainCall = getSite({ id: "site:a" });
      await waitUntil(
        () => producer.mock.callCount() === 2,
        "the plain request starting its own producer invocation",
        10_000,
      );
      releaseProducer();
      const [bypassRes, plainRes] = await Promise.all([bypassCall, plainCall]);
      expect(bypassRes.content).to.equal("produced");
      expect(plainRes.content).to.equal("produced");

      expect(producer.mock.callCount()).to.equal(2);
      expect(capture.produce).to.have.lengthOf(2);
      const triggers = capture.produce.map((m) => m.trigger).sort();
      expect(triggers).to.deep.equal(["bypass", "miss"]);
      capture.produce.forEach((m) => {
        expect(m.collapsedCallerCount).to.equal(1);
      });

      // Only the plain request consulted the cache.
      expect(capture.read).to.deep.equal([
        {
          cache: name,
          resourceType: "site_day",
          resourceId: "site:a",
          found: "none",
        },
      ]);

      expect(capture.fetch).to.have.lengthOf(2);
      const fetches = [...capture.fetch].sort(
        (a, b) =>
          Number(a.directivesImpliedBypass ?? false) -
          Number(b.directivesImpliedBypass ?? false),
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
        directivesImpliedBypass: true,
        collapsed: false,
      });
    } finally {
      releaseProducer();
      capture.stop();
      await cache.close();
    }
  });

  it("wrapBulkProducer: bypass elements skip the read (no read messages) while plain elements in the same call read and cache normally", async () => {
    const { name, getSpy, getManySpy, cache } = makeHarness("bypass-bulk");
    const capture = captureChannels(name);
    const bulkProducer = mock.fn(
      async (reqs: readonly { readonly id: string }[]) =>
        reqs.map((req) => ({
          content: `content-${req.id}`,
          directives: { freshUntilAge: 100 },
        })),
    );
    const getBulk = wrapBulkProducer(
      cache,
      { collapseOverlappingRequestsTime: 0 },
      { site_day: bulkProducer },
    );
    const requests = [
      { id: "site:plain-a" },
      { id: "site:bypass-a", directives: { maxAge: 0 } },
      { id: "site:plain-b" },
    ] as const;
    try {
      // First call: the bypass element must reach the producer WITHOUT any
      // cache read; the plain elements read (miss) and then produce. The
      // collapse key includes directives, so bypass and plain elements never
      // share a batch -- and (contract adjudication) the bypass batch
      // dispatches BEFORE the plain elements' cache read, so it is the first
      // producer call.
      const results = await getBulk(requests);
      const contents = results.map((r) => {
        if (r instanceof Error) throw r;
        return r.content;
      });
      expect(contents).to.deep.equal([
        "content-site:plain-a",
        "content-site:bypass-a",
        "content-site:plain-b",
      ]);

      expect(bulkProducer.mock.callCount()).to.equal(2);
      expect(
        bulkProducer.mock.calls[0]?.arguments[0]?.map((r) => r.id),
      ).to.deep.equal(["site:bypass-a"]);
      expect(
        bulkProducer.mock.calls[1]?.arguments[0]?.map((r) => r.id).sort(),
      ).to.deep.equal(["site:plain-a", "site:plain-b"]);

      // Only the plain elements appear on the read channel.
      expect(
        capture.read.map((m) => m.resourceId).sort(),
      ).to.deep.equal(["site:plain-a", "site:plain-b"]);

      // Fetch per element: bypass flagged, plain not.
      expect(capture.fetch).to.have.lengthOf(3);
      capture.fetch.forEach((m) => {
        expect(m.disposition).to.equal("served-from-producer");
        expect(m.directivesImpliedBypass).to.equal(
          m.resourceId === "site:bypass-a",
        );
      });

      // Two invocations, one per directive class.
      expect(capture.produce).to.have.lengthOf(2);
      expect(capture.produce.map((m) => m.trigger).sort()).to.deep.equal([
        "bypass",
        "miss",
      ]);

      // Second call: the plain elements now hit the cache; the bypass
      // element STILL reaches the producer (structurally guaranteed contact).
      await waitUntil(
        () => capture.storeEntry.length === 3,
        "first call's results stored",
      );
      bulkProducer.mock.resetCalls();
      const second = await getBulk(requests);
      const secondContents = second.map((r) => {
        if (r instanceof Error) throw r;
        return r.content;
      });
      expect(secondContents).to.deep.equal([
        "content-site:plain-a",
        "content-site:bypass-a",
        "content-site:plain-b",
      ]);
      expect(bulkProducer.mock.callCount()).to.equal(1);
      expect(
        bulkProducer.mock.calls[0]?.arguments[0]?.map((r) => r.id),
      ).to.deep.equal(["site:bypass-a"]);

      // And a PURE-bypass bulk call performs no store read of any shape.
      const readsBefore = getSpy.mock.callCount() + getManySpy.mock.callCount();
      await getBulk([{ id: "site:bypass-a", directives: { maxAge: 0 } }]);
      expect(
        getSpy.mock.callCount() + getManySpy.mock.callCount(),
      ).to.equal(readsBefore);
    } finally {
      capture.stop();
      await cache.close();
    }
  });

  it("two identical concurrent bypass requests DO collapse onto one invocation", async () => {
    const { name, getSpy, cache } = makeHarness("bypass-peer-collapse");
    const capture = captureChannels(name);
    const producer = mock.fn(async () => {
      await delay(80);
      return { content: "produced-once", directives: freshFor100 };
    });
    const getSite = wrapProducer(cache, {}, { site_day: producer });
    try {
      const first = getSite({ id: "site:a", directives: { maxAge: 0 } });
      await delay(10);
      const second = getSite({ id: "site:a", directives: { maxAge: 0 } });
      const [res1, res2] = await Promise.all([first, second]);
      expect(res1.content).to.equal("produced-once");
      expect(res2.content).to.equal("produced-once");

      expect(producer.mock.callCount()).to.equal(1);
      expect(getSpy.mock.callCount()).to.equal(0);
      expect(capture.read).to.deep.equal([]);

      expect(capture.produce).to.have.lengthOf(1);
      expectProduceMessage(capture.produce[0], {
        cache: name,
        trigger: "bypass",
        requests: [{ resourceType: "site_day", resourceId: "site:a" }],
        collapsedCallerCount: 2,
        outcome: "success",
        minDurationMs: 50,
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
        directivesImpliedBypass: true,
        collapsed: false,
      });
      expectProducerPathFetch(fetches[1], {
        cache: name,
        resourceType: "site_day",
        resourceId: "site:a",
        disposition: "served-from-producer",
        directivesImpliedBypass: true,
        collapsed: true,
      });
    } finally {
      capture.stop();
      await cache.close();
    }
  });
});
