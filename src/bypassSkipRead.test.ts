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
        collapsedCallerCount: 0,
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
    const producer = mock.fn(async () => {
      await delay(80);
      return { content: "produced", directives: freshFor100 };
    });
    const getSite = wrapProducer(cache, {}, { site_day: producer });
    try {
      const bypassCall = getSite({
        id: "site:a",
        directives: { maxAge: 0 },
      });
      await delay(10);
      // Same id, but different (empty) directives: the collapse key includes
      // directives, so this must trigger its own producer invocation even
      // though the bypass invocation is still in flight.
      const plainCall = getSite({ id: "site:a" });
      const [bypassRes, plainRes] = await Promise.all([bypassCall, plainCall]);
      expect(bypassRes.content).to.equal("produced");
      expect(plainRes.content).to.equal("produced");

      expect(producer.mock.callCount()).to.equal(2);
      expect(capture.produce).to.have.lengthOf(2);
      const triggers = capture.produce.map((m) => m.trigger).sort();
      expect(triggers).to.deep.equal(["bypass", "miss"]);
      capture.produce.forEach((m) => {
        expect(m.collapsedCallerCount).to.equal(0);
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
        collapsedCallerCount: 1,
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
