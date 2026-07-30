import { expect } from "chai";
import fc from "fast-check";
import assert from "node:assert/strict";
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
  uniqueCacheName,
  type ChannelCapture,
  TWO_TYPE_REGISTRY,
  ACCEPT_ANY_REGISTRY,
  freshFor100,
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
  type SpecOf,
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

// Overlapping guards: every `site:special:*` id matches BOTH types. Note that
// the guard listed first still matches, so a first-match-wins classifier
// would silently return "site_day" here instead of failing loud.
const overlappingRegistry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  site_special: resourceType<string>()({
    matches: idStartsWith("site:special:"),
  }),
} satisfies ResourceTypes;

const assertUnclassifiable = (
  thrown: unknown,
  expected: { cacheName: string; id: string },
): UnclassifiableIdError => {
  assert.ok(thrown instanceof UnclassifiableIdError);
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
  assert.ok(thrown instanceof AmbiguousResourceTypeError);
  expect(thrown.name).to.equal("AmbiguousResourceTypeError");
  expect(thrown.cacheName).to.equal(expected.cacheName);
  expect(thrown.id).to.equal(expected.id);
  // The doc doesn't specify an order for the matched names; compare sorted.
  expect(thrown.matchedResourceTypes.toSorted()).to.deep.equal(
    expected.matchedResourceTypes.toSorted(),
  );
  return thrown;
};

/**
 * Runs `body` against a uniquely-named cache over a MemoryStore pinned to
 * `resourceTypes`, closing it afterwards. Every test here needs the same three
 * things -- the cache, its `name` (which the errors are asserted to carry), and
 * sometimes the store (to spy on) -- so passing them in leaves each test body
 * as nothing but the classification behavior it is pinning.
 *
 * `resourceTypes` stays generic despite the note in v2AcceptanceHelpers.ts: the
 * cast that note warns about is only needed when the STORE is supplied
 * separately, since `CacheOptions.store`'s store-covers-registry conditional
 * then can't resolve. Deriving the store here from the same `RT` keeps both
 * sides of that conditional in step.
 */
const withCache = async <RT extends ResourceTypes, T>(
  label: string,
  resourceTypes: RT,
  body: (harness: {
    name: string;
    store: MemoryStore<SpecOf<RT>>;
    cache: Cache<RT>;
  }) => Promise<T>,
): Promise<T> => {
  const name = uniqueCacheName(label);
  // The explicit type argument is load-bearing HERE and only here: under an
  // unresolved `RT`, a bare `new MemoryStore()` infers the wide default
  // `CacheSpec`, which is not assignable to the `MemoryStore<SpecOf<RT>>` the
  // harness hands to `body`. At every concrete-registry site the bare form
  // infers correctly on its own.
  const store = new MemoryStore<SpecOf<RT>>();
  const cache = new Cache({ store, name, resourceTypes });
  try {
    return await body({ name, store, cache });
  } finally {
    await cache.close();
  }
};

/**
 * {@link withCache} plus a diagnostics-channel capture for that cache, stopped
 * before the cache closes. Separate from `withCache` rather than folded into it
 * because subscribing is not free of consequence: the publishers are
 * `hasSubscribers`-gated, so an always-on capture would mean nothing here ever
 * exercised the unsubscribed path.
 */
const withCaptureAndCache = async <RT extends ResourceTypes, T>(
  label: string,
  resourceTypes: RT,
  body: (harness: {
    name: string;
    store: MemoryStore<SpecOf<RT>>;
    cache: Cache<RT>;
    capture: ChannelCapture;
  }) => Promise<T>,
): Promise<T> =>
  withCache(label, resourceTypes, async ({ name, store, cache }) => {
    const capture = captureChannels(name);
    try {
      return await body({ name, store, cache, capture });
    } finally {
      capture.stop();
    }
  });

describe("resource-type classification (§6.1, §6.2)", () => {
  describe("classify()", () => {
    it("returns the unique matching resource-type name and exposes the instance name", async () =>
      withCache(
        "classify-basic",
        TWO_TYPE_REGISTRY,
        async ({ name, cache }) => {
          expect(cache.name).to.equal(name);
          expect(cache.classify("site:2026-07-28")).to.equal("site_day");
          expect(cache.classify("biz:b1")).to.equal("business_slice");
        },
      ));

    it("throws UnclassifiableIdError (with cacheName and id) when no guard matches", async () =>
      withCache("classify-none", TWO_TYPE_REGISTRY, async ({ name, cache }) => {
        assertUnclassifiable(
          expectSyncThrow(() => cache.classify("unknown:1")),
          { cacheName: name, id: "unknown:1" },
        );
      }));

    it("throws AmbiguousResourceTypeError when >1 guard matches, even though a first-match-wins scan would have succeeded", async () =>
      withCache(
        "classify-ambiguous",
        overlappingRegistry,
        async ({ name, cache }) => {
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
        },
      ));
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

    it("a malformed id with jsonParse-style guards throws UnclassifiableIdError carrying the guard errors as cause", async () =>
      withCache(
        "classify-guard-throw",
        jsonRegistry,
        async ({ name, cache }) => {
          const thrown = assertUnclassifiable(
            expectSyncThrow(() => cache.classify("site:oops-not-json")),
            { cacheName: name, id: "site:oops-not-json" },
          );
          // Both guards threw, so the cause aggregates both parse errors.
          const cause = thrown.cause;
          assert.ok(cause instanceof AggregateError);
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
        },
      ));

    // One parsing guard (throws on non-JSON ids) + one prefix guard.
    const mixedRegistry = {
      json_thing: resourceType<string>()({
        matches: (id): id is string => "j" in (JSON.parse(id) as object),
      }),
      site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
    } satisfies ResourceTypes;

    it("a guard that throws is a non-match, not a veto: another guard matching cleanly still classifies", async () =>
      withCache(
        "classify-guard-throw-mixed",
        mixedRegistry,
        async ({ name, cache }) => {
          expect(cache.classify("site:1")).to.equal("site_day");

          // When the throwing guard is the only thrower and nothing matches,
          // the single error is the cause directly (no AggregateError).
          const thrown = assertUnclassifiable(
            expectSyncThrow(() => cache.classify("nope")),
            { cacheName: name, id: "nope" },
          );
          expect(thrown.cause).to.be.instanceOf(SyntaxError);
        },
      ));
  });

  describe("get / getMany / delete reject on classification failure, before touching the store", () => {
    it("get: rejects with UnclassifiableIdError; the store is never read; no read message is published", async () =>
      withCaptureAndCache(
        "get-unclassifiable",
        TWO_TYPE_REGISTRY,
        async ({ name, store, cache, capture }) => {
          const getSpy = mock.method(store, "get");
          const getManySpy = mock.method(store, "getMany");
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
        },
      ));

    it("get: rejects with AmbiguousResourceTypeError (with the matched type names)", async () =>
      withCache(
        "get-ambiguous",
        overlappingRegistry,
        async ({ name, cache }) => {
          const thrown = await expectRejection(() =>
            cache.get({ id: "site:special:9", params: {}, directives: {} }),
          );
          assertAmbiguous(thrown, {
            cacheName: name,
            id: "site:special:9",
            matchedResourceTypes: ["site_day", "site_special"],
          });
        },
      ));

    it("getMany: one bad id rejects the whole operation before the store is read", async () =>
      withCaptureAndCache(
        "getmany-unclassifiable",
        TWO_TYPE_REGISTRY,
        async ({ name, store, cache, capture }) => {
          const getSpy = mock.method(store, "get");
          const getManySpy = mock.method(store, "getMany");
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
        },
      ));

    it("delete: rejects with UnclassifiableIdError before the store's delete is called", async () =>
      withCache(
        "delete-unclassifiable",
        TWO_TYPE_REGISTRY,
        async ({ name, store, cache }) => {
          const deleteSpy = mock.method(store, "delete");
          const thrown = await expectRejection(() =>
            cache.delete("nope" as string as `site:${string}`),
          );
          assertUnclassifiable(thrown, { cacheName: name, id: "nope" });
          expect(deleteSpy.mock.callCount()).to.equal(0);

          // Classifiable deletes still work.
          await cache.delete("site:whatever");
          expect(deleteSpy.mock.callCount()).to.equal(1);
        },
      ));
  });

  describe("classification failures through the wrappers", () => {
    it("an unclassifiable request id rejects the wrapped call pre-dispatch: no read, no fetch, no produce", async () =>
      withCaptureAndCache(
        "wrapper-unclassifiable",
        TWO_TYPE_REGISTRY,
        async ({ name, store, cache, capture }) => {
          // Pre-dispatch validation failures
          // (UnclassifiableIdError / AmbiguousResourceTypeError /
          // NoProducerForResourceTypeError) throw before any disposition exists,
          // so -- like the failed-read "throw" path -- they emit NO fetch message.
          const getSpy = mock.method(store, "get");
          const producer = mock.fn(async (req: { readonly id: string }) => ({
            content: `content-${req.id}`,
            directives: freshFor100,
          }));
          const getSite = wrapProducer(
            cache,
            {},
            producerByIdType(cache.resourceTypes, { site_day: producer }),
          );
          const thrown = await expectRejection(() =>
            getSite({ id: "unknown:1" as string as `site:${string}` }),
          );
          assertUnclassifiable(thrown, { cacheName: name, id: "unknown:1" });
          expect(producer.mock.callCount()).to.equal(0);
          expect(getSpy.mock.callCount()).to.equal(0);
          expect(capture.read).to.deep.equal([]);
          expect(capture.fetch).to.deep.equal([]);
          expect(capture.produce).to.deep.equal([]);
        },
      ));
  });

  describe("classification runs before the closed check (§6.2 ordering)", () => {
    // Constructed explicitly rather than through `withCache`: the whole test
    // turns on `onGetAfterClose`, so which cache option is in force has to be
    // readable here.
    it("a closed cache still rejects unclassifiable ids with UnclassifiableIdError, not the closed error", async () => {
      const name = uniqueCacheName("closed-ordering");
      const cache = new Cache({
        store: new MemoryStore(),
        name,
        resourceTypes: TWO_TYPE_REGISTRY,
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
    it("rejects a batch containing an unclassifiable id up front: nothing persists, no store-entry messages", async () =>
      withCaptureAndCache(
        "store-unclassifiable",
        TWO_TYPE_REGISTRY,
        async ({ name, store, cache, capture }) => {
          const storeSpy = mock.method(store, "store");
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
        },
      ));

    it("rejects ambiguous entry ids with AmbiguousResourceTypeError", async () =>
      withCache(
        "store-ambiguous",
        overlappingRegistry,
        async ({ name, store, cache }) => {
          const storeSpy = mock.method(store, "store");
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
        },
      ));

    it("a producer-minted unclassifiable SUPPLEMENTAL id rejects the whole store: nothing (not even the primary) persists (§7's typo'd-slice-id bug)", async () =>
      withCaptureAndCache(
        "store-supplemental",
        TWO_TYPE_REGISTRY,
        async ({ store, cache, capture }) => {
          const storeSpy = mock.method(store, "store");
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
                // check exists to catch. Unclassifiable, so the whole store call
                // is rejected rather than persisting a permanently unreadable row.
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
        },
      ));
  });

  describe("classification fuzzing over adversarial ids", () => {
    it("prefix-partitioned registry: exactly-one-match holds for every id, including Object.prototype-colliding ones", async () =>
      withCache("fuzz-prefixes", TWO_TYPE_REGISTRY, async ({ name, cache }) => {
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
      }));

    const protoNamedRegistry = {
      ["__proto__"]: resourceType<string>()({ matches: idStartsWith("p:") }),
      ["constructor"]: resourceType<string>()({
        matches: idStartsWith("c:"),
      }),
      ["toString"]: resourceType<string>()({ matches: idStartsWith("t:") }),
    } satisfies ResourceTypes;

    it("registry whose type NAMES collide with Object.prototype members still classifies correctly", async () =>
      withCache(
        "fuzz-proto-names",
        protoNamedRegistry,
        async ({ name, cache }) => {
          // Defined via computed keys so "__proto__" becomes an own property of
          // the registry object rather than mutating its prototype (the same
          // hazard the vary-matching suite covers for param names).
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
        },
      ));

    const overlappingProtoRegistry = {
      ["__proto__"]: resourceType<string>()({ matches: idStartsWith("x:") }),
      ["constructor"]: resourceType<string>()({
        matches: idStartsWith("x:"),
      }),
    } satisfies ResourceTypes;

    it("AmbiguousResourceTypeError.matchedResourceTypes reports prototype-colliding type names faithfully", async () =>
      withCache(
        "fuzz-proto-ambiguous",
        overlappingProtoRegistry,
        async ({ name, cache }) => {
          assertAmbiguous(
            expectSyncThrow(() => cache.classify("x:1")),
            {
              cacheName: name,
              id: "x:1",
              matchedResourceTypes: ["__proto__", "constructor"],
            },
          );
        },
      ));

    it("stores and serves entries whose ids are Object.prototype member names", async () =>
      withCache(
        "fuzz-proto-ids-roundtrip",
        ACCEPT_ANY_REGISTRY,
        async ({ cache }) => {
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
        },
      ));
  });

  describe("accept-everything registries: classification never fails (§6.1)", () => {
    it("classifies every string -- however adversarial -- to the sole type", async () =>
      withCache("sole-classify", ACCEPT_ANY_REGISTRY, async ({ cache }) => {
        fc.assert(
          fc.property(AdversarialIdArb, (id) => {
            expect(cache.classify(id)).to.equal("visits");
          }),
        );
      }));

    it("get/store/delete accept every id on a sole-type cache (no runtime enforcement, matching 1.6.0)", async () =>
      withCache("sole-ops", ACCEPT_ANY_REGISTRY, async ({ cache }) => {
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
      }));
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
    const store = new MemoryStore();
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
