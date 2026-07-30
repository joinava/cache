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
  MemoryStore,
  producerByIdType,
  resourceType,
  singleTypeCacheOptions,
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
  site_special: resourceType<string>()({
    matches: idStartsWith("site:special:"),
  }),
} satisfies ResourceTypes;

const soleVisitsRegistry = {
  visits: resourceType<string>()({
    matches: (id): id is string => typeof id === "string",
  }),
} satisfies ResourceTypes;

const soleAnythingRegistry = {
  anything: resourceType<string>()({
    matches: (id): id is string => typeof id === "string",
  }),
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
      const cache = new Cache({
        store: memoryStoreFor(twoTypeRegistry),
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
      const cache = new Cache({
        store: memoryStoreFor(twoTypeRegistry),
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
      const cache = new Cache({
        store: memoryStoreFor(overlappingRegistry),
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

  describe("throwing guards (§6.1: a guard that throws is a non-match)", () => {
    // The §6.1 authoring idiom: guards that parse the id and so THROW on any
    // id that isn't theirs. A malformed (non-JSON) id must surface as
    // UnclassifiableIdError -- with the parse failure(s) as `cause` -- not
    // leak as a bare SyntaxError with no cache/id attribution (§7's
    // malformed-minted-id simulation).
    const jsonRegistry = {
      site_day: resourceType<string>()({
        matches: (id): id is string =>
          !("businessId" in (JSON.parse(id) as object)),
      }),
      business_slice: resourceType<string>()({
        matches: (id): id is string =>
          "businessId" in (JSON.parse(id) as object),
      }),
    } satisfies ResourceTypes;

    it("a malformed id with jsonParse-style guards throws UnclassifiableIdError carrying the guard errors as cause", async () => {
      const name = uniqueCacheName("classify-guard-throw");
      const cache = new Cache({
        store: memoryStoreFor(jsonRegistry),
        name,
        resourceTypes: jsonRegistry,
      });
      try {
        const thrown = assertUnclassifiable(
          expectSyncThrow(() => cache.classify("site:oops-not-json")),
          { cacheName: name, id: "site:oops-not-json" },
        );
        // Both guards threw, so the cause aggregates both parse errors.
        const cause = thrown.cause;
        if (!(cause instanceof AggregateError)) {
          throw new Error(
            `expected an AggregateError cause, got: ${String(cause)}`,
          );
        }
        const errors: readonly unknown[] = cause.errors;
        expect(errors).to.have.lengthOf(2);
        errors.forEach((e) => expect(e).to.be.instanceOf(SyntaxError));

        // The same protection through store(): a producer minting a
        // malformed id rejects before persisting (§7), attributably.
        assertUnclassifiable(
          await expectRejection(() =>
            cache.store([
              {
                id: "definitely-not-json",
                content: "x",
                directives: freshFor100,
              },
            ]),
          ),
          { cacheName: name, id: "definitely-not-json" },
        );
      } finally {
        await cache.close();
      }
    });

    it("a guard that throws is a non-match, not a veto: another guard matching cleanly still classifies", async () => {
      const name = uniqueCacheName("classify-guard-throw-mixed");
      // One parsing guard (throws on non-JSON ids) + one prefix guard.
      const mixedRegistry = {
        json_thing: resourceType<string>()({
          matches: (id): id is string => "j" in (JSON.parse(id) as object),
        }),
        site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
      } satisfies ResourceTypes;
      const cache = new Cache({
        store: memoryStoreFor(mixedRegistry),
        name,
        resourceTypes: mixedRegistry,
      });
      try {
        expect(cache.classify("site:1")).to.equal("site_day");

        // When the throwing guard is the only thrower and nothing matches,
        // the single error is the cause directly (no AggregateError).
        const thrown = assertUnclassifiable(
          expectSyncThrow(() => cache.classify("nope")),
          { cacheName: name, id: "nope" },
        );
        expect(thrown.cause).to.be.instanceOf(SyntaxError);
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
      const cache = new Cache({
        store: store,
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
      const cache = new Cache({
        store: memoryStoreFor(overlappingRegistry),
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
      const cache = new Cache({
        store: store,
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
      const cache = new Cache({
        store: store,
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

  describe("classification failures through the wrappers", () => {
    it("an unclassifiable request id rejects the wrapped call pre-dispatch: no read, no fetch, no produce", async () => {
      // Pre-dispatch validation failures
      // (UnclassifiableIdError / AmbiguousResourceTypeError /
      // NoProducerForResourceTypeError) throw before any disposition exists,
      // so -- like the failed-read "throw" path -- they emit NO fetch message.
      const name = uniqueCacheName("wrapper-unclassifiable");
      const store = memoryStoreFor(twoTypeRegistry);
      const getSpy = mock.method(store, "get");
      const cache = new Cache({
        store: store,
        name,
        resourceTypes: twoTypeRegistry,
      });
      const capture = captureChannels(name);
      const producer = mock.fn(async (req: { readonly id: string }) => ({
        content: `content-${req.id}`,
        directives: freshFor100,
      }));
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache.resourceTypes, { site_day: producer }),
      );
      try {
        const thrown = await expectRejection(() =>
          getSite({ id: "unknown:1" as string as `site:${string}` }),
        );
        assertUnclassifiable(thrown, { cacheName: name, id: "unknown:1" });
        expect(producer.mock.callCount()).to.equal(0);
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(capture.read).to.deep.equal([]);
        expect(capture.fetch).to.deep.equal([]);
        expect(capture.produce).to.deep.equal([]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("classification runs before the closed check (§6.2 ordering)", () => {
    it("a closed cache still rejects unclassifiable ids with UnclassifiableIdError, not the closed error", async () => {
      const name = uniqueCacheName("closed-ordering");
      const cache = new Cache({
        store: memoryStoreFor(twoTypeRegistry),
        name,
        resourceTypes: twoTypeRegistry,
        onGetAfterClose: "act-empty",
      });
      await cache.close();
      const thrown = await expectRejection(() =>
        cache.get({
          id: "unknown:1" as string as `site:${string}`,
          params: {},
          directives: {},
        }),
      );
      assertUnclassifiable(thrown, { cacheName: name, id: "unknown:1" });

      // A classifiable id on the same closed cache acts empty, per its option.
      const res = await cache.get({
        id: "site:fine",
        params: {},
        directives: {},
      });
      expect(res.usable).to.equal(undefined);
      expect(res.validatable).to.deep.equal([]);
    });
  });

  describe("store() classification (primary and supplemental entry ids)", () => {
    it("rejects a batch containing an unclassifiable id up front: nothing persists, no store-entry messages", async () => {
      const name = uniqueCacheName("store-unclassifiable");
      const store = memoryStoreFor(twoTypeRegistry);
      const storeSpy = mock.method(store, "store");
      const cache = new Cache({
        store: store,
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
      const cache = new Cache({
        store: store,
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
      const cache = new Cache({
        store: store,
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
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache.resourceTypes, { site_day: producer }),
      );
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
      const cache = new Cache({
        store: memoryStoreFor(twoTypeRegistry),
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
      const cache = new Cache({
        store: memoryStoreFor(protoNamedRegistry),
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
      const cache = new Cache({
        store: memoryStoreFor(overlappingProtoRegistry),
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
      const cache = new Cache({
        store: memoryStoreFor(soleAnythingRegistry),
        name,
        resourceTypes: soleAnythingRegistry,
      });
      try {
        await cache.store([
          {
            id: "__proto__",
            content: "proto-content",
            directives: freshFor100,
          },
          {
            id: "toString",
            content: "tostring-content",
            directives: freshFor100,
          },
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

  describe("accept-everything registries: classification never fails (§6.1)", () => {
    it("classifies every string -- however adversarial -- to the sole type", async () => {
      const name = uniqueCacheName("sole-classify");
      const cache = new Cache({
        store: memoryStoreFor(soleVisitsRegistry),
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
      const cache = new Cache({
        store: memoryStoreFor(soleVisitsRegistry),
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

describe("singleTypeCacheOptions", () => {
  const freshFor10 = { freshUntilAge: 10 };

  it("names the sole resource type after the cache, and reports that name on the diagnostics channels", async () => {
    const name = uniqueCacheName("sole-default-name");
    const capture = captureChannels(name);
    const cache = new Cache(
      singleTypeCacheOptions<string>()({ store: new MemoryStore(), name }),
    );
    try {
      const fetch = wrapProducer(cache, {}, async (req) => ({
        content: `v-${req.id}`,
        directives: freshFor10,
      }));

      expect((await fetch({ id: "anything at all" })).content).to.equal(
        "v-anything at all",
      );

      // The point of the default: the caller never named the type, and the name
      // that reaches telemetry is the cache's own rather than a shared literal
      // that would collapse every sole-type cache into one bucket.
      expect(cache.classify("anything at all")).to.equal(name);
      expect(capture.fetch.map((m) => m.resourceType)).to.deep.equal([name]);
      expect(capture.read.map((m) => m.resourceType)).to.deep.equal([name]);
    } finally {
      capture.stop();
      await cache.close();
    }
  });

  it("uses `resourceTypeName` when given, without affecting the cache's own name", async () => {
    const name = uniqueCacheName("sole-named");
    const capture = captureChannels(name);
    const cache = new Cache(
      singleTypeCacheOptions<string>()({
        store: new MemoryStore(),
        name,
        resourceTypeName: "visits",
      }),
    );
    try {
      const fetch = wrapProducer(cache, {}, async (req) => ({
        content: `v-${req.id}`,
        directives: freshFor10,
      }));
      await fetch({ id: "whatever" });

      expect(cache.name).to.equal(name);
      expect(cache.classify("whatever")).to.equal("visits");
      expect(capture.fetch.map((m) => m.resourceType)).to.deep.equal([
        "visits",
      ]);
    } finally {
      capture.stop();
      await cache.close();
    }
  });

  it("classifies every id, since its sole type's guard accepts all of them", async () => {
    const cache = new Cache(
      singleTypeCacheOptions<string>()({
        store: new MemoryStore(),
        name: uniqueCacheName("sole-accepts-all"),
        resourceTypeName: "entries",
      }),
    );
    try {
      fc.assert(
        fc.property(fc.string(), (id) => {
          expect(cache.classify(id)).to.equal("entries");
        }),
        { numRuns: 50 },
      );
    } finally {
      await cache.close();
    }
  });

  it("passes other CacheOptions through (spreadable, and `onGetAfterClose` still governs)", async () => {
    const cache = new Cache({
      ...singleTypeCacheOptions<string>()({
        store: new MemoryStore(),
        name: uniqueCacheName("sole-spread"),
      }),
      onGetAfterClose: "act-empty",
    });
    await cache.close();

    // "act-empty" (rather than the default "throw") survived the spread.
    expect(
      await cache.get({ id: "anything", params: {}, directives: {} }),
    ).to.deep.equal({ validatable: [] });
  });
});

describe("a one-entry registry with a real guard rejects nonconforming ids", () => {
  // The counterpart to singleTypeCacheOptions: narrowing a sole type's id space
  // is done with a REAL guard now, since the old sole-resource-type sugar's
  // asserted narrowing was unsound -- its guard accepted every string, so a
  // malformed id classified happily and was stored under a spec whose type said
  // it could not exist. Here the guard actually runs.
  const guardedRegistry = {
    tickets: resourceType<string>()({ matches: idStartsWith("ticket:") }),
  } satisfies ResourceTypes;

  it("throws UnclassifiableIdError before the store is touched, while the sugar's accept-everything form does not", async () => {
    const store = memoryStoreFor(guardedRegistry);
    const getSpy = mock.method(store, "get");
    const name = uniqueCacheName("sole-guarded");
    const capture = captureChannels(name);
    const cache = new Cache({ store, name, resourceTypes: guardedRegistry });
    try {
      const fetch = wrapProducer(cache, {}, async (req) => ({
        content: `v-${req.id}`,
        directives: freshFor100,
      }));

      // The conforming id works end to end...
      expect((await fetch({ id: "ticket:1" })).content).to.equal("v-ticket:1");
      const readsAfterGoodId = getSpy.mock.callCount();
      expect(readsAfterGoodId).to.be.greaterThan(0);
      const messagesAfterGoodId = capture.all.length;

      // ...and a nonconforming one is REJECTED. A cast is how such an id gets
      // this far at all; the compiler rejects it at the call site.
      assertUnclassifiable(
        await expectRejection(
          fetch({ id: "not-a-ticket" as `ticket:${string}` }),
        ),
        { cacheName: name, id: "not-a-ticket" },
      );

      // Rejected BEFORE the store was touched, and nothing was published:
      // an unclassifiable id can't be attributed to a resource type, so there
      // is no message to emit.
      expect(getSpy.mock.callCount()).to.equal(readsAfterGoodId);
      expect(capture.all.length).to.equal(messagesAfterGoodId);
    } finally {
      capture.stop();
      await cache.close();
    }
  });
});
