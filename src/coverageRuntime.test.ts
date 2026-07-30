import { expect } from "chai";
import { describe, it, mock } from "node:test";

import {
  captureChannels,
  expectRejection,
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
  wrapBulkComputingProducer,
  wrapBulkProducer,
  wrapComputingProducer,
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

const freshFor100 = { freshUntilAge: 100 };

describe("wrapper coverage -- runtime (§6.3, §6.4)", () => {
  describe("construction throws on a keyless producers/branches record", () => {
    it("producerByIdType: an empty record throws at construction time, while a bare producer function is a legal whole-registry producer", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("construct-wrap"),
        resourceTypes: registry,
      });
      try {
        // The keyless-record check moved out of the wrapper and into the
        // helper, which is now its only meaningful home.
        expect(() => producerByIdType(cache, {})).to.throw();
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
      const cache = new Cache(memoryStoreFor(registry), {
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
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("construct-computing"),
        resourceTypes: registry,
      });
      try {
        expect(() => wrapComputingProducer(cache, {}, {})).to.throw();
        // Bare functions structurally match the empty mapped record, so no
        // cast is needed to reach the runtime guard.
        expect(() => wrapComputingProducer(cache, {}, () => {})).to.throw();
        expect(() => wrapBulkComputingProducer(cache, {}, {})).to.throw();
        expect(() => wrapBulkComputingProducer(cache, {}, () => {})).to.throw();
      } finally {
        await cache.close();
      }
    });
  });

  describe("NoProducerForResourceTypeError: ids outside the wrapper's coverage", () => {
    it("wrapProducer: throws (with the documented §6.2 fields) BEFORE any store read", async () => {
      const name = uniqueCacheName("noproducer-single");
      const store = memoryStoreFor(threeTypeRegistry);
      const getSpy = mock.method(store, "get");
      const getManySpy = mock.method(store, "getMany");
      const cache = new Cache(store, {
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
        // messages (contract adjudication: no disposition ever existed).
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
      const cache = new Cache(store, { name, resourceTypes: registry });
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
        expect(getSpy.mock.callCount()).to.equal(0);
        expect(getManySpy.mock.callCount()).to.equal(0);
        expect(siteBulk.mock.callCount()).to.equal(0);
      } finally {
        await cache.close();
      }
    });
  });

  describe("partial coverage: two wrappers over one cache", () => {
    it("each wrapper serves only its own types; entries written by one (supplementals) are served by the other without producer contact", async () => {
      const name = uniqueCacheName("partial-wrappers");
      const cache = new Cache(memoryStoreFor(registry), {
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

    it("single-branch: no matchesInput required; caches by the branch's hashInput", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("computing-single"),
        resourceTypes: registry,
      });
      const produce = mock.fn(async (input: SoleInput) => ({
        content: `computed-${input.key}`,
        directives: freshFor100,
      }));
      // Explicit type args: `Input` inference degrades to `unknown` when a
      // branch's functions are pre-typed references (like mock.fn results)
      // rather than inline closures -- see the final report.
      const compute = wrapComputingProducer<
        SoleInput,
        typeof registry,
        "site_day"
      >(cache, {}, {
        site_day: {
          hashInput: (input): `site:${string}` => `site:${input.key}`,
          produce,
        },
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
    const isBranchedInput = (input: unknown): input is BranchedInput =>
      typeof input === "object" &&
      input !== null &&
      "kind" in input &&
      ((input as { kind: unknown }).kind === "site" ||
        (input as { kind: unknown }).kind === "biz");

    it("multi-branch: dispatches by matchesInput; each branch mints and serves its own type's ids", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
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
      const compute = wrapComputingProducer<
        BranchedInput,
        typeof registry,
        "site_day" | "business_slice"
      >(cache, {}, {
        site_day: {
          matchesInput: (input: unknown): input is BranchedInput =>
            isBranchedInput(input) && input.kind === "site",
          hashInput: (input): `site:${string}` => `site:${input.key}`,
          produce: siteProduce,
        },
        business_slice: {
          matchesInput: (input: unknown): input is BranchedInput =>
            isBranchedInput(input) && input.kind === "biz",
          hashInput: (input): `biz:${string}` => `biz:${input.key}`,
          produce: bizProduce,
        },
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

    it("a multi-branch wrapper missing matchesInput on a branch throws at construction", async () => {
      // §6.4: matchesInput is "required when the wrapper covers more than one
      // type". The doc specs the enforcement as compile-time overloads
      // (§11.5); the implementation enforces it at construction time instead
      // (see the acceptance report) -- this pins that a multi-branch wrapper
      // with a matcher-less branch can never be constructed silently.
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("computing-missing-matcher"),
        resourceTypes: registry,
      });
      try {
        expect(() =>
          wrapComputingProducer<
            BranchedInput,
            typeof registry,
            "site_day" | "business_slice"
          >(cache, {}, {
            site_day: {
              // no matchesInput
              hashInput: (input): `site:${string}` => `site:${input.key}`,
              produce: async (input) => ({
                content: `site-computed-${input.key}`,
                directives: freshFor100,
              }),
            },
            business_slice: {
              matchesInput: (input: unknown): input is BranchedInput =>
                isBranchedInput(input) && input.kind === "biz",
              hashInput: (input): `biz:${string}` => `biz:${input.key}`,
              produce: async (input) => ({
                content: `biz-computed-${input.key}`,
                directives: freshFor100,
              }),
            },
          }),
        ).to.throw();
      } finally {
        await cache.close();
      }
    });

    it("an input that no covered branch's matchesInput accepts rejects", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("computing-unmatched"),
        resourceTypes: registry,
      });
      const compute = wrapComputingProducer(cache, {}, {
        site_day: {
          matchesInput: (input: unknown): input is BranchedInput =>
            isBranchedInput(input) && input.kind === "site",
          hashInput: (input: BranchedInput): `site:${string}` =>
            `site:${input.key}`,
          produce: async (input: BranchedInput) => ({
            content: `site-computed-${input.key}`,
            directives: freshFor100,
          }),
        },
        business_slice: {
          matchesInput: (input: unknown): input is BranchedInput =>
            isBranchedInput(input) && input.kind === "biz",
          hashInput: (input: BranchedInput): `biz:${string}` =>
            `biz:${input.key}`,
          produce: async (input: BranchedInput) => ({
            content: `biz-computed-${input.key}`,
            directives: freshFor100,
          }),
        },
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
      const cache = new Cache(memoryStoreFor(registry), {
        name,
        resourceTypes: registry,
      });
      const compute = wrapComputingProducer(cache, {}, {
        site_day: {
          // Mints ids that match NO registry guard: violates the §6.4
          // in-band-discriminator requirement on hashInput.
          hashInput: (input: SoleInput) =>
            `unregistered:${input.key}` as string as `site:${string}`,
          produce: async (input: SoleInput) => ({
            content: `computed-${input.key}`,
            directives: freshFor100,
          }),
        },
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
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("computing-cross-type-hash"),
        resourceTypes: registry,
      });
      const compute = wrapComputingProducer(cache, {}, {
        site_day: {
          // Classifiable -- but to business_slice, not this branch's type, so
          // the "hashInput must mint ids its own type's guard accepts" check
          // has to reject it.
          hashInput: (input: SoleInput) =>
            `biz:${input.key}` as string as `site:${string}`,
          produce: async (input: SoleInput) => ({
            content: `computed-${input.key}`,
            directives: freshFor100,
          }),
        },
      });
      try {
        const thrown = await expectRejection(() => compute({ key: "a" }));
        expect(thrown).to.be.instanceOf(Error);
      } finally {
        await cache.close();
      }
    });

    it("matchesInput on a single-coverage wrapper is ignored at runtime (it is forbidden at the type level)", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("computing-ignored-matcher"),
        resourceTypes: registry,
      });
      const produce = mock.fn(async (input: SoleInput) => ({
        content: `computed-${input.key}`,
        directives: freshFor100,
      }));
      // `matchesInput` is documented as forbidden-and-ignored on
      // single-coverage wrappers; it's smuggled in at the value level (a
      // spread typed as `object` erases the property from the compile-time
      // view without a lying cast) to prove the runtime ignores it rather
      // than consulting it.
      const branch = {
        hashInput: (input: SoleInput): `site:${string}` => `site:${input.key}`,
        produce,
        ...({ matchesInput: () => false } as object),
      };
      const compute = wrapComputingProducer<
        SoleInput,
        typeof registry,
        "site_day"
      >(cache, {}, { site_day: branch });
      try {
        const res = await compute({ key: "a" });
        expect(res.content).to.equal("computed-a");
        expect(produce.mock.callCount()).to.equal(1);
      } finally {
        await cache.close();
      }
    });
  });
});
