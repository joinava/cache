import { expect } from "chai";
import { describe, it } from "node:test";
import type { JsonOf } from "type-party";

import { memoryStoreFor, uniqueCacheName } from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  cacheReadChannel,
  idStartsWith,
  MemoryStore,
  resourceType,
  soleResourceType,
  wrapBulkProducer,
  wrapComputingProducer,
  type CacheReadMessage,
  type CacheSpec,
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
 * record bounds the wrapped function's request ids; producer `req`s are
 * contextually narrowed per key; non-registry keys are rejected;
 * supplementals may target uncovered types; keyless records are compile-dead;
 * and `soleResourceType`'s optional narrowed `Id` flows through everything.
 *
 * Follows the perIdTyping.test.ts conventions: compile-time assertions via
 * `expectType<Equal<...>>()`, `@ts-expect-error` fixtures (kept on ONE line
 * so the error's reported position can't drift off the suppressed line), and
 * `if (false)` guards around calls that must typecheck (or fail to) without
 * running.
 */

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
const expectType = <_T extends true>(): void => {};

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
      Equal<
        SpecOf<typeof registry>,
        | CacheSpec<SiteId, Visits>
        | CacheSpec<BizId, Visits>
        | CacheSpec<ExtraId, BlobContent>
      >
    >();
    expectType<
      Equal<
        ResourceTypeName<typeof registry>,
        "site_day" | "business_slice" | "extra_blob"
      >
    >();
    expectType<
      Equal<IdOfResourceType<(typeof registry)["site_day"]>, SiteId>
    >();
    expectType<
      Equal<
        ContentOfResourceType<(typeof registry)["extra_blob"]>,
        BlobContent
      >
    >();
    expectType<
      Equal<ContentOfResourceType<ResourceTypeSpec<string, Visits>>, Visits>
    >();

    // classify() returns the registry's name union.
    expectType<
      Equal<
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
        void new Cache(memoryStoreFor(registry), { resourceTypes: registry });
        // @ts-expect-error `resourceTypes` is required
        void new Cache(new MemoryStore(), { name: "x" });
      }
    });
  });

  describe("wrapProducer: Covered inferred from the partial record (§6.3)", () => {
    it("bounds the wrapped function's ids to the covered types and narrows per-key", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("typing-partial"),
        resourceTypes: registry,
      });
      try {
        const fetchSite = wrapProducer(cache, {}, {
          site_day: async (req) => {
            // Contextually typed per key -- narrowed, and NOT any.
            expectType<Equal<typeof req.id, SiteId>>();
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
        });

        const res = await fetchSite({ id: "site:1" });
        expectType<Equal<typeof res.content, Visits>>();
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
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("typing-two-key"),
        resourceTypes: registry,
      });
      try {
        const fetchTwo = wrapProducer(cache, {}, {
          site_day: async (req) => {
            expectType<Equal<typeof req.id, SiteId>>();
            return { content: { visits: [1, 2] }, directives: freshFor1 };
          },
          extra_blob: async (req) => {
            expectType<Equal<typeof req.id, ExtraId>>();
            return { content: { blob: "b" }, directives: freshFor1 };
          },
        });

        const visits = await fetchTwo({ id: "site:1" });
        expectType<Equal<typeof visits.content, Visits>>();
        const blob = await fetchTwo({ id: "extra:1" });
        expectType<Equal<typeof blob.content, BlobContent>>();
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

    it("rejects non-registry keys, mismatched (branch id, content) pairs, and the removed 1.6.0 options", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
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
          void wrapProducer(cache, {}, { sight_day: siteProducerStub });

          // prettier-ignore
          // @ts-expect-error extra_blob's content shape is not assignable under site_day
          void wrapProducer(cache, {}, { site_day: async () => ({ content: { blob: "x" }, directives: freshFor1 }) });

          // prettier-ignore
          // @ts-expect-error `cacheName` was deleted from WrapProducerOptions (names come from the cache + registry now)
          void wrapProducer(cache, { cacheName: "legacy" }, { site_day: siteProducerStub });

          // prettier-ignore
          // @ts-expect-error `isCacheable` was deleted (the producer purity contract, §6.3)
          void wrapProducer(cache, { isCacheable: () => false }, { site_day: siteProducerStub });
        }
      } finally {
        await cache.close();
      }
    });

    it("bare function or empty record infer Covered = never: the wrapper is uncallable", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("typing-never"),
        resourceTypes: registry,
      });
      try {
        if (false as boolean) {
          // Both constructions COMPILE (a bare function structurally matches
          // the mapped record as {}), but yield uncallable wrappers -- and
          // throw at construction time at runtime (see coverageRuntime).
          const mistake = wrapProducer(cache, {}, async (_req: { id: SiteId }) => ({
            content: { visits: [] as number[] },
            directives: freshFor1,
          }));
          // @ts-expect-error Covered = never, so no id is accepted
          void mistake({ id: "site:1" });

          const empty = wrapProducer(cache, {}, {});
          // @ts-expect-error empty coverage is equally uncallable
          void empty({ id: "site:1" });
        }
      } finally {
        await cache.close();
      }
    });

    it("wrapBulkProducer: request elements are bounded per element by the covered types", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("typing-bulk"),
        resourceTypes: registry,
      });
      try {
        const bulk = wrapBulkProducer(cache, {}, {
          site_day: async (reqs) => {
            expectType<Equal<(typeof reqs)[number]["id"], SiteId>>();
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
        });

        // A reqs array may mix COVERED types.
        const results = await bulk([{ id: "site:1" }, { id: "biz:1" }]);
        const first = results[0];
        if (!(first instanceof Error)) {
          expectType<Equal<typeof first.content, Visits>>();
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

  describe("soleResourceType's narrowed Id (§6.1, §6.4)", () => {
    const zendeskRegistry = {
      ticket_schema: soleResourceType<
        { fields: string[] },
        `zendesk-ticket-schema:${string}`
      >(),
    } satisfies ResourceTypes;
    type TicketSpec = SpecOf<typeof zendeskRegistry>;

    type SiteVisitsKey = JsonOf<{ site: string; date: string }>;
    const brandedRegistry = {
      site_day: soleResourceType<number[], SiteVisitsKey>(),
    } satisfies ResourceTypes;

    const defaultRegistry = {
      visits: soleResourceType<number[]>(),
    } satisfies ResourceTypes;

    // The narrowed Id flows through SpecOf...
    expectType<Equal<TicketSpec["id"], `zendesk-ticket-schema:${string}`>>();
    expectType<Equal<SpecOf<typeof brandedRegistry>["id"], SiteVisitsKey>>();
    // ...while the no-Id form stays `string` for unstructured-id caches.
    expectType<Equal<SpecOf<typeof defaultRegistry>["id"], string>>();

    it("rejects bare-string ids at the type level (template-literal and branded), while the default form accepts any string", async () => {
      const zendeskCache = new Cache(memoryStoreFor(zendeskRegistry), {
        name: uniqueCacheName("typing-sole-tpl"),
        resourceTypes: zendeskRegistry,
      });
      const defaultCache = new Cache(memoryStoreFor(defaultRegistry), {
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
          const rejectedBrand: SpecOf<typeof brandedRegistry>["id"] = "anything";
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
      const zendeskCache = new Cache(memoryStoreFor(zendeskRegistry), {
        name: uniqueCacheName("typing-sole-hash"),
        resourceTypes: zendeskRegistry,
      });
      const defaultCache = new Cache(memoryStoreFor(defaultRegistry), {
        name: uniqueCacheName("typing-default-hash"),
        resourceTypes: defaultRegistry,
      });
      try {
        if (false as boolean) {
          // prettier-ignore
          // @ts-expect-error hashInput returning a bare string is rejected when the sole type declares a narrowed Id
          void wrapComputingProducer(zendeskCache, {}, { ticket_schema: { hashInput: (input: { b: string }) => `nope-${input.b}`, produce: async () => ({ content: { fields: [] as string[] }, directives: freshFor1 }) } });

          // A conforming hashInput compiles...
          void wrapComputingProducer(zendeskCache, {}, {
            ticket_schema: {
              hashInput: (input: {
                b: string;
              }): `zendesk-ticket-schema:${string}` =>
                `zendesk-ticket-schema:${input.b}`,
              produce: async () => ({
                content: { fields: [] as string[] },
                directives: freshFor1,
              }),
            },
          });

          // ...and the default (un-narrowed) sole form accepts plain strings.
          void wrapComputingProducer(defaultCache, {}, {
            visits: {
              hashInput: (input: { k: string }) => `computed:${input.k}`,
              produce: async () => ({
                content: [1, 2],
                directives: freshFor1,
              }),
            },
          });
        }
      } finally {
        await zendeskCache.close();
        await defaultCache.close();
      }
    });
  });

  describe("computing branches (§6.4)", () => {
    type SiteInput = { kind: "site"; key: string };
    type BizInput = { kind: "biz"; key: string };
    type BranchedInput = SiteInput | BizInput;
    const isInput = (input: unknown): input is BranchedInput =>
      typeof input === "object" && input !== null && "kind" in input;
    const siteHash = (input: BranchedInput): SiteId => `site:${input.key}`;
    const bizHash = (input: BranchedInput): BizId => `biz:${input.key}`;
    const siteProduceFn = async (_input: BranchedInput) => ({
      content: { visits: [] as number[] },
      directives: freshFor1,
    });
    const bizProduceFn = async (_input: BranchedInput) => ({
      content: { visits: [] as number[] },
      directives: freshFor1,
    });

    it("matchesInput is required for multi-branch coverage and forbidden for single-branch coverage", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("typing-matchesinput"),
        resourceTypes: registry,
      });
      try {
        if (false as boolean) {
          // Multi-branch WITH matchesInput everywhere: compiles.
          void wrapComputingProducer(cache, {}, {
            site_day: {
              matchesInput: isInput,
              hashInput: siteHash,
              produce: siteProduceFn,
            },
            business_slice: {
              matchesInput: isInput,
              hashInput: bizHash,
              produce: bizProduceFn,
            },
          });

          // prettier-ignore
          // @ts-expect-error matchesInput is REQUIRED when the wrapper covers more than one type
          void wrapComputingProducer(cache, {}, { site_day: { matchesInput: isInput, hashInput: siteHash, produce: siteProduceFn }, business_slice: { hashInput: bizHash, produce: bizProduceFn } });

          // Single-branch WITHOUT matchesInput: compiles.
          void wrapComputingProducer(cache, {}, {
            site_day: { hashInput: siteHash, produce: siteProduceFn },
          });

          // prettier-ignore
          // @ts-expect-error matchesInput is FORBIDDEN when the wrapper covers exactly one type
          void wrapComputingProducer(cache, {}, { site_day: { matchesInput: isInput, hashInput: siteHash, produce: siteProduceFn } });
        }
      } finally {
        await cache.close();
      }
    });

    it("rejects mismatched (branch id, content) pairs in a computing branch", async () => {
      const cache = new Cache(memoryStoreFor(registry), {
        name: uniqueCacheName("typing-computing-mismatch"),
        resourceTypes: registry,
      });
      try {
        if (false as boolean) {
          // prettier-ignore
          // @ts-expect-error a site_day branch's produce must return site_day content, not extra_blob's
          void wrapComputingProducer(cache, {}, { site_day: { hashInput: siteHash, produce: async (_input: BranchedInput) => ({ content: { blob: "x" }, directives: freshFor1 }) } });
        }
      } finally {
        await cache.close();
      }
    });
  });

  describe("TypedChannel export (§6.5)", () => {
    // The public typed-channel objects carry the message and literal channel
    // name types through subscribe.
    expectType<
      Equal<
        Parameters<(typeof cacheReadChannel)["subscribe"]>[0],
        (message: CacheReadMessage, name: "@zingage/cache:read") => void
      >
    >();

    it("compiles", () => {});
  });
});
