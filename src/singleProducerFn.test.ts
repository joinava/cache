import { expect } from "chai";
import { omit } from "es-toolkit";
import { describe, it, mock } from "node:test";

import {
  captureChannels,
  expectProduceMessage,
  expectProducerPathFetch,
  expectRejection,
  memoryStoreFor,
  uniqueCacheName,
  waitUntil,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  bulkProducerByIdType,
  idStartsWith,
  NoProducerForResourceTypeError,
  producerByIdType,
  resourceType,
  wrapBulkProducer,
  wrapProducer,
  type ResourceTypes,
  type SpecOf,
} from "./index.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import type { ResourceTypeSpec } from "./types/00_ResourceTypes.js";

/**
 * Runtime contract tests for the single-producer-function change
 * (docs/plans/2026-07-30-single-producer-fn-and-by-id-type-sugar.md §3, §5):
 * both wrappers take exactly ONE producer function; a bare function covers the
 * whole registry and therefore sees a batch spanning every requested resource
 * type in one call; partial coverage and per-type dispatch come from
 * `producerByIdType` / `bulkProducerByIdType`, which split by
 * `cache.classify`, reassemble positionally, isolate a sub-producer's rejection
 * to its own slots, and carry their covered set to the wrapper for the
 * pre-read `NoProducerForResourceTypeError` check.
 *
 * Written from the design doc, not from an implementation.
 */

const registry = {
  story: resourceType<string>()({ matches: idStartsWith("story:") }),
  collection: resourceType<string>()({
    matches: idStartsWith("collection:"),
  }),
} satisfies ResourceTypes;

/** The sole-type shape the majority of the monorepo's caches use (§7). */
const soleRegistry = {
  visits: resourceType<string>()({
    matches: (id): id is string => typeof id === "string",
  }),
} satisfies ResourceTypes;

const freshFor100 = { freshUntilAge: 100 };

/**
 * The parameter type every bulk producer below is written against: wider than
 * what the wrapper passes (contravariance), so these fixtures stay agnostic
 * about `params`/`directives` normalization.
 */
type BulkReqs = readonly { readonly id: string }[];

/**
 * A general-purpose store's spec: strictly WIDER than `registry`, which covers
 * only `story` and `collection`.
 */
type WiderStoreSpec = SpecOf<{
  story: ResourceTypeSpec<`story:${string}`, string>;
  collection: ResourceTypeSpec<`collection:${string}`, string>;
  unused_by_this_cache: ResourceTypeSpec<`other:${string}`, string>;
}>;

/**
 * Every test in this file is deliberately backed by a store that supports MORE
 * resource types than the cache's registry -- the common case, since most stores
 * are general-purpose. Note what is NOT needed: no explicit type arguments, and
 * no re-instantiating the store with artificially narrowed ones. `Store` is
 * invariant in its `Spec`, so `Store<Wider>` is not assignable to
 * `Store<SpecOf<typeof registry>>`; the cache captures the store's own spec in
 * `StoreSupportedTypes` and only checks that it *covers* the registry.
 *
 * A fresh store per harness, so tests stay isolated.
 */
const makeHarness = (label: string) => {
  const name = uniqueCacheName(label);
  const store = new MemoryStore<WiderStoreSpec>();
  const cache = new Cache({ store, name, resourceTypes: registry });
  return { name, store, cache };
};

const makeSoleHarness = (label: string) => {
  const name = uniqueCacheName(label);
  const cache = new Cache({
    store: memoryStoreFor(soleRegistry),
    name,
    resourceTypes: soleRegistry,
  });
  return { name, cache };
};

/** Unwraps a wrapped-bulk result array, failing loudly on Error elements. */
const contentsOf = (
  results: readonly ({ readonly content: string } | Error)[],
): string[] =>
  results.map((result) => {
    if (result instanceof Error) {
      throw result;
    }
    return result.content;
  });

describe("single producer function + by-id-type sugar", () => {
  describe("1. full-batch delivery (the capability this change exists for)", () => {
    it("wrapBulkProducer: a bare producer is invoked exactly ONCE with every request, spanning both resource types, in the caller's order", async () => {
      const { cache } = makeHarness("sp-full-batch");
      const bulkProducer = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `produced-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(cache, {}, bulkProducer);
      try {
        const results = await getBulk([
          { id: "story:1" },
          { id: "collection:1" },
          { id: "story:2" },
        ]);

        // 2.0 issued one call PER RESOURCE TYPE, so the multi-type producer
        // could never see (and optimize across) the full requested set. One
        // call is the whole point of the change; a per-type split here is the
        // regression.
        expect(bulkProducer.mock.callCount()).to.equal(1);
        expect(
          bulkProducer.mock.calls[0]?.arguments[0]?.map((req) => req.id),
        ).to.deep.equal(["story:1", "collection:1", "story:2"]);

        // ...and the batch is still request-paired positionally.
        expect(contentsOf(results)).to.deep.equal([
          "produced-story:1",
          "produced-collection:1",
          "produced-story:2",
        ]);
      } finally {
        await cache.close();
      }
    });
  });

  describe("2. per-type dispatch through bulkProducerByIdType (§3.4)", () => {
    it("splits the mixed batch by classified type, calls each sub-producer once with its own slice, and reassembles into the CALLER's order", async () => {
      const { cache } = makeHarness("sp-by-id-type");
      const storyBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `story-${req.id}`,
          directives: freshFor100,
        })),
      );
      const collectionBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `collection-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, {
          story: storyBulk,
          collection: collectionBulk,
        }),
      );
      try {
        const results = await getBulk([
          { id: "story:1" },
          { id: "collection:1" },
          { id: "story:2" },
        ]);

        expect(storyBulk.mock.callCount()).to.equal(1);
        expect(
          storyBulk.mock.calls[0]?.arguments[0]?.map((req) => req.id),
        ).to.deep.equal(["story:1", "story:2"]);
        expect(collectionBulk.mock.callCount()).to.equal(1);
        expect(
          collectionBulk.mock.calls[0]?.arguments[0]?.map((req) => req.id),
        ).to.deep.equal(["collection:1"]);

        // Reassembly is positional AND correct: an implementation that simply
        // concatenated the per-type slices would answer
        // [story:1, story:2, collection:1] here.
        expect(contentsOf(results)).to.deep.equal([
          "story-story:1",
          "collection-collection:1",
          "story-story:2",
        ]);
      } finally {
        await cache.close();
      }
    });

    it("reassembles by POSITION, not by id: a batch repeating one id with different params gets each slot's own result", async () => {
      const { cache } = makeHarness("sp-by-id-type-dupes");
      // Content is keyed by the request's index WITHIN its slice, so an
      // id-keyed reassembly (which §3.4 rules out precisely because a batch
      // may legitimately repeat an id) would hand both story slots the same
      // element.
      const storyBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req, index) => ({
          content: `story-slot${index}-${req.id}`,
          directives: freshFor100,
        })),
      );
      const collectionBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req, index) => ({
          content: `collection-slot${index}-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, {
          story: storyBulk,
          collection: collectionBulk,
        }),
      );
      try {
        const results = await getBulk([
          { id: "story:dupe", params: { variant: "a" } },
          { id: "collection:1" },
          { id: "story:dupe", params: { variant: "b" } },
        ]);

        expect(
          storyBulk.mock.calls[0]?.arguments[0]?.map((req) => req.id),
        ).to.deep.equal(["story:dupe", "story:dupe"]);
        expect(contentsOf(results)).to.deep.equal([
          "story-slot0-story:dupe",
          "collection-slot0-collection:1",
          "story-slot1-story:dupe",
        ]);
      } finally {
        await cache.close();
      }
    });
  });

  describe("3. error isolation inside bulkProducerByIdType (§3.4)", () => {
    it("a REJECTING sub-producer errors only its own type's slots; the other type's results are delivered normally", async () => {
      const { name, cache } = makeHarness("sp-sugar-error-isolation");
      const capture = captureChannels(name);
      const storyFailure = new Error("story origin unreachable");
      const storyBulk = mock.fn(async () => {
        throw storyFailure;
      });
      const collectionBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `collection-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, {
          story: storyBulk,
          collection: collectionBulk,
        }),
      );
      try {
        const results = await getBulk([
          { id: "story:1" },
          { id: "collection:1" },
          { id: "story:2" },
        ]);

        // The sugar catches the rejection and writes it into that type's slots
        // -- so the call RESOLVES rather than rejecting wholesale.
        expect(results[0]).to.equal(storyFailure);
        expect(results[2]).to.equal(storyFailure);
        const collectionSlot = results[1];
        if (collectionSlot instanceof Error) {
          throw collectionSlot;
        }
        expect(collectionSlot.content).to.equal("collection-collection:1");

        // Both sub-producers ran: the story failure did not cancel or skip the
        // collection slice.
        expect(storyBulk.mock.callCount()).to.equal(1);
        expect(collectionBulk.mock.callCount()).to.equal(1);

        // Per-request settlement matches: the story elements are
        // producer-error, the collection element is served-from-producer.
        expect(capture.fetch).to.have.lengthOf(3);
        const dispositionsById = Object.fromEntries(
          capture.fetch.map((message) => [
            message.resourceId,
            message.disposition,
          ]),
        );
        expect(dispositionsById).to.deep.equal({
          "story:1": "producer-error",
          "story:2": "producer-error",
          "collection:1": "served-from-producer",
        });

        // One invocation, and it SETTLED by resolving (per-element Errors are
        // not an invocation failure) -- the contrast with the under-return
        // case below.
        expect(capture.produce).to.have.lengthOf(1);
        expect(capture.produce[0]?.outcome).to.equal("success");
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("an UNDER-RETURNING sub-producer is not padded: the wrapper's under-return check fails the whole invocation", async () => {
      const { name, cache } = makeHarness("sp-sugar-under-return");
      const capture = captureChannels(name);
      // Returns one result for its two requests. §3.4 forbids the sugar from
      // substituting an Error for the missing slot: that would turn a producer
      // contract violation into a per-request failure and hide the bug.
      const storyBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.slice(0, 1).map((req) => ({
          content: `story-${req.id}`,
          directives: freshFor100,
        })),
      );
      const collectionBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `collection-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, {
          story: storyBulk,
          collection: collectionBulk,
        }),
      );
      try {
        const thrown = await expectRejection(() =>
          getBulk([
            { id: "story:1" },
            { id: "collection:1" },
            { id: "story:2" },
          ]),
        );
        expect(thrown).to.be.instanceOf(Error);
        // Not a coverage failure -- both types are covered here.
        expect(thrown).to.not.be.instanceOf(NoProducerForResourceTypeError);

        // The collection sub-producer still ran; the failure is the story
        // slice's contract violation, and it poisons the WHOLE invocation.
        expect(collectionBulk.mock.callCount()).to.equal(1);
        expect(capture.produce).to.have.lengthOf(1);
        expect(capture.produce[0]?.outcome).to.equal("error");
        expect(capture.storeEntry).to.deep.equal([]);

        // Every element settles producer-error exactly once, including the
        // healthy collection element: nothing was delivered.
        expect(capture.fetch).to.have.lengthOf(3);
        capture.fetch.forEach((message) => {
          expect(message.disposition).to.equal("producer-error");
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("4. diagnostics: one produce message per invocation, spanning types (§5.3)", () => {
    it("a bare producer's mixed batch publishes exactly ONE produce message whose requests[] carries each element's own resourceType", async () => {
      const { name, cache } = makeHarness("sp-produce-bare");
      const capture = captureChannels(name);
      const bulkProducer = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `produced-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(cache, {}, bulkProducer);
      try {
        await getBulk([
          { id: "story:1" },
          { id: "collection:1" },
          { id: "story:2" },
        ]);

        // §5.3 deletes the "all elements share resourceType" invariant:
        // subscribers must stop reading requests[0].resourceType as the
        // invocation's type. (expectProduceMessage deep-equals everything but
        // durationMs, so a message that still carried a top-level resourceType
        // fails here.)
        expect(capture.produce).to.have.lengthOf(1);
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [
            { resourceType: "story", resourceId: "story:1" },
            { resourceType: "collection", resourceId: "collection:1" },
            { resourceType: "story", resourceId: "story:2" },
          ],
          collapsedCallerCount: 1,
          outcome: "success",
        });

        // Per-request attribution on the fetch channel is unchanged (§4):
        // still one message per request, still classified from its own id.
        expect(capture.fetch).to.have.lengthOf(3);
        const fetchByResourceId = new Map(
          capture.fetch.map((message) => [message.resourceId, message]),
        );
        (
          [
            ["story:1", "story"],
            ["collection:1", "collection"],
            ["story:2", "story"],
          ] as const
        ).forEach(([resourceId, resourceType]) => {
          expectProducerPathFetch(fetchByResourceId.get(resourceId), {
            cache: name,
            resourceType,
            resourceId,
            disposition: "served-from-producer",
            directivesImpliedBypass: false,
            collapsed: false,
          });
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("bulkProducerByIdType's split is invisible to the produce channel: still ONE message spanning both types", async () => {
      const { name, cache } = makeHarness("sp-produce-sugar");
      const capture = captureChannels(name);
      const storyBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `story-${req.id}`,
          directives: freshFor100,
        })),
      );
      const collectionBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `collection-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, {
          story: storyBulk,
          collection: collectionBulk,
        }),
      );
      try {
        await getBulk([{ id: "story:1" }, { id: "collection:1" }]);

        // §5.1: one invocation per trigger group, not per (group x type). Two
        // messages here would mean the split moved back into the wrapper.
        expect(capture.produce).to.have.lengthOf(1);
        expectProduceMessage(capture.produce[0], {
          cache: name,
          trigger: "miss",
          requests: [
            { resourceType: "story", resourceId: "story:1" },
            { resourceType: "collection", resourceId: "collection:1" },
          ],
          collapsedCallerCount: 1,
          outcome: "success",
        });
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("5. runtime coverage and its timing (§5.2)", () => {
    it("wrapProducer + producerByIdType over a strict subset: an uncovered id throws NoProducerForResourceTypeError BEFORE any store read", async () => {
      const name = uniqueCacheName("sp-coverage-single");
      const store = memoryStoreFor(registry);
      const getSpy = mock.method(store, "get");
      const getManySpy = mock.method(store, "getMany");
      const cache = new Cache({
        store: store,
        name,
        resourceTypes: registry,
      });
      const storyProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `story-${req.id}`,
        directives: freshFor100,
      }));
      const getStory = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { story: storyProducer }),
      );
      const capture = captureChannels(name);
      try {
        // Reachable only via a cast: the wrapped function's request type bans
        // uncovered ids (see singleProducerTyping.test.ts).
        const thrown = await expectRejection(() =>
          getStory({ id: "collection:1" as string as `story:${string}` }),
        );
        if (!(thrown instanceof NoProducerForResourceTypeError)) {
          throw new Error(
            `expected NoProducerForResourceTypeError, got: ${String(thrown)}`,
          );
        }
        expect(thrown.cacheName).to.equal(name);
        expect(thrown.resourceType).to.equal("collection");
        // The covered set now comes from the producer's coverage carrier
        // instead of a record's keys; it must still name the covered types.
        expect([...thrown.coveredResourceTypes]).to.deep.equal(["story"]);
        expect(thrown.id).to.equal("collection:1");

        // ...and the TIMING must be preserved: nothing may touch the store,
        // because serving a hit for an uncovered type would smuggle the
        // serve-if-present contract back in through the cast.
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(getManySpy.mock.callCount()).to.equal(0);
        expect(storyProducer.mock.callCount()).to.equal(0);
        // A pre-dispatch validation failure emits no channel messages.
        expect(capture.read).to.deep.equal([]);
        expect(capture.fetch).to.deep.equal([]);
        expect(capture.produce).to.deep.equal([]);

        // Positive control for the spies: a covered request DOES read.
        await getStory({ id: "story:1" });
        expect(
          getSpy.mock.callCount() + getManySpy.mock.callCount(),
        ).to.be.at.least(1);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("wrapBulkProducer + bulkProducerByIdType over a strict subset: an uncovered element rejects the call before any store read", async () => {
      const name = uniqueCacheName("sp-coverage-bulk");
      const store = memoryStoreFor(registry);
      const getSpy = mock.method(store, "get");
      const getManySpy = mock.method(store, "getMany");
      const cache = new Cache({
        store: store,
        name,
        resourceTypes: registry,
      });
      const storyBulk = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `story-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(
        cache,
        {},
        bulkProducerByIdType(cache, { story: storyBulk }),
      );
      try {
        const thrown = await expectRejection(() =>
          getBulk([
            { id: "story:ok" },
            { id: "collection:1" as string as `story:${string}` },
          ]),
        );
        if (!(thrown instanceof NoProducerForResourceTypeError)) {
          throw new Error(
            `expected NoProducerForResourceTypeError, got: ${String(thrown)}`,
          );
        }
        expect(thrown.cacheName).to.equal(name);
        expect(thrown.resourceType).to.equal("collection");
        expect([...thrown.coveredResourceTypes]).to.deep.equal(["story"]);
        expect(thrown.id).to.equal("collection:1");

        // The whole call is rejected before any read: the covered element is
        // not quietly served either.
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(getManySpy.mock.callCount()).to.equal(0);
        expect(storyBulk.mock.callCount()).to.equal(0);

        // Positive control.
        await getBulk([{ id: "story:ok" }]);
        expect(
          getSpy.mock.callCount() + getManySpy.mock.callCount(),
        ).to.be.at.least(1);
      } finally {
        await cache.close();
      }
    });

    it("companion (wrapProducer): through a BARE function no id of any registry type can produce that error", async () => {
      const { cache } = makeHarness("sp-coverage-bare-single");
      // Keyed by resource-type name, and cross-checked against the registry
      // below, so a registry that grows a type this fixture doesn't exercise
      // fails rather than silently narrowing the claim.
      const sampleIdByType = {
        story: "story:1",
        collection: "collection:1",
      } as const satisfies Record<keyof typeof registry, string>;
      const producer = mock.fn(async (req: { readonly id: string }) => ({
        content: `produced-${req.id}`,
        directives: freshFor100,
      }));
      const getAny = wrapProducer(cache, {}, producer);
      try {
        expect(Object.keys(sampleIdByType).toSorted()).to.deep.equal(
          Object.keys(registry).toSorted(),
        );
        Object.entries(sampleIdByType).forEach(([typeName, id]) => {
          expect(cache.classify(id)).to.equal(typeName);
        });

        // A bare function's coverage is the whole registry BY CONSTRUCTION
        // (its parameter type must accept every registry id), so the error is
        // unreachable -- these must all resolve.
        const entries = await Promise.all(
          Object.values(sampleIdByType).map((id) => getAny({ id })),
        );
        expect(entries.map((entry) => entry.content)).to.deep.equal([
          "produced-story:1",
          "produced-collection:1",
        ]);
        expect(producer.mock.callCount()).to.equal(2);
      } finally {
        await cache.close();
      }
    });

    it("companion (wrapBulkProducer): a bare function covers every registry type in one mixed batch", async () => {
      const { cache } = makeHarness("sp-coverage-bare-bulk");
      const sampleIdByType = {
        story: "story:bulk",
        collection: "collection:bulk",
      } as const satisfies Record<keyof typeof registry, string>;
      const bulkProducer = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `produced-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(cache, {}, bulkProducer);
      try {
        expect(Object.keys(sampleIdByType).toSorted()).to.deep.equal(
          Object.keys(registry).toSorted(),
        );
        const results = await getBulk([
          { id: sampleIdByType.story },
          { id: sampleIdByType.collection },
        ]);
        expect(contentsOf(results)).to.deep.equal([
          "produced-story:bulk",
          "produced-collection:bulk",
        ]);
      } finally {
        await cache.close();
      }
    });
  });

  describe("7. sole-type regression: the common case is unaffected (§7 migration)", () => {
    it("wrapProducer: the bare form and the record form it replaces (producerByIdType) return identical entries and both hit the cache on the repeat", async () => {
      const bare = makeSoleHarness("sp-sole-bare");
      const record = makeSoleHarness("sp-sole-record");
      const bareProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `produced-${req.id}`,
        directives: freshFor100,
      }));
      const recordProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `produced-${req.id}`,
        directives: freshFor100,
      }));
      // `{ visits: fn }` -> `fn` is the migration §7 applies to the majority of
      // the monorepo's cache constructions; the two forms must be
      // indistinguishable to callers.
      const getBare = wrapProducer(bare.cache, {}, bareProducer);
      const getRecord = wrapProducer(
        record.cache,
        {},
        producerByIdType(record.cache, { visits: recordProducer }),
      );
      const bareCapture = captureChannels(bare.name);
      const recordCapture = captureChannels(record.name);
      try {
        const [bareMiss, recordMiss] = await Promise.all([
          getBare({ id: "v1" }),
          getRecord({ id: "v1" }),
        ]);
        // `date` is stamped per invocation, so it legitimately differs between
        // the two independent producer calls; everything else must match.
        expect(omit(bareMiss, ["date"])).to.deep.equal(
          omit(recordMiss, ["date"]),
        );
        expect(bareMiss.content).to.equal("produced-v1");
        expect(bareProducer.mock.callCount()).to.equal(1);
        expect(recordProducer.mock.callCount()).to.equal(1);

        await waitUntil(
          () =>
            bareCapture.storeEntry.length === 1 &&
            recordCapture.storeEntry.length === 1,
          "both forms stored their miss",
        );

        const [bareHit, recordHit] = await Promise.all([
          getBare({ id: "v1" }),
          getRecord({ id: "v1" }),
        ]);
        expect(omit(bareHit, ["date"])).to.deep.equal(
          omit(recordHit, ["date"]),
        );
        expect(bareProducer.mock.callCount()).to.equal(1);
        expect(recordProducer.mock.callCount()).to.equal(1);

        // Same disposition sequence under both forms.
        const bareDispositions = bareCapture.fetch.map((m) => m.disposition);
        expect(bareDispositions).to.deep.equal(
          recordCapture.fetch.map((m) => m.disposition),
        );
        expect(bareDispositions).to.deep.equal([
          "served-from-producer",
          "served-from-cache",
        ]);
      } finally {
        bareCapture.stop();
        recordCapture.stop();
        await bare.cache.close();
        await record.cache.close();
      }
    });

    it("wrapBulkProducer: a bare producer over a sole-type cache keeps request order and leaves cached ids to the cache", async () => {
      const { cache } = makeSoleHarness("sp-sole-bulk-bare");
      const bulkProducer = mock.fn(async (reqs: BulkReqs) =>
        reqs.map((req) => ({
          content: `fresh-${req.id}`,
          directives: freshFor100,
        })),
      );
      const getBulk = wrapBulkProducer(cache, {}, bulkProducer);
      try {
        await cache.store([
          {
            id: "cached-1",
            content: "cached-content",
            directives: freshFor100,
          },
        ]);

        const results = await getBulk([
          { id: "b" },
          { id: "cached-1" },
          { id: "a" },
        ]);

        // Result order tracks REQUEST order across the cache/producer mix --
        // the behavior the pre-change sole-type suite pins, unchanged by the
        // bare form.
        expect(contentsOf(results)).to.deep.equal([
          "fresh-b",
          "cached-content",
          "fresh-a",
        ]);
        expect(bulkProducer.mock.callCount()).to.equal(1);
        expect(
          bulkProducer.mock.calls[0]?.arguments[0]?.map((req) => req.id),
        ).to.deep.equal(["b", "a"]);
      } finally {
        await cache.close();
      }
    });
  });
});
