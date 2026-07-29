import { expect } from "chai";
import fc from "fast-check";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "timers/promises";

import {
  AdversarialIdArb,
  ObjectPrototypeCollisionKeyArb,
} from "../test/arbitraries/adversarialIds.js";
import {
  captureChannels,
  expectRejection,
  expectSyncThrow,
  memoryStoreFor,
  uniqueCacheName,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  AmbiguousResourceTypeError,
  idStartsWith,
  resourceType,
  soleResourceType,
  UnclassifiableIdError,
  type ResourceTypes,
} from "./index.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * Acceptance tests for the §6.1/§6.2 classification contract: every id a
 * cache sees (get/getMany request ids, stored entry ids -- primary AND
 * supplemental -- and delete ids) must match EXACTLY ONE registry guard.
 * Zero matches throw UnclassifiableIdError; two or more throw
 * AmbiguousResourceTypeError; failures reject the operation BEFORE the store
 * is touched.
 */

const twoTypeRegistry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<string>()({ matches: idStartsWith("biz:") }),
} satisfies ResourceTypes;

// Overlapping guards: every `site:special:*` id matches BOTH types. Note that
// the guard listed first still matches, so a first-match-wins classifier
// would silently return "site_day" here instead of failing loud.
const overlappingRegistry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  site_special: resourceType<string>()({ matches: idStartsWith("site:special:") }),
} satisfies ResourceTypes;

const soleVisitsRegistry = {
  visits: soleResourceType<string>(),
} satisfies ResourceTypes;

const soleAnythingRegistry = {
  anything: soleResourceType<string>(),
} satisfies ResourceTypes;

const freshFor100 = { freshUntilAge: 100 };

const assertUnclassifiable = (
  thrown: unknown,
  expected: { cacheName: string; id: string },
): UnclassifiableIdError => {
  if (!(thrown instanceof UnclassifiableIdError)) {
    throw new Error(
      `expected an UnclassifiableIdError, got: ${String(thrown)}`,
    );
  }
  expect(thrown.name).to.equal("UnclassifiableIdError");
  expect(thrown.cacheName).to.equal(expected.cacheName);
  expect(thrown.id).to.equal(expected.id);
  return thrown;
};

const assertAmbiguous = (
  thrown: unknown,
  expected: {
    cacheName: string;
    id: string;
    matchedResourceTypes: readonly string[];
  },
): AmbiguousResourceTypeError => {
  if (!(thrown instanceof AmbiguousResourceTypeError)) {
    throw new Error(
      `expected an AmbiguousResourceTypeError, got: ${String(thrown)}`,
    );
  }
  expect(thrown.name).to.equal("AmbiguousResourceTypeError");
  expect(thrown.cacheName).to.equal(expected.cacheName);
  expect(thrown.id).to.equal(expected.id);
  // The doc doesn't specify an order for the matched names; compare sorted.
  expect([...thrown.matchedResourceTypes].sort()).to.deep.equal(
    [...expected.matchedResourceTypes].sort(),
  );
  return thrown;
};

describe("resource-type classification (§6.1, §6.2)", () => {
  describe("classify()", () => {
    it("returns the unique matching resource-type name and exposes the instance name", async () => {
      const name = uniqueCacheName("classify-basic");
      const cache = new Cache(memoryStoreFor(twoTypeRegistry), {
        name,
        resourceTypes: twoTypeRegistry,
      });
      try {
        expect(cache.name).to.equal(name);
        expect(cache.classify("site:2026-07-28")).to.equal("site_day");
        expect(cache.classify("biz:b1")).to.equal("business_slice");
      } finally {
        await cache.close();
      }
    });

    it("throws UnclassifiableIdError (with cacheName and id) when no guard matches", async () => {
      const name = uniqueCacheName("classify-none");
      const cache = new Cache(memoryStoreFor(twoTypeRegistry), {
        name,
        resourceTypes: twoTypeRegistry,
      });
      try {
        assertUnclassifiable(
          expectSyncThrow(() => cache.classify("unknown:1")),
          { cacheName: name, id: "unknown:1" },
        );
      } finally {
        await cache.close();
      }
    });

    it("throws AmbiguousResourceTypeError when >1 guard matches, even though a first-match-wins scan would have succeeded", async () => {
      const name = uniqueCacheName("classify-ambiguous");
      const cache = new Cache(memoryStoreFor(overlappingRegistry), {
        name,
        resourceTypes: overlappingRegistry,
      });
      try {
        // "site:special:1" is matched by site_day (listed first) too, so this
        // throwing proves classification evaluates EVERY guard rather than
        // resolving the overlap silently by object-key order (§6.1).
        assertAmbiguous(
          expectSyncThrow(() => cache.classify("site:special:1")),
          {
            cacheName: name,
            id: "site:special:1",
            matchedResourceTypes: ["site_day", "site_special"],
          },
        );

        // Ids matched by only one of the overlapping guards still classify.
        expect(cache.classify("site:plain")).to.equal("site_day");
      } finally {
        await cache.close();
      }
    });
  });

  describe("get / getMany / delete reject on classification failure, before touching the store", () => {
    it("get: rejects with UnclassifiableIdError; the store is never read; no read message is published", async () => {
      const name = uniqueCacheName("get-unclassifiable");
      const store = memoryStoreFor(twoTypeRegistry);
      const getSpy = mock.method(store, "get");
      const getManySpy = mock.method(store, "getMany");
      const cache = new Cache(store, {
        name,
        resourceTypes: twoTypeRegistry,
      });
      const capture = captureChannels(name);
      try {
        const thrown = await expectRejection(() =>
          cache.get({
            // Loosely-typed id: the compiler bans typed unclassifiable ids,
            // so the runtime check is the net for string-munged ones.
            id: "unknown:1" as string as `site:${string}`,
            params: {},
            directives: {},
          }),
        );
        assertUnclassifiable(thrown, { cacheName: name, id: "unknown:1" });
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(getManySpy.mock.callCount()).to.equal(0);
        // No lookup happened, so nothing to report on the read channel.
        expect(capture.read).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("get: rejects with AmbiguousResourceTypeError (with the matched type names)", async () => {
      const name = uniqueCacheName("get-ambiguous");
      const cache = new Cache(memoryStoreFor(overlappingRegistry), {
        name,
        resourceTypes: overlappingRegistry,
      });
      try {
        const thrown = await expectRejection(() =>
          cache.get({ id: "site:special:9", params: {}, directives: {} }),
        );
        assertAmbiguous(thrown, {
          cacheName: name,
          id: "site:special:9",
          matchedResourceTypes: ["site_day", "site_special"],
        });
      } finally {
        await cache.close();
      }
    });

    it("getMany: one bad id rejects the whole operation before the store is read", async () => {
      const name = uniqueCacheName("getmany-unclassifiable");
      const store = memoryStoreFor(twoTypeRegistry);
      const getSpy = mock.method(store, "get");
      const getManySpy = mock.method(store, "getMany");
      const cache = new Cache(store, {
        name,
        resourceTypes: twoTypeRegistry,
      });
      const capture = captureChannels(name);
      try {
        const thrown = await expectRejection(() =>
          cache.getMany([
            { id: "site:good", params: {}, directives: {} },
            {
              id: "nope" as string as `site:${string}`,
              params: {},
              directives: {},
            },
          ]),
        );
        assertUnclassifiable(thrown, { cacheName: name, id: "nope" });
        expect(getManySpy.mock.callCount()).to.equal(0);
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(capture.read).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("delete: rejects with UnclassifiableIdError before the store's delete is called", async () => {
      const name = uniqueCacheName("delete-unclassifiable");
      const store = memoryStoreFor(twoTypeRegistry);
      const deleteSpy = mock.method(store, "delete");
      const cache = new Cache(store, {
        name,
        resourceTypes: twoTypeRegistry,
      });
      try {
        const thrown = await expectRejection(() =>
          cache.delete("nope" as string as `site:${string}`),
        );
        assertUnclassifiable(thrown, { cacheName: name, id: "nope" });
        expect(deleteSpy.mock.callCount()).to.equal(0);

        // Classifiable deletes still work.
        await cache.delete("site:whatever");
        expect(deleteSpy.mock.callCount()).to.equal(1);
      } finally {
        await cache.close();
      }
    });
  });

  describe("store() classification (primary and supplemental entry ids)", () => {
    it("rejects a batch containing an unclassifiable id up front: nothing persists, no store-entry messages", async () => {
      const name = uniqueCacheName("store-unclassifiable");
      const store = memoryStoreFor(twoTypeRegistry);
      const storeSpy = mock.method(store, "store");
      const cache = new Cache(store, {
        name,
        resourceTypes: twoTypeRegistry,
      });
      const capture = captureChannels(name);
      try {
        const thrown = await expectRejection(() =>
          cache.store([
            { id: "site:good", content: "good", directives: freshFor100 },
            {
              // Loosely-typed id (the compiler bans typed ones): the runtime
              // classification is exactly the net that catches this.
              id: "bogus:oops" as string as `site:${string}`,
              content: "bad",
              directives: freshFor100,
            },
          ]),
        );
        assertUnclassifiable(thrown, { cacheName: name, id: "bogus:oops" });

        // Rejected BEFORE anything was persisted -- including the valid
        // entry that preceded the bad one in the batch.
        expect(storeSpy.mock.callCount()).to.equal(0);
        expect(capture.storeEntry).to.deep.equal([]);
        const lookup = await cache.get({
          id: "site:good",
          params: {},
          directives: {},
        });
        expect(lookup.usable).to.equal(undefined);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("rejects ambiguous entry ids with AmbiguousResourceTypeError", async () => {
      const name = uniqueCacheName("store-ambiguous");
      const store = memoryStoreFor(overlappingRegistry);
      const storeSpy = mock.method(store, "store");
      const cache = new Cache(store, {
        name,
        resourceTypes: overlappingRegistry,
      });
      try {
        const thrown = await expectRejection(() =>
          cache.store([
            {
              id: "site:special:1",
              content: "ambiguous",
              directives: freshFor100,
            },
          ]),
        );
        assertAmbiguous(thrown, {
          cacheName: name,
          id: "site:special:1",
          matchedResourceTypes: ["site_day", "site_special"],
        });
        expect(storeSpy.mock.callCount()).to.equal(0);
      } finally {
        await cache.close();
      }
    });

    it("a producer-minted unclassifiable SUPPLEMENTAL id rejects the whole store: nothing (not even the primary) persists (§7's typo'd-slice-id bug)", async () => {
      const name = uniqueCacheName("store-supplemental");
      const store = memoryStoreFor(twoTypeRegistry);
      const storeSpy = mock.method(store, "store");
      const cache = new Cache(store, {
        name,
        resourceTypes: twoTypeRegistry,
      });
      const capture = captureChannels(name);
      const producer = mock.fn(async () => ({
        content: "site-content",
        directives: freshFor100,
        supplementalResources: [
          {
            id: "biz:ok" as const,
            content: "slice-content",
            directives: freshFor100,
          },
          {
            // The typo'd shape: built by string munging, so only loosely
            // typed -- this is the "orphaned supplemental write" the runtime
            // check exists to catch. In 1.6.0 this wrote a permanently
            // unreadable row; in 2.0 the whole store call is rejected.
            id: "bogus-slice-shape" as string as `biz:${string}`,
            content: "slice-content",
            directives: freshFor100,
          },
        ],
      }));
      const getSite = wrapProducer(cache, {}, { site_day: producer });
      try {
        // The producer result still reaches the caller; whether the wrapped
        // call itself surfaces the (asynchronous) store failure is not
        // specified by the doc, so accept either settlement.
        await getSite({ id: "site:2026-07-28" }).catch(() => undefined);
        expect(producer.mock.callCount()).to.equal(1);

        // Give the (possibly fire-and-forget) store attempt time to run,
        // then confirm classification rejected it before anything persisted.
        await delay(25);
        expect(storeSpy.mock.callCount()).to.equal(0);
        expect(capture.storeEntry).to.deep.equal([]);

        const primary = await cache.get({
          id: "site:2026-07-28",
          params: {},
          directives: {},
        });
        expect(primary.usable).to.equal(undefined);
        const supplemental = await cache.get({
          id: "biz:ok",
          params: {},
          directives: {},
        });
        expect(supplemental.usable).to.equal(undefined);
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("classification fuzzing over adversarial ids", () => {
    it("prefix-partitioned registry: exactly-one-match holds for every id, including Object.prototype-colliding ones", async () => {
      const name = uniqueCacheName("fuzz-prefixes");
      const cache = new Cache(memoryStoreFor(twoTypeRegistry), {
        name,
        resourceTypes: twoTypeRegistry,
      });
      try {
        fc.assert(
          fc.property(AdversarialIdArb, (id) => {
            if (id.startsWith("site:")) {
              expect(cache.classify(id)).to.equal("site_day");
            } else if (id.startsWith("biz:")) {
              expect(cache.classify(id)).to.equal("business_slice");
            } else {
              assertUnclassifiable(
                expectSyncThrow(() => cache.classify(id)),
                { cacheName: name, id },
              );
            }
          }),
        );
      } finally {
        await cache.close();
      }
    });

    it("registry whose type NAMES collide with Object.prototype members still classifies correctly", async () => {
      // Defined via computed keys so "__proto__" becomes an own property of
      // the registry object rather than mutating its prototype (the same
      // hazard the vary-matching suite covers for param names).
      const protoNamedRegistry = {
        ["__proto__"]: resourceType<string>()({ matches: idStartsWith("p:") }),
        ["constructor"]: resourceType<string>()({
          matches: idStartsWith("c:"),
        }),
        ["toString"]: resourceType<string>()({ matches: idStartsWith("t:") }),
      } satisfies ResourceTypes;
      const name = uniqueCacheName("fuzz-proto-names");
      const cache = new Cache(memoryStoreFor(protoNamedRegistry), {
        name,
        resourceTypes: protoNamedRegistry,
      });
      try {
        fc.assert(
          fc.property(
            fc.oneof(ObjectPrototypeCollisionKeyArb, fc.string()),
            (suffix) => {
              expect(cache.classify(`p:${suffix}`)).to.equal("__proto__");
              expect(cache.classify(`c:${suffix}`)).to.equal("constructor");
              expect(cache.classify(`t:${suffix}`)).to.equal("toString");
            },
          ),
        );
        // A bare prototype-member name matches no guard: the error payload
        // must report it as unclassifiable (not resolve it up the prototype
        // chain of some internal lookup object).
        assertUnclassifiable(
          expectSyncThrow(() => cache.classify("hasOwnProperty")),
          { cacheName: name, id: "hasOwnProperty" },
        );
      } finally {
        await cache.close();
      }
    });

    it("AmbiguousResourceTypeError.matchedResourceTypes reports prototype-colliding type names faithfully", async () => {
      const overlappingProtoRegistry = {
        ["__proto__"]: resourceType<string>()({ matches: idStartsWith("x:") }),
        ["constructor"]: resourceType<string>()({
          matches: idStartsWith("x:"),
        }),
      } satisfies ResourceTypes;
      const name = uniqueCacheName("fuzz-proto-ambiguous");
      const cache = new Cache(memoryStoreFor(overlappingProtoRegistry), {
        name,
        resourceTypes: overlappingProtoRegistry,
      });
      try {
        assertAmbiguous(
          expectSyncThrow(() => cache.classify("x:1")),
          {
            cacheName: name,
            id: "x:1",
            matchedResourceTypes: ["__proto__", "constructor"],
          },
        );
      } finally {
        await cache.close();
      }
    });

    it("stores and serves entries whose ids are Object.prototype member names", async () => {
      const name = uniqueCacheName("fuzz-proto-ids-roundtrip");
      const cache = new Cache(memoryStoreFor(soleAnythingRegistry), {
        name,
        resourceTypes: soleAnythingRegistry,
      });
      try {
        await cache.store([
          { id: "__proto__", content: "proto-content", directives: freshFor100 },
          { id: "toString", content: "tostring-content", directives: freshFor100 },
        ]);
        const [protoRes, toStringRes] = await cache.getMany([
          { id: "__proto__", params: {}, directives: {} },
          { id: "toString", params: {}, directives: {} },
        ]);
        expect(protoRes.usable?.content).to.equal("proto-content");
        expect(toStringRes.usable?.content).to.equal("tostring-content");
      } finally {
        await cache.close();
      }
    });
  });

  describe("soleResourceType registries: classification never fails (§6.1)", () => {
    it("classifies every string -- however adversarial -- to the sole type", async () => {
      const name = uniqueCacheName("sole-classify");
      const cache = new Cache(memoryStoreFor(soleVisitsRegistry), {
        name,
        resourceTypes: soleVisitsRegistry,
      });
      try {
        fc.assert(
          fc.property(AdversarialIdArb, (id) => {
            expect(cache.classify(id)).to.equal("visits");
          }),
        );
      } finally {
        await cache.close();
      }
    });

    it("get/store/delete accept every id on a sole-type cache (no runtime enforcement, matching 1.6.0)", async () => {
      const name = uniqueCacheName("sole-ops");
      const cache = new Cache(memoryStoreFor(soleVisitsRegistry), {
        name,
        resourceTypes: soleVisitsRegistry,
      });
      try {
        await fc.assert(
          fc.asyncProperty(AdversarialIdArb, async (id) => {
            const lookup = await cache.get({ id, params: {}, directives: {} });
            expect(lookup.validatable).to.deep.equal([]);
            await cache.delete(id);
          }),
          { numRuns: 25 },
        );

        await cache.store([
          { id: "", content: "empty-id-content", directives: freshFor100 },
        ]);
        const emptyIdLookup = await cache.get({
          id: "",
          params: {},
          directives: {},
        });
        expect(emptyIdLookup.usable?.content).to.equal("empty-id-content");
      } finally {
        await cache.close();
      }
    });
  });
});
