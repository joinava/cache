import { expect } from "chai";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  expectRejection,
  freshFor100,
  uniqueCacheName,
} from "../../test/v2AcceptanceHelpers.js";
import Cache from "../Cache.js";
import {
  idStartsWith,
  MemoryStore,
  resourceType,
  UnclassifiableIdError,
  UnroutableIdError,
  type ResourceTypes,
} from "../index.js";
import { bulkProducerByIdType, producerByIdType } from "./producerByIdType.js";
import wrapProducer from "./wrapProducer.js";
import { wrapBulkProducer } from "./wrapBulkProducer.js";

/**
 * The by-id-type helpers own two contracts of their own, independent of the
 * wrappers they feed: an empty record is unconstructible, and routing needs only
 * the resource-type registry -- no `Cache` -- so a by-id-type producer is a
 * value in its own right. Coverage *enforcement* by the wrappers lives in
 * `coverageRuntime.test.ts`.
 *
 * These registries are deliberately local copies rather than shared fixtures:
 * they are free to diverge from any other suite's.
 */
const registry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<string>()({ matches: idStartsWith("biz:") }),
} satisfies ResourceTypes;

const threeTypeRegistry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<string>()({ matches: idStartsWith("biz:") }),
  extra_blob: resourceType<string>()({ matches: idStartsWith("extra:") }),
} satisfies ResourceTypes;

describe("producerByIdType / bulkProducerByIdType", () => {
  it("producerByIdType: an empty record throws at construction time, while a bare producer function is a legal whole-registry producer", async () => {
    const cache = new Cache({
      store: new MemoryStore(),
      name: uniqueCacheName("construct-wrap"),
      resourceTypes: registry,
    });
    try {
      // The keyless-record check moved out of the wrapper and into the
      // helper, which is now its only meaningful home. Note the registry,
      // not the cache: see the cache-free block below.
      expect(() => producerByIdType(registry, {})).to.throw();
      // ...and the form that used to throw here is the primitive now: a bare
      // function covers the whole registry, and its wrapper is callable.
      const bare = wrapProducer(cache, {}, async () => ({
        content: "x",
        directives: freshFor100,
      }));
      expect(await bare({ id: "site:1" })).to.include({ content: "x" });
      expect(await bare({ id: "biz:1" })).to.include({ content: "x" });
    } finally {
      await cache.close();
    }
  });
  it("bulkProducerByIdType: an empty record throws at construction time, while a bare bulk producer function is a legal whole-registry producer", async () => {
    const cache = new Cache({
      store: new MemoryStore(),
      name: uniqueCacheName("construct-bulk"),
      resourceTypes: registry,
    });
    try {
      expect(() => bulkProducerByIdType(registry, {})).to.throw();
      const bare = wrapBulkProducer(cache, {}, async (reqs) =>
        reqs.map(() => ({ content: "x", directives: freshFor100 })),
      );
      const results = await bare([{ id: "site:1" }, { id: "biz:1" }]);
      expect(
        results.map((it) => (it instanceof Error ? it : it.content)),
      ).to.deep.equal(["x", "x"]);
    } finally {
      await cache.close();
    }
  });
  it("bulkProducerByIdType: a sub-producer that fails SYNCHRONOUSLY is isolated to its own type's slots, like a rejection", async () => {
    // The isolation contract has to cover a synchronous throw, not just a
    // rejection: a non-async sub-producer that validates its batch (or whose
    // first synchronous step throws -- the hashed-input wrappers' internal
    // producers read their input registry synchronously) never reaches a handler
    // attached to its return value. Failing the whole invocation instead would
    // discard `business_slice`'s already-computed result and its store, for a
    // failure only `site_day` had.
    const boom = new Error("sync boom");
    const producer = bulkProducerByIdType(registry, {
      site_day: (reqs) => {
        expect(reqs.length).to.equal(2);
        throw boom;
      },
      business_slice: async (reqs) =>
        reqs.map((req) => ({
          content: `biz-${req.id}`,
          directives: freshFor100,
        })),
    });

    const emptyRequest = { params: {}, directives: {} } as const;
    const results = await producer([
      { ...emptyRequest, id: "site:1" },
      { ...emptyRequest, id: "biz:1" },
      { ...emptyRequest, id: "site:2" },
    ]);

    expect(results[0]).to.equal(boom);
    expect(results[2]).to.equal(boom);
    const survivor = results[1];
    assert.ok(survivor !== undefined && !(survivor instanceof Error));
    expect(survivor.content).to.equal("biz-biz:1");
  });

  describe("by-id-type producers are built from a registry, not a cache", () => {
    const emptyRequest = { params: {}, directives: {} } as const;

    it("producerByIdType: routes with no Cache in existence, and the same value then wraps against one", async () => {
      // The capability: routing by id type needs the registry and nothing else,
      // so the producer is a value in its own right -- buildable, drivable and
      // testable before any cache exists.
      const siteProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `site-${req.id}`,
        directives: freshFor100,
      }));
      const producer = producerByIdType(registry, {
        site_day: siteProducer,
        business_slice: async (req) => ({
          content: `biz-${req.id}`,
          directives: freshFor100,
        }),
      });

      const direct = await producer({ ...emptyRequest, id: "site:1" });
      expect(direct.content).to.equal("site-site:1");
      expect(
        (await producer({ ...emptyRequest, id: "biz:1" })).content,
      ).to.equal("biz-biz:1");
      expect(siteProducer.mock.callCount()).to.equal(1);

      // ...and the very same producer value goes on to feed a cache built
      // afterwards, serving the second call from the store.
      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("cachefree-single"),
        resourceTypes: registry,
      });
      try {
        const get = wrapProducer(cache, {}, producer);
        expect((await get({ id: "site:2" })).content).to.equal("site-site:2");
        expect(siteProducer.mock.callCount()).to.equal(2);
        expect((await get({ id: "site:2" })).content).to.equal("site-site:2");
        expect(siteProducer.mock.callCount()).to.equal(2);
      } finally {
        await cache.close();
      }
    });

    it("bulkProducerByIdType: splits a mixed batch with no Cache in existence", async () => {
      const producer = bulkProducerByIdType(registry, {
        site_day: async (reqs) =>
          reqs.map((req) => ({
            content: `site-${req.id}`,
            directives: freshFor100,
          })),
        business_slice: async (reqs) =>
          reqs.map((req) => ({
            content: `biz-${req.id}`,
            directives: freshFor100,
          })),
      });

      // Interleaved so a positional-reassembly bug can't pass: each result must
      // land back on its OWN request's index.
      const results = await producer([
        { ...emptyRequest, id: "site:1" },
        { ...emptyRequest, id: "biz:1" },
        { ...emptyRequest, id: "site:2" },
      ]);
      expect(
        results.map((it) => (it instanceof Error ? it.message : it.content)),
      ).to.deep.equal(["site-site:1", "biz-biz:1", "site-site:2"]);
    });

    it("driven directly, an id it cannot route throws UnroutableIdError -- cache-free, with the reason", async () => {
      const producer = producerByIdType(threeTypeRegistry, {
        site_day: async (req) => ({
          content: `site-${req.id}`,
          directives: freshFor100,
        }),
      });

      // Classifies fine, but to a type this producer doesn't cover.
      const uncovered = await expectRejection(() =>
        producer({
          ...emptyRequest,
          id: "biz:1" as string as `site:${string}`,
        }),
      );
      assert.ok(uncovered instanceof UnroutableIdError);
      expect(uncovered.detail).to.deep.equal({
        reason: "uncovered",
        resourceType: "business_slice",
      });
      expect(uncovered.id).to.equal("biz:1");
      expect(uncovered.coveredResourceTypes).to.deep.equal(["site_day"]);
      // No cache to name, so the message names neither one nor a placeholder.
      expect(uncovered.message).to.not.include("Cache ");

      // Classifies to nothing at all.
      const unclassifiable = await expectRejection(() =>
        producer({
          ...emptyRequest,
          id: "nope:1" as string as `site:${string}`,
        }),
      );
      assert.ok(unclassifiable instanceof UnroutableIdError);
      expect(unclassifiable.detail.reason).to.equal("unclassifiable");
    });

    it("through a wrapper, an UnroutableIdError is re-thrown as the cache-named error", async () => {
      // Reachable only when the registry the helper was built from disagrees
      // with the cache's -- the wrapper classifies against the cache's registry
      // first. Same keys and id types (so it still typechecks), different
      // guards: this one matches nothing.
      const divergent = {
        site_day: resourceType<string>()({
          matches: (id): id is `site:${string}` => id === "unreachable",
        }),
        business_slice: resourceType<string>()({
          matches: (id): id is `biz:${string}` => id === "unreachable",
        }),
      } satisfies ResourceTypes;

      const name = uniqueCacheName("divergent-registry");
      const cache = new Cache({
        store: new MemoryStore(),
        name,
        resourceTypes: registry,
      });
      try {
        const get = wrapProducer(
          cache,
          {},
          producerByIdType(divergent, {
            site_day: async (req) => ({
              content: `site-${req.id}`,
              directives: freshFor100,
            }),
          }),
        );
        // The cache classifies `site:1` to a covered type and dispatches; the
        // producer's own registry then can't route it.
        const thrown = await expectRejection(() => get({ id: "site:1" }));
        assert.ok(thrown instanceof UnclassifiableIdError);
        // The point of the re-throw: the cache's name is back on the error.
        expect(thrown.cacheName).to.equal(name);
        expect(thrown.id).to.equal("site:1");
        expect(thrown.message).to.include(`Cache "${name}"`);
      } finally {
        await cache.close();
      }
    });
  });
});
