import { expect } from "chai";
import { describe, it, mock } from "node:test";

import {
  captureChannels,
  expectRejection,
  expectSyncThrow,
  freshFor100,
  memoryStoreFor,
  uniqueCacheName,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  bulkProducerByIdType,
  idStartsWith,
  NoProducerForResourceTypeError,
  producerByIdType,
  resourceType,
  UnclassifiableIdError,
  bulkHashingProducerByInputType,
  hashingProducerByInputType,
  wrapBulkComputingProducer,
  wrapBulkProducer,
  wrapComputingProducer,
  type ComputingVariant,
  type ResourceTypes,
} from "./index.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * Runtime coverage contract (§6.3, §6.4, as amended by the 2026-07-30
 * single-producer design): the by-id-type helpers and the computing wrappers
 * throw at construction on keyless records; an id classifying outside a
 * wrapper's DECLARED coverage throws NoProducerForResourceTypeError BEFORE any
 * store read; two partial wrappers over one cache serve their own types
 * independently; and computing branches enforce that `hashInput` mints ids
 * their own resource type's guard accepts.
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

describe("wrapper coverage -- runtime (§6.3, §6.4)", () => {
  describe("construction throws on a keyless producers/branches record", () => {
    it("producerByIdType: an empty record throws at construction time, while a bare producer function is a legal whole-registry producer", async () => {
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name: uniqueCacheName("construct-wrap"),
        resourceTypes: registry,
      });
      try {
        // The keyless-record check moved out of the wrapper and into the
        // helper, which is now its only meaningful home.
        expect(() => producerByIdType(cache, {})).to.throw();
        // ...while a bare function is the primitive: it covers the whole
        // registry, so its wrapper is callable rather than throwing.
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
        store: memoryStoreFor(registry),
        name: uniqueCacheName("construct-bulk"),
        resourceTypes: registry,
      });
      try {
        expect(() => bulkProducerByIdType(cache, {})).to.throw();
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

    it("wrapComputingProducer / wrapBulkComputingProducer: empty record and bare function both throw at construction time", async () => {
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name: uniqueCacheName("construct-computing"),
        resourceTypes: registry,
      });
      try {
        // Neither form supplied.
        // @ts-expect-error deliberately reaching the runtime guard
        expect(() => wrapComputingProducer({ cache })).to.throw();
        // @ts-expect-error deliberately reaching the runtime guard
        expect(() => wrapBulkComputingProducer({ cache })).to.throw();
        // A builder with no `.when` branches could never produce anything.
        expect(() =>
          hashingProducerByInputType<{
            site_day: ComputingVariant<{ key: string }, string>;
          }>().build(),
        ).to.throw();
        expect(() =>
          bulkHashingProducerByInputType<{
            site_day: ComputingVariant<{ key: string }, string>;
          }>().build(),
        ).to.throw();
      } finally {
        await cache.close();
      }
    });

    it("hashing producer builders: a duplicate `.when` for one variant throws, rather than splitting dispatch from storage", () => {
      type Variants = { site_day: ComputingVariant<{ key: string }, string> };
      const isSiteDay = (input: { key: string }): input is { key: string } =>
        typeof input.key === "string";
      const hashInput = (input: { key: string }) => `site:${input.key}`;
      const singleBranch = {
        name: "site_day" as const,
        hashInput,
        produce: async (input: { readonly key: string }) => ({
          content: `computed-${input.key}`,
          directives: freshFor100,
        }),
      };
      const bulkBranch = {
        name: "site_day" as const,
        hashInput,
        produce: async (inputs: readonly { readonly key: string }[]) =>
          inputs.map((input) => ({
            content: `computed-${input.key}`,
            directives: freshFor100,
          })),
      };

      // `Name extends Exclude<keyof V & string, Covered>` rejects the repeat
      // where it is written (a compile fixture pins that), so re-typing the
      // builder as a fresh one is what lets the duplicate be reached at all.
      // Without the runtime guard it would not merely be shadowed: dispatch
      // takes the first matching branch while the per-resource-type producer
      // table keeps the last, storing the second branch's content under the
      // first branch's minted id.
      const duplicated = expectSyncThrow(() =>
        (
          hashingProducerByInputType<Variants>().when(
            isSiteDay,
            singleBranch,
          ) as unknown as ReturnType<
            typeof hashingProducerByInputType<Variants>
          >
        ).when(isSiteDay, singleBranch),
      );
      expect((duplicated as Error).message).to.match(
        /hashingProducerByInputType: `\.when` was called twice for branch "site_day"/,
      );

      const bulkDuplicated = expectSyncThrow(() =>
        (
          bulkHashingProducerByInputType<Variants>().when(
            isSiteDay,
            bulkBranch,
          ) as unknown as ReturnType<
            typeof bulkHashingProducerByInputType<Variants>
          >
        ).when(isSiteDay, bulkBranch),
      );
      expect((bulkDuplicated as Error).message).to.match(
        /bulkHashingProducerByInputType: `\.when` was called twice for branch "site_day"/,
      );
    });
  });

  describe("NoProducerForResourceTypeError: ids outside the wrapper's coverage", () => {
    it("wrapProducer: throws (with the documented §6.2 fields) BEFORE any store read", async () => {
      const name = uniqueCacheName("noproducer-single");
      const store = memoryStoreFor(threeTypeRegistry);
      const getSpy = mock.method(store, "get");
      const getManySpy = mock.method(store, "getMany");
      const cache = new Cache({
        store: store,
        name,
        resourceTypes: threeTypeRegistry,
      });
      const siteProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `site-${req.id}`,
        directives: freshFor100,
      }));
      const bizProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `biz-${req.id}`,
        directives: freshFor100,
      }));
      const getCovered = wrapProducer(
        cache,
        {},
        producerByIdType(cache, {
          site_day: siteProducer,
          business_slice: bizProducer,
        }),
      );
      const capture = captureChannels(name);
      try {
        // Reachable only via a cast / loosely-typed id -- the compiler bans
        // typed covered-set violations.
        const thrown = await expectRejection(() =>
          getCovered({ id: "extra:1" as string as `site:${string}` }),
        );
        if (!(thrown instanceof NoProducerForResourceTypeError)) {
          throw new Error(
            `expected NoProducerForResourceTypeError, got: ${String(thrown)}`,
          );
        }
        expect(thrown.name).to.equal("NoProducerForResourceTypeError");
        expect(thrown.cacheName).to.equal(name);
        expect(thrown.resourceType).to.equal("extra_blob");
        expect([...thrown.coveredResourceTypes].sort()).to.deep.equal([
          "business_slice",
          "site_day",
        ]);
        expect(thrown.id).to.equal("extra:1");

        // Thrown BEFORE reading the cache: serving a hit for an uncovered
        // type would smuggle serve-if-present back in through the cast.
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(getManySpy.mock.callCount()).to.equal(0);
        expect(siteProducer.mock.callCount()).to.equal(0);
        expect(bizProducer.mock.callCount()).to.equal(0);
        // ...and, as a pre-dispatch validation failure, it emits NO channel
        // messages (no disposition ever existed).
        expect(capture.read).to.deep.equal([]);
        expect(capture.fetch).to.deep.equal([]);
        expect(capture.produce).to.deep.equal([]);

        // Positive control for the spy: a covered request does read.
        await getCovered({ id: "site:1" });
        expect(getSpy.mock.callCount()).to.equal(1);
      } finally {
        capture.stop();
        await cache.close();
      }
    });

    it("wrapBulkProducer: an uncovered element rejects the call before any store read", async () => {
      const name = uniqueCacheName("noproducer-bulk");
      const store = memoryStoreFor(registry);
      const getSpy = mock.method(store, "get");
      const getManySpy = mock.method(store, "getMany");
      const cache = new Cache({
        store: store,
        name,
        resourceTypes: registry,
      });
      const siteBulk = mock.fn(
        async (reqs: readonly { readonly id: string }[]) =>
          reqs.map((req) => ({
            content: `site-${req.id}`,
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
          getBulk([
            { id: "site:ok" },
            { id: "biz:1" as string as `site:${string}` },
          ]),
        );
        if (!(thrown instanceof NoProducerForResourceTypeError)) {
          throw new Error(
            `expected NoProducerForResourceTypeError, got: ${String(thrown)}`,
          );
        }
        expect(thrown.cacheName).to.equal(name);
        expect(thrown.resourceType).to.equal("business_slice");
        expect([...thrown.coveredResourceTypes]).to.deep.equal(["site_day"]);
        expect(thrown.id).to.equal("biz:1");
        // The whole call is rejected before any read: the covered element is
        // not quietly served either.
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(getManySpy.mock.callCount()).to.equal(0);
        expect(siteBulk.mock.callCount()).to.equal(0);

        // Positive control for the spies: an all-covered batch does read.
        await getBulk([{ id: "site:ok" }]);
        expect(
          getSpy.mock.callCount() + getManySpy.mock.callCount(),
        ).to.be.at.least(1);
      } finally {
        await cache.close();
      }
    });
  });

  describe("partial coverage: two wrappers over one cache", () => {
    it("each wrapper serves only its own types; entries written by one (supplementals) are served by the other without producer contact", async () => {
      const name = uniqueCacheName("partial-wrappers");
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name,
        resourceTypes: registry,
      });
      const capture = captureChannels(name);
      const siteProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `site-content-${req.id}`,
        directives: freshFor100,
        supplementalResources: [
          {
            id: "biz:derived" as const,
            content: "slice-derived-from-site",
            directives: freshFor100,
          },
        ],
      }));
      const bizProducer = mock.fn(async (req: { readonly id: string }) => ({
        content: `biz-content-${req.id}`,
        directives: freshFor100,
      }));

      // Two wrappers, each covering a different non-empty subset of the one
      // cache's registry (the well-sky site-persons shape).
      const getSite = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { site_day: siteProducer }),
      );
      const getBiz = wrapProducer(
        cache,
        {},
        producerByIdType(cache, { business_slice: bizProducer }),
      );
      try {
        const siteRes = await getSite({ id: "site:1" });
        expect(siteRes.content).to.equal("site-content-site:1");
        expect(siteProducer.mock.callCount()).to.equal(1);
        expect(bizProducer.mock.callCount()).to.equal(0);

        const bizRes = await getBiz({ id: "biz:1" });
        expect(bizRes.content).to.equal("biz-content-biz:1");
        expect(bizProducer.mock.callCount()).to.equal(1);

        // The site wrapper's supplemental write is served by the OTHER
        // wrapper straight from the cache: no bizProducer invocation.
        const derived = await getBiz({ id: "biz:derived" });
        expect(derived.content).to.equal("slice-derived-from-site");
        expect(bizProducer.mock.callCount()).to.equal(1);

        // Each producer only ever saw ids of its own resource type.
        siteProducer.mock.calls.forEach((call) => {
          expect(call.arguments[0]?.id.startsWith("site:")).to.equal(true);
        });
        bizProducer.mock.calls.forEach((call) => {
          expect(call.arguments[0]?.id.startsWith("biz:")).to.equal(true);
        });

        // And attribution on the shared cache's messages tracked each
        // request's own type, with no flow-level naming anywhere.
        const fetchTypes = capture.fetch.map((m) => m.resourceType).sort();
        expect(fetchTypes).to.deep.equal([
          "business_slice",
          "business_slice",
          "site_day",
        ]);
      } finally {
        capture.stop();
        await cache.close();
      }
    });
  });

  describe("computing wrappers (§6.4)", () => {
    type SoleInput = { key: string };
    const isSoleInput = (input: SoleInput): input is SoleInput =>
      typeof input.key === "string";
    type SoleVariants = { site_day: ComputingVariant<SoleInput, string> };

    it("single-branch: no matchesInput required; caches by the branch's hashInput", async () => {
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name: uniqueCacheName("computing-single"),
        resourceTypes: registry,
      });
      const produce = mock.fn(async (input: SoleInput) => ({
        content: `computed-${input.key}`,
        directives: freshFor100,
      }));
      const compute = wrapComputingProducer({
        cache,
        hashInput: (input: SoleInput): `site:${string}` => `site:${input.key}`,
        produce,
      });
      try {
        const first = await compute({ key: "a" });
        expect(first.content).to.equal("computed-a");
        const second = await compute({ key: "a" });
        expect(second.content).to.equal("computed-a");
        expect(produce.mock.callCount()).to.equal(1);

        // The minted id is a real cache id of the branch's resource type.
        const direct = await cache.get({
          id: "site:a",
          params: {},
          directives: {},
        });
        expect(direct.usable?.content).to.equal("computed-a");
      } finally {
        await cache.close();
      }
    });

    type SiteInput = { kind: "site"; key: string };
    type BizInput = { kind: "biz"; key: string };
    type BranchedInput = SiteInput | BizInput;
    // Per-branch guards: each proves only its own variant's input.
    const isSiteInput = (input: BranchedInput): input is SiteInput =>
      input.kind === "site";
    const isBizInput = (input: BranchedInput): input is BizInput =>
      input.kind === "biz";
    type BranchedVariants = {
      site_day: ComputingVariant<SiteInput, string>;
      business_slice: ComputingVariant<BizInput, string>;
    };

    it("multi-branch: dispatches by matchesInput; each branch mints and serves its own type's ids", async () => {
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name: uniqueCacheName("computing-multi"),
        resourceTypes: registry,
      });
      const siteProduce = mock.fn(async (input: BranchedInput) => ({
        content: `site-computed-${input.key}`,
        directives: freshFor100,
      }));
      const bizProduce = mock.fn(async (input: BranchedInput) => ({
        content: `biz-computed-${input.key}`,
        directives: freshFor100,
      }));
      const compute = wrapComputingProducer({
        cache,
        hashingProducer: hashingProducerByInputType<BranchedVariants>()
          .when(isSiteInput, {
            name: "site_day",
            hashInput: (input): `site:${string}` => `site:${input.key}`,
            produce: siteProduce,
          })
          .when(isBizInput, {
            name: "business_slice",
            hashInput: (input): `biz:${string}` => `biz:${input.key}`,
            produce: bizProduce,
          })
          .build(),
      });
      try {
        const siteRes = await compute({ kind: "site", key: "1" });
        expect(siteRes.content).to.equal("site-computed-1");
        const bizRes = await compute({ kind: "biz", key: "2" });
        expect(bizRes.content).to.equal("biz-computed-2");
        expect(siteProduce.mock.callCount()).to.equal(1);
        expect(bizProduce.mock.callCount()).to.equal(1);

        // Cached per branch-minted id: repeats hit.
        await compute({ kind: "site", key: "1" });
        await compute({ kind: "biz", key: "2" });
        expect(siteProduce.mock.callCount()).to.equal(1);
        expect(bizProduce.mock.callCount()).to.equal(1);
      } finally {
        await cache.close();
      }
    });

    // (A matcher-less branch has no test because it is unconstructible:
    // `.when(matchesInput, branch)` takes the guard positionally.)

    it("an input that no covered branch's matchesInput accepts rejects", async () => {
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name: uniqueCacheName("computing-unmatched"),
        resourceTypes: registry,
      });
      const compute = wrapComputingProducer({
        cache,
        hashingProducer: hashingProducerByInputType<BranchedVariants>()
          .when(isSiteInput, {
            name: "site_day",
            hashInput: (input): `site:${string}` => `site:${input.key}`,
            produce: async (input) => ({
              content: `site-computed-${input.key}`,
              directives: freshFor100,
            }),
          })
          .when(isBizInput, {
            name: "business_slice",
            hashInput: (input): `biz:${string}` => `biz:${input.key}`,
            produce: async (input) => ({
              content: `biz-computed-${input.key}`,
              directives: freshFor100,
            }),
          })
          .build(),
      });
      try {
        const thrown = await expectRejection(() =>
          compute({ kind: "neither", key: "x" } as unknown as BranchedInput),
        );
        expect(thrown).to.be.instanceOf(Error);
      } finally {
        await cache.close();
      }
    });

    it("a branch whose hashInput mints an unclassifiable id throws UnclassifiableIdError naming the branch", async () => {
      const name = uniqueCacheName("computing-bad-hash");
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name,
        resourceTypes: registry,
      });
      const compute = wrapComputingProducer({
        cache,
        hashingProducer: hashingProducerByInputType<SoleVariants>()
          .when(isSoleInput, {
            name: "site_day",
            // Mints ids that match NO registry guard: violates the §6.4
            // in-band-discriminator requirement on hashInput.
            hashInput: (input) =>
              `unregistered:${input.key}` as string as `site:${string}`,
            produce: async (input) => ({
              content: `computed-${input.key}`,
              directives: freshFor100,
            }),
          })
          .build(),
      });
      try {
        const thrown = await expectRejection(() => compute({ key: "a" }));
        if (!(thrown instanceof UnclassifiableIdError)) {
          throw new Error(
            `expected UnclassifiableIdError, got: ${String(thrown)}`,
          );
        }
        expect(thrown.cacheName).to.equal(name);
        expect(thrown.id).to.equal("unregistered:a");
        // §6.4: the mismatch error names the offending branch.
        expect(thrown.message).to.include("site_day");
      } finally {
        await cache.close();
      }
    });

    it("a branch whose hashInput mints ANOTHER type's id (its own guard rejects it) throws", async () => {
      const cache = new Cache({
        store: memoryStoreFor(registry),
        name: uniqueCacheName("computing-cross-type-hash"),
        resourceTypes: registry,
      });
      const compute = wrapComputingProducer({
        cache,
        hashingProducer: hashingProducerByInputType<SoleVariants>()
          .when(isSoleInput, {
            name: "site_day",
            // Classifiable -- but to business_slice, not this branch's type, so
            // the "hashInput must mint ids its own type's guard accepts" check
            // has to reject it.
            hashInput: (input) =>
              `biz:${input.key}` as string as `site:${string}`,
            produce: async (input) => ({
              content: `computed-${input.key}`,
              directives: freshFor100,
            }),
          })
          .build(),
      });
      try {
        const thrown = await expectRejection(() => compute({ key: "a" }));
        expect(thrown).to.be.instanceOf(Error);
      } finally {
        await cache.close();
      }
    });

    // Likewise, "matchesInput is ignored on a single-coverage wrapper" no
    // longer has a subject: the two-function form has no guard at all, and a
    // one-`.when` builder's guard IS consulted like any other (pinned in
    // wrapComputingProducer.test.ts).
  });
});
