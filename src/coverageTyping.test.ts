import { expect } from "chai";
import { describe, it } from "node:test";
import type { IsEqual } from "type-fest";
import type { JsonOf } from "type-party";

import { expectType, uniqueCacheName } from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  bulkProducerByIdType,
  cacheReadChannel,
  idStartsWith,
  MemoryStore,
  producerByIdType,
  resourceType,
  singleTypeCacheOptions,
  wrapBulkProducer,
  hashedInputProducerByInputType,
  wrapHashedInputProducer,
  type AnyParams,
  type AnyValidators,
  type CacheReadMessage,
  type CacheSpec,
  type HashedInputVariant,
  type ContentOfResourceType,
  type IdOfResourceType,
  type ResourceTypeName,
  type ResourceTypes,
  type ResourceTypeSpec,
  type SpecOf,
} from "./index.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * Type-level acceptance tests for the §6.1/§6.3/§6.4 coverage machinery,
 * mirroring the design probes: `Covered` inferred from a partial producer
 * record (via `producerByIdType`) bounds the wrapped function's request ids;
 * producer `req`s are contextually narrowed per key; non-registry keys are
 * rejected; supplementals may target uncovered types; a record passed where the
 * single producer function belongs is a compile error; and
 * a one-entry registry's `Id` flows through everything.
 *
 * Follows the perIdTyping.test.ts conventions: compile-time assertions via
 * `expectType<IsEqual<...>>()`, `@ts-expect-error` fixtures (kept on ONE line
 * so the error's reported position can't drift off the suppressed line), and
 * `if (false)` guards around calls that must typecheck (or fail to) without
 * running.
 */

type SiteId = `site:${string}`;
type BizId = `biz:${string}`;
type ExtraId = `extra:${string}`;
type Visits = { visits: number[] };
type BlobContent = { blob: string };

const registry = {
  site_day: resourceType<Visits>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<Visits>()({ matches: idStartsWith("biz:") }),
  extra_blob: resourceType<BlobContent>()({ matches: idStartsWith("extra:") }),
} satisfies ResourceTypes;

const freshFor1 = { freshUntilAge: 1 };

describe("coverage typing (§6.1, §6.3, §6.4, §10)", () => {
  describe("registry derivation (§6.1)", () => {
    // SpecOf computes the cache's Spec union from the registry, instead of a
    // parallel declaration that can drift.
    expectType<
      IsEqual<
        SpecOf<typeof registry>,
        | CacheSpec<SiteId, Visits>
        | CacheSpec<BizId, Visits>
        | CacheSpec<ExtraId, BlobContent>
      >
    >();
    expectType<
      IsEqual<
        ResourceTypeName<typeof registry>,
        "site_day" | "business_slice" | "extra_blob"
      >
    >();
    expectType<
      IsEqual<IdOfResourceType<(typeof registry)["site_day"]>, SiteId>
    >();
    expectType<
      IsEqual<
        ContentOfResourceType<(typeof registry)["extra_blob"]>,
        BlobContent
      >
    >();
    expectType<
      IsEqual<ContentOfResourceType<ResourceTypeSpec<string, Visits>>, Visits>
    >();

    // classify() returns the registry's name union.
    expectType<
      IsEqual<
        ReturnType<Cache<typeof registry>["classify"]>,
        "site_day" | "business_slice" | "extra_blob"
      >
    >();

    it("compiles", () => {});
  });

  describe("Cache constructor requires name and resourceTypes (§6.2)", () => {
    it("compiles", () => {
      if (false as boolean) {
        // @ts-expect-error the options bag (name + resourceTypes) is required
        void new Cache(new MemoryStore());
        // @ts-expect-error `name` is required
        void new Cache({
          store: new MemoryStore(),
          resourceTypes: registry,
        });
        // @ts-expect-error `resourceTypes` is required
        void new Cache({
          store: new MemoryStore(),
          name: "x",
        });
      }
    });
  });

  describe("the store may support a WIDER spec than the registry (§6.8)", () => {
    it("accepts a general-purpose store, and rejects one that does not cover the registry", () => {
      if (false as boolean) {
        // WIDER than `registry` (which has no `other:` type): accepted with no
        // explicit type arguments and no narrowing of the store's own type.
        // `Store` is invariant in `Spec`, so this is only possible because the
        // cache captures the store's spec separately and checks coverage.
        void new Cache({
          store: new MemoryStore<
            | SpecOf<typeof registry>
            | CacheSpec<`other:${string}`, { unrelated: true }>
          >(),
          name: "wider-store",
          resourceTypes: registry,
        });

        // NOT covering: this store handles `site:` and `biz:` but not
        // `extra:`, which `registry` requires. Coverage is enforced, so the
        // convenience above cannot silently accept a store that would fail at
        // runtime on an `extra:` id.
        // prettier-ignore
        // @ts-expect-error store must support at least every registry type
        void new Cache({ store: new MemoryStore<CacheSpec<SiteId, Visits> | CacheSpec<BizId, Visits>>(), name: "under-covering-store", resourceTypes: registry });
      }
    });
  });

  describe("wrapProducer: Covered inferred from producerByIdType's partial record (§6.3)", () => {
    it("bounds the wrapped function's ids to the covered types and narrows per-key", async () => {
      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-partial"),
        resourceTypes: registry,
      });
      try {
        const fetchSite = wrapProducer(
          { cache },
          producerByIdType(cache.resourceTypes, {
            site_day: async (req) => {
              // Contextually typed per key -- narrowed, and NOT any.
              expectType<IsEqual<typeof req.id, SiteId>>();
              return {
                content: { visits: [1] },
                directives: freshFor1,
                // Supplementals may target UNCOVERED types.
                supplementalResources: [
                  {
                    id: "biz:1" as BizId,
                    content: { visits: [1] } satisfies Visits,
                    directives: freshFor1,
                  },
                  {
                    id: "extra:1" as ExtraId,
                    content: { blob: "x" } satisfies BlobContent,
                    directives: freshFor1,
                  },
                ],
              };
            },
          }),
        );

        const res = await fetchSite({ id: "site:1" });
        expectType<IsEqual<typeof res.content, Visits>>();
        expect(res.content).to.deep.equal({ visits: [1] });

        if (false as boolean) {
          const bizId = "biz:1" as BizId;
          // @ts-expect-error an uncovered type's id is rejected at the call site
          void fetchSite({ id: bizId });
          const looseId = "anything" as string;
          // @ts-expect-error plain string is rejected too
          void fetchSite({ id: looseId });
        }
      } finally {
        await cache.close();
      }
    });

    it("a two-key record covers the union (with per-id return narrowing); the third type stays uncovered", async () => {
      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-two-key"),
        resourceTypes: registry,
      });
      try {
        const fetchTwo = wrapProducer(
          { cache },
          producerByIdType(cache.resourceTypes, {
            site_day: async (req) => {
              expectType<IsEqual<typeof req.id, SiteId>>();
              return { content: { visits: [1, 2] }, directives: freshFor1 };
            },
            extra_blob: async (req) => {
              expectType<IsEqual<typeof req.id, ExtraId>>();
              return { content: { blob: "b" }, directives: freshFor1 };
            },
          }),
        );

        const visits = await fetchTwo({ id: "site:1" });
        expectType<IsEqual<typeof visits.content, Visits>>();
        const blob = await fetchTwo({ id: "extra:1" });
        expectType<IsEqual<typeof blob.content, BlobContent>>();
        expect(visits.content).to.deep.equal({ visits: [1, 2] });
        expect(blob.content).to.deep.equal({ blob: "b" });

        if (false as boolean) {
          const bizId = "biz:1" as BizId;
          // @ts-expect-error business_slice is still uncovered
          void fetchTwo({ id: bizId });
        }
      } finally {
        await cache.close();
      }
    });

    it("rejects non-registry keys, mismatched (branch id, content) pairs, and options the branch type does not declare", async () => {
      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-rejections"),
        resourceTypes: registry,
      });
      const siteProducerStub = async (_req: { id: SiteId }) => ({
        content: { visits: [] as number[] },
        directives: freshFor1,
      });
      try {
        if (false as boolean) {
          // prettier-ignore
          // @ts-expect-error 'sight_day' is not a registry resource-type name
          void producerByIdType(cache.resourceTypes, { sight_day: siteProducerStub });

          // prettier-ignore
          // @ts-expect-error extra_blob's content shape is not assignable under site_day
          void producerByIdType(cache.resourceTypes, { site_day: async () => ({ content: { blob: "x" }, directives: freshFor1 }) });

          // prettier-ignore
          // @ts-expect-error `cacheName` was deleted from WrapProducerOptions (names come from the cache + registry now)
          void wrapProducer({ cache, cacheName: "legacy" }, producerByIdType(cache.resourceTypes, { site_day: siteProducerStub }));

          // prettier-ignore
          // @ts-expect-error `isCacheable` was deleted (the producer purity contract, §6.3)
          void wrapProducer({ cache, isCacheable: () => false }, producerByIdType(cache.resourceTypes, { site_day: siteProducerStub }));
        }
      } finally {
        await cache.close();
      }
    });

    it("a record where the single producer belongs is rejected, as is a bare function typed for a strict subset; a whole-registry bare function covers everything", async () => {
      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-never"),
        resourceTypes: registry,
      });
      try {
        if (false as boolean) {
          // prettier-ignore
          // @ts-expect-error the wrapper takes ONE producer function; a per-type record must go through producerByIdType
          void wrapProducer({ cache }, { site_day: async (_req: { id: SiteId }) => ({ content: { visits: [] as number[] }, directives: freshFor1 }) });

          // prettier-ignore
          // @ts-expect-error an empty record is not a function either
          void wrapProducer({ cache }, {});

          // `Covered` never infers from the producer's PARAMETER type, so it
          // keeps its default (the whole registry) and the compiler makes the
          // function prove it: one typed for only site_day ids is rejected,
          // rather than silently widened.
          // prettier-ignore
          // @ts-expect-error a bare function that accepts only site_day ids cannot cover the registry
          void wrapProducer({ cache }, async (_req: { id: SiteId }) => ({ content: { visits: [] as number[] }, directives: freshFor1 }));

          // A function that accepts EVERY registry id is accepted, and its
          // wrapper takes every registry id.
          const whole = wrapProducer({ cache }, async (req) => {
            expectType<IsEqual<typeof req.id, SiteId | BizId | ExtraId>>();
            return {
              content: { visits: [] as number[] },
              directives: freshFor1,
            };
          });
          void whole({ id: "site:1" });
          void whole({ id: "biz:1" });
          void whole({ id: "extra:1" });

          // Note what the bare form gives up, and why `producerByIdType` is
          // still worth reaching for: a single producer's result type is the
          // UNION over its covered ids, so returning one variant's content for
          // every id typechecks (`whole` above only ever returns Visits, yet
          // covers extra_blob, whose content is a blob). The per-branch
          // (id, content) correlation comes from the record form, where each
          // key narrows its sub-producer's result to that key's content -- as
          // the two tests above pin. The wrapper still narrows what the CALLER
          // sees per request id either way.
        }
      } finally {
        await cache.close();
      }
    });

    it("wrapBulkProducer: request elements are bounded per element by the covered types", async () => {
      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-bulk"),
        resourceTypes: registry,
      });
      try {
        const bulk = wrapBulkProducer(
          { cache },
          bulkProducerByIdType(cache.resourceTypes, {
            site_day: async (reqs) => {
              expectType<IsEqual<(typeof reqs)[number]["id"], SiteId>>();
              return reqs.map(() => ({
                content: { visits: [] as number[] },
                directives: freshFor1,
              }));
            },
            business_slice: async (reqs) =>
              reqs.map(() => ({
                content: { visits: [] as number[] },
                directives: freshFor1,
              })),
          }),
        );

        // A reqs array may mix COVERED types.
        const results = await bulk([{ id: "site:1" }, { id: "biz:1" }]);
        const first = results[0];
        if (!(first instanceof Error)) {
          expectType<IsEqual<typeof first.content, Visits>>();
        }

        if (false as boolean) {
          // prettier-ignore
          // @ts-expect-error ids of uncovered types are compile errors per element
          void bulk([{ id: "site:1" }, { id: "extra:1" as ExtraId }]);
        }
      } finally {
        await cache.close();
      }
    });
  });

  describe("a one-entry registry's narrowed Id (§6.1, §6.4)", () => {
    // Narrowing a one-entry registry's id space while its guard accepted every
    // string was unsound, so that form is gone (see `singleTypeCacheOptions`).
    // A narrower id space now comes only from a REAL guard, which is what makes
    // the narrowing enforceable rather than merely asserted -- and the
    // type-level flow pinned below is identical either way.
    const zendeskRegistry = {
      ticket_schema: resourceType<{ fields: string[] }>()({
        matches: idStartsWith("zendesk-ticket-schema:"),
      }),
    } satisfies ResourceTypes;
    type TicketSpec = SpecOf<typeof zendeskRegistry>;

    type SiteVisitsKey = JsonOf<{ site: string; date: string }>;
    /**
     * For a JSON-branded id, earning the narrower type means actually parsing
     * it. The old sugar claimed this type off a `typeof id === "string"` check,
     * so a malformed id was admitted and stored under a spec that said it could
     * not exist.
     */
    const isSiteVisitsKey = (id: string): id is SiteVisitsKey => {
      const parsed = ((): unknown => {
        try {
          return JSON.parse(id);
        } catch {
          return undefined;
        }
      })();
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        "site" in parsed &&
        typeof parsed.site === "string" &&
        "date" in parsed &&
        typeof parsed.date === "string"
      );
    };
    const brandedRegistry = {
      site_day: resourceType<number[]>()({ matches: isSiteVisitsKey }),
    } satisfies ResourceTypes;

    const defaultRegistry = {
      visits: resourceType<number[]>()({
        matches: (id): id is string => typeof id === "string",
      }),
    } satisfies ResourceTypes;

    // The narrowed Id flows through SpecOf...
    expectType<IsEqual<TicketSpec["id"], `zendesk-ticket-schema:${string}`>>();
    expectType<IsEqual<SpecOf<typeof brandedRegistry>["id"], SiteVisitsKey>>();
    // ...while an accept-everything guard stays `string`, for caches whose
    // ids have no inspectable structure.
    expectType<IsEqual<SpecOf<typeof defaultRegistry>["id"], string>>();

    it("singleTypeCacheOptions: keeps content and id types exact while giving up only the resource-type name", async () => {
      const defaultName = new Cache(
        singleTypeCacheOptions<number[]>()({
          store: new MemoryStore(),
          name: "typing-single-default-name",
        }),
      );
      const explicitName = new Cache(
        singleTypeCacheOptions<number[]>()({
          store: new MemoryStore(),
          name: "typing-single-explicit-name",
          resourceTypeName: "visits",
        }),
      );
      try {
        // The helper trades away only the resource-type NAME's precision --
        // `classify()` returns `string` rather than the literal, which is the
        // point of not having to name it. What matters stays exact:
        expectType<IsEqual<ReturnType<typeof defaultName.classify>, string>>();
        expectType<
          IsEqual<SpecOf<typeof defaultName.resourceTypes>["content"], number[]>
        >();
        expectType<
          IsEqual<
            SpecOf<typeof explicitName.resourceTypes>["content"],
            number[]
          >
        >();

        // Without `validateId` the sole type accepts every id, so the id space
        // is exactly `string`.
        if (false as boolean) {
          const bare = "x" as string;
          void defaultName.get({ id: bare, params: {}, directives: {} });
          void explicitName.get({ id: bare, params: {}, directives: {} });
        }
      } finally {
        await defaultName.close();
        await explicitName.close();
      }
    });

    it("singleTypeCacheOptions: `validateId` narrows the id space through to the cache's request type", async () => {
      const guarded = new Cache(
        singleTypeCacheOptions<{ fields: string[] }>()({
          // The store needs NO type argument to earn the narrowing: `Id` comes
          // from the guard alone, and the store is only checked for coverage.
          store: new MemoryStore(),
          name: "typing-single-guarded",
          validateId: idStartsWith("zendesk-ticket-schema:"),
        }),
      );
      try {
        // `Id` came from the guard, and it reaches the cache's request type.
        expectType<
          IsEqual<
            SpecOf<typeof guarded.resourceTypes>["id"],
            `zendesk-ticket-schema:${string}`
          >
        >();

        if (false as boolean) {
          const bare = "x" as string;
          // prettier-ignore
          // @ts-expect-error the guard narrowed the id space below `string`
          void guarded.get({ id: bare, params: {}, directives: {} });
          void guarded.get({
            id: "zendesk-ticket-schema:b1:abc",
            params: {},
            directives: {},
          });
        }
      } finally {
        await guarded.close();
      }
    });

    it("singleTypeCacheOptions: a store supporting a WIDER spec backs a narrowed sole-type cache", async () => {
      // The sugar gets the same store-coverage rule as a hand-written registry:
      // the store must support at least the cache's sole resource type, and may
      // support more. Nothing about the wider store leaks into the cache's own
      // types -- the id space is still the guard's, and the content type is
      // still the one asked for, not the store's union.
      const shared = new MemoryStore<
        | CacheSpec<`zendesk-ticket-schema:${string}`, { fields: string[] }>
        | CacheSpec<`unrelated:${string}`, number[]>
      >();
      const narrowed = new Cache(
        singleTypeCacheOptions<{ fields: string[] }>()({
          store: shared,
          name: "typing-single-wider-store",
          validateId: idStartsWith("zendesk-ticket-schema:"),
        }),
      );
      try {
        expectType<
          IsEqual<
            SpecOf<typeof narrowed.resourceTypes>["id"],
            `zendesk-ticket-schema:${string}`
          >
        >();
        expectType<
          IsEqual<
            SpecOf<typeof narrowed.resourceTypes>["content"],
            { fields: string[] }
          >
        >();

        if (false as boolean) {
          const bare = "x" as string;
          // prettier-ignore
          // @ts-expect-error the guard's id space still bounds the cache
          void narrowed.get({ id: bare, params: {}, directives: {} });
          // prettier-ignore
          // @ts-expect-error an id the STORE supports but this cache does not
          void narrowed.get({ id: "unrelated:1", params: {}, directives: {} });
          void narrowed.get({
            id: "zendesk-ticket-schema:b1:abc",
            params: {},
            directives: {},
          });
        }
      } finally {
        await narrowed.close();
      }
    });

    it("singleTypeCacheOptions: rejects a store that does not cover the sole type, and a narrow Id with no guard behind it", () => {
      if (false as boolean) {
        // A narrower id space may only be NAMED when a runtime guard enforces
        // it. Without `validateId` the explicit type argument is refused, so the
        // asserted-but-unchecked narrowing the old sugar allowed stays closed.
        // prettier-ignore
        // @ts-expect-error `validateId` is required once `Id` is narrower than string
        void singleTypeCacheOptions<number[]>()<`visits:${string}`>({ store: new MemoryStore(), name: "typing-single-named-no-guard" });

        // Coverage is enforced where a hand-written registry enforces it: at
        // the constructor. Wrong content type for the ids this cache uses...
        // prettier-ignore
        // @ts-expect-error store holds strings; this cache holds number[]
        void new Cache(singleTypeCacheOptions<number[]>()({ store: new MemoryStore<CacheSpec<string, string>>(), name: "typing-single-bad-content" }));

        // ...and a store whose id space is NARROWER than the cache's, which
        // would let the cache try to store ids the store says cannot exist.
        // prettier-ignore
        // @ts-expect-error unguarded cache spans every string; store spans only `visits:`
        void new Cache(singleTypeCacheOptions<number[]>()({ store: new MemoryStore<CacheSpec<`visits:${string}`, number[]>>(), name: "typing-single-narrow-store" }));
      }
    });

    it("rejects bare-string ids at the type level (template-literal and branded), while the default form accepts any string", async () => {
      const zendeskCache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-sole-tpl"),
        resourceTypes: zendeskRegistry,
      });
      const defaultCache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-sole-default"),
        resourceTypes: defaultRegistry,
      });
      try {
        if (false as boolean) {
          const bare = "x" as string;
          // @ts-expect-error a bare string does not satisfy the narrowed sole id
          const rejected: TicketSpec["id"] = bare;
          void rejected;
          const accepted: TicketSpec["id"] = "zendesk-ticket-schema:b1:abc";
          void accepted;
          // @ts-expect-error a string literal does not satisfy a BRANDED sole id
          const rejectedBrand: SpecOf<typeof brandedRegistry>["id"] =
            "anything";
          void rejectedBrand;

          // Request-level enforcement on the cache itself:
          // prettier-ignore
          // @ts-expect-error bare-string requests are rejected on the narrowed sole type
          void zendeskCache.get({ id: bare, params: {}, directives: {} });
          void zendeskCache.get({
            id: "zendesk-ticket-schema:b1:abc",
            params: {},
            directives: {},
          });

          // The default form accepts any string.
          void defaultCache.get({ id: bare, params: {}, directives: {} });
        }
      } finally {
        await zendeskCache.close();
        await defaultCache.close();
      }
    });

    it("hashInput's return type is the (possibly narrowed) sole id", async () => {
      const zendeskCache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-sole-hash"),
        resourceTypes: zendeskRegistry,
      });
      const defaultCache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-default-hash"),
        resourceTypes: defaultRegistry,
      });
      try {
        if (false as boolean) {
          // These caches have one resource type, so the two-function form
          // applies and there is nothing to name: `Input` comes from
          // `hashInput`'s parameter and the entry type from its RETURN.

          // prettier-ignore
          // @ts-expect-error hashInput returning a bare string is rejected when the sole type declares a narrowed Id
          void wrapHashedInputProducer({ cache: zendeskCache, hashInput: (input: { b: string }) => `nope-${input.b}`, produce: async () => ({ content: { fields: [] as string[] }, directives: freshFor1 }) });

          // A conforming hashInput compiles...
          void wrapHashedInputProducer({
            cache: zendeskCache,
            hashInput: (input: {
              b: string;
            }): `zendesk-ticket-schema:${string}` =>
              `zendesk-ticket-schema:${input.b}`,
            produce: async () => ({
              content: { fields: [] as string[] },
              directives: freshFor1,
            }),
          });

          // ...and the default (un-narrowed) sole form accepts plain strings.
          void wrapHashedInputProducer({
            cache: defaultCache,
            hashInput: (input: { k: string }) => `computed:${input.k}`,
            produce: async () => ({
              content: [1, 2],
              directives: freshFor1,
            }),
          });
        }
      } finally {
        await zendeskCache.close();
        await defaultCache.close();
      }
    });
  });

  describe("hashed-input branches (§6.4)", () => {
    type SiteInput = { kind: "site"; key: string };
    type BizInput = { kind: "biz"; key: string };
    type BranchedInput = SiteInput | BizInput;
    // Each guard proves only its OWN branch's input, which is what `name`
    // selecting the variant buys: an input-derived selection would force both
    // guards to claim the whole union.
    const isSite = (input: BranchedInput): input is SiteInput =>
      input.kind === "site";
    const isBiz = (input: BranchedInput): input is BizInput =>
      input.kind === "biz";
    type Variants = {
      site_day: HashedInputVariant<SiteInput, Visits>;
      business_slice: HashedInputVariant<BizInput, Visits>;
    };

    it("a hashed-input producer is built with no cache, and narrows each branch's input", () => {
      // The whole point of the builder being cache-free: this is a value, not
      // a call that needs a cache to exist first.
      const producer = hashedInputProducerByInputType<Variants>()
        .when(isSite, {
          name: "site_day",
          // `input` is SiteInput -- not the union, and not `any`.
          hashInput: (input) => `site:${input.key}` as SiteId,
          produce: async (input) => ({
            content: { visits: [input.key.length] },
            directives: freshFor1,
          }),
        })
        .when(isBiz, {
          name: "business_slice",
          hashInput: (input) => `biz:${input.key}` as BizId,
          produce: async (input) => ({
            content: { visits: [input.key.length] },
            directives: freshFor1,
          }),
        })
        .build();

      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-computing-built"),
        resourceTypes: registry,
      });
      const compute = wrapHashedInputProducer({
        cache,
        hashedInputProducer: producer,
      });

      // The wrapped function accepts the union of the covered branches' inputs,
      // and returns the union of their contents.
      expectType<IsEqual<Parameters<typeof compute>[0], BranchedInput>>();
      expectType<
        IsEqual<Awaited<ReturnType<typeof compute>>["content"], Visits>
      >();

      if (false as boolean) {
        // prettier-ignore
        // @ts-expect-error an input outside every covered variant
        void compute({ kind: "nope", key: "x" });
      }
      void cache.close();
    });

    it("rejects a branch whose produce returns another variant's content", () => {
      if (false as boolean) {
        // Checked against the DECLARED variant, at the branch, with no cache.
        // prettier-ignore
        // @ts-expect-error site_day's declared output is Visits, not BlobContent
        void hashedInputProducerByInputType<Variants>().when(isSite, { name: "site_day", hashInput: (input) => `site:${input.key}` as SiteId, produce: async () => ({ content: { blob: "x" }, directives: freshFor1 }) });
      }
    });

    it("rejects a second branch for an already-covered variant", () => {
      if (false as boolean) {
        // prettier-ignore
        // @ts-expect-error site_day already has a `.when` branch, so the second is dead code
        void hashedInputProducerByInputType<Variants>().when(isSite, { name: "site_day", hashInput: (input) => `site:${input.key}` as SiteId, produce: async (input) => ({ content: { visits: [input.key.length] }, directives: freshFor1 }) }).when(isSite, { name: "site_day", hashInput: (input) => `site:other-${input.key}` as SiteId, produce: async (input) => ({ content: { visits: [input.key.length] }, directives: freshFor1 }) });
      }
    });

    it("rejects a guard that proves an input the variant map never declared", () => {
      if (false as boolean) {
        const isUnrelated = (input: BranchedInput): input is BizInput =>
          input.kind === "biz";
        // prettier-ignore
        // @ts-expect-error a BizInput guard cannot serve the site_day variant
        void hashedInputProducerByInputType<Variants>().when(isUnrelated, { name: "site_day", hashInput: (input) => `site:${(input as SiteInput).key}` as SiteId, produce: async () => ({ content: { visits: [] as number[] }, directives: freshFor1 }) });
      }
    });

    it("rejects, at the cache, a branch minting outside its variant's resource type and a variant name outside the registry", () => {
      const cache = new Cache({
        store: new MemoryStore(),
        name: uniqueCacheName("typing-computing-registry"),
        resourceTypes: registry,
      });
      if (false as boolean) {
        // The builder is happy (the mint matches nothing it declared about
        // ids); wiring it to a cache is where the registry has a say.
        const misMinted = hashedInputProducerByInputType<Variants>()
          .when(isSite, {
            name: "site_day",
            hashInput: (input) => `biz:${input.key}` as BizId,
            produce: async () => ({
              content: { visits: [] as number[] },
              directives: freshFor1,
            }),
          })
          .build();
        // prettier-ignore
        // @ts-expect-error site_day's ids are `site:`, so the wrapped function is a problem object, not callable
        void wrapHashedInputProducer({ cache, hashedInputProducer: misMinted })({ kind: "site", key: "k" });

        const badName = hashedInputProducerByInputType<{
          nonsense: HashedInputVariant<SiteInput, Visits>;
        }>()
          .when(isSite, {
            name: "nonsense",
            hashInput: (input) => `site:${input.key}` as SiteId,
            produce: async () => ({
              content: { visits: [] as number[] },
              directives: freshFor1,
            }),
          })
          .build();
        // prettier-ignore
        // @ts-expect-error "nonsense" is not a resource type of this registry
        void wrapHashedInputProducer({ cache, hashedInputProducer: badName })({ kind: "site", key: "k" });
      }
      void cache.close();
    });

    it("hashed-input supplementals: input-keyed correlate per variant; id-keyed need the registry declared", () => {
      if (false as boolean) {
        // Input-keyed supplementals may target ANY covered variant, and are
        // correlated: the input and content must come from the same one.
        // Id-keyed ones need the registry's id space, which a cache-free
        // builder only has if it is declared (here, for `extra_blob`, which
        // this producer does not even cover).
        void hashedInputProducerByInputType<
          Variants,
          AnyValidators,
          AnyParams,
          SpecOf<typeof registry>
        >()
          .when(isSite, {
            name: "site_day",
            hashInput: (input) => `site:${input.key}` as SiteId,
            produce: async () => ({
              content: { visits: [] as number[] },
              directives: freshFor1,
              supplementalResources: [
                {
                  input: { kind: "biz", key: "b" } satisfies BizInput,
                  content: { visits: [] as number[] } satisfies Visits,
                  directives: freshFor1,
                },
                {
                  id: "extra:1" as ExtraId,
                  content: { blob: "x" } satisfies BlobContent,
                  directives: freshFor1,
                },
              ],
            }),
          })
          .when(isBiz, {
            name: "business_slice",
            hashInput: (input) => `biz:${input.key}` as BizId,
            produce: async () => ({
              content: { visits: [] as number[] },
              directives: freshFor1,
            }),
          })
          .build();

        // prettier-ignore
        // @ts-expect-error an id-keyed supplemental's (id, content) must correlate: an extra_blob id cannot carry Visits
        void hashedInputProducerByInputType<Variants, AnyValidators, AnyParams, SpecOf<typeof registry>>().when(isSite, { name: "site_day", hashInput: (input) => `site:${input.key}` as SiteId, produce: async () => ({ content: { visits: [] as number[] }, directives: freshFor1, supplementalResources: [{ id: "extra:1" as ExtraId, content: { visits: [] as number[] }, directives: freshFor1 }] }) });

        // prettier-ignore
        // @ts-expect-error a business_slice input cannot carry BlobContent, which no variant declares
        void hashedInputProducerByInputType<Variants>().when(isSite, { name: "site_day", hashInput: (input) => `site:${input.key}` as SiteId, produce: async () => ({ content: { visits: [] as number[] }, directives: freshFor1, supplementalResources: [{ input: { kind: "biz", key: "b" } satisfies BizInput, content: { blob: "x" }, directives: freshFor1 }] }) });
      }
    });
  });

  describe("TypedChannel export (§6.5)", () => {
    // The public typed-channel objects carry the message and literal channel
    // name types through subscribe.
    expectType<
      IsEqual<
        Parameters<(typeof cacheReadChannel)["subscribe"]>[0],
        (message: CacheReadMessage, name: "@zingage/cache:read") => void
      >
    >();

    it("compiles", () => {});
  });
});
