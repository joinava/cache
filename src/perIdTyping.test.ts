import { expect } from "chai";
import { describe, it } from "node:test";
import type { JsonOf } from "type-party";
import { jsonStringify } from "type-party/runtime/json.js";

import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import type { CacheSpec } from "./types/00_CacheSpec.js";
import {
  idStartsWith,
  resourceType,
  soleResourceType,
  type ResourceTypes,
  type SpecOf,
} from "./types/00_ResourceTypes.js";
import type {
  MultiIdTypeRequestPairedProducer,
  SingleIdTypeRequestPairedProducer,
} from "./types/05_RequestPairedProducer.js";
import type {
  AnyParams,
  AnyValidators,
  RequestPairedProducer,
} from "./types/index.js";
import type { IsSingleType } from "./types/utils.js";
import { NoProducerForResourceTypeError } from "./utils/wrapProducer.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * Compile-time assertion utilities. These never run -- they're consumed only
 * by `tsc -b --noEmit` -- but writing them inline keeps the per-id typing
 * tests legible alongside the runtime behavior tests.
 */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
const expectType = <_T extends true>(): void => {};

/**
 * Sample domain for per-id-typing tests:
 *
 * - id `story:${string}` returns a single `Story`,
 * - id `collection:${string}` returns a `Story[]` (a collection of stories).
 *
 * Both kinds of resources live in the same cache, as two named resource
 * types whose guards partition the id space.
 */
type Story = { readonly id: string; readonly title: string };

const storiesResourceTypes = {
  story: resourceType<Story>()({ matches: idStartsWith("story:") }),
  collection: resourceType<Story[]>()({
    matches: idStartsWith("collection:"),
  }),
} satisfies ResourceTypes;

type StoriesCacheSpec =
  | CacheSpec<`story:${string}`, Story>
  | CacheSpec<`collection:${string}`, Story[]>;

const storiesCacheOptions = {
  name: "per-id-typing-test",
  resourceTypes: storiesResourceTypes,
};

describe("Per-id content typing", () => {
  // --------------------------------------------------------------------
  // Pure type-level checks. Each `describe` below contains compile-time
  // assertions (via `expectType<Equal<...>>()`) plus a tiny `it("compiles")`
  // marker so the suite shows up in test output. These run as no-ops at
  // runtime; their value is that they fail to *typecheck* if the public
  // surface of the per-id-typing machinery regresses.
  // --------------------------------------------------------------------
  describe("Type-level: SpecOf derives the spec union from the registry", () => {
    // THE derivation: the cache's Spec union is computed from the registry
    // rather than declared beside it, so the two can't drift.
    expectType<Equal<SpecOf<typeof storiesResourceTypes>, StoriesCacheSpec>>();

    it("compiles", () => {});
  });

  describe("Type-level: IsSingleType<Spec>", () => {
    // Single CacheSpec variant -- the "single-id-type mode" condition.
    expectType<Equal<IsSingleType<CacheSpec>, true>>();
    expectType<Equal<IsSingleType<CacheSpec<string, Story>>, true>>();
    expectType<
      Equal<IsSingleType<CacheSpec<`story:${string}`, Story>>, true>
    >();
    // A single CacheSpec whose id is a union of literals is still a
    // single variant (uniform content), so it's classified single-id-type.
    expectType<Equal<IsSingleType<CacheSpec<"a" | "b", Story>>, true>>();

    // Union of CacheSpec variants -- the "multi-id-type mode" condition.
    expectType<
      Equal<
        IsSingleType<CacheSpec<"a", Story> | CacheSpec<"b", Story[]>>,
        false
      >
    >();
    expectType<Equal<IsSingleType<StoriesCacheSpec>, false>>();

    it("compiles", () => {});
  });

  describe("Type-level: RequestPairedProducer dispatches by mode", () => {
    type SingleSpec = CacheSpec<`story:${string}`, Story>;
    type MultiSpec = StoriesCacheSpec;

    // Single-id-type mode: the public type resolves to the non-generic form.
    expectType<
      Equal<
        RequestPairedProducer<SingleSpec, AnyValidators, AnyParams>,
        SingleIdTypeRequestPairedProducer<SingleSpec, AnyValidators, AnyParams>
      >
    >();
    // ...and is *not* the generic multi-id form.
    expectType<
      Equal<
        Equal<
          RequestPairedProducer<SingleSpec, AnyValidators, AnyParams>,
          MultiIdTypeRequestPairedProducer<SingleSpec, AnyValidators, AnyParams>
        >,
        false
      >
    >();

    // Multi-id-type mode: the public type resolves to the generic form.
    expectType<
      Equal<
        RequestPairedProducer<MultiSpec, AnyValidators, AnyParams>,
        MultiIdTypeRequestPairedProducer<MultiSpec, AnyValidators, AnyParams>
      >
    >();
    // ...and is *not* the non-generic single-id form.
    expectType<
      Equal<
        Equal<
          RequestPairedProducer<MultiSpec, AnyValidators, AnyParams>,
          SingleIdTypeRequestPairedProducer<MultiSpec, AnyValidators, AnyParams>
        >,
        false
      >
    >();

    it("compiles", () => {});
  });

  describe("Type-level: wrapProducer coverage inference", () => {
    // Coverage (`Covered`) is inferred from the producers record's keys --
    // any non-empty subset of the registry -- and bounds the wrapped
    // function's request ids. These checks mirror the acceptance criteria:
    // covered ids accepted; uncovered ids and plain `string` rejected;
    // producer `req` contextually narrowed per key; non-registry keys
    // rejected; a bare function or empty record infers `Covered = never`
    // (an uncallable wrapper).
    it("bounds the wrapped function's ids to the covered types", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        // Partial coverage: only `story` is covered.
        const fetchStory = wrapProducer(cache, undefined, {
          story: async (req) => {
            // (b) contextually typed, not any/string:
            expectType<Equal<typeof req.id, `story:${string}`>>();
            return {
              content: { id: req.id, title: "x" } satisfies Story,
              directives: { freshUntilAge: 1 },
              // (e) supplementals may target UNCOVERED types:
              supplementalResources: [
                {
                  id: "collection:related",
                  content: [] satisfies Story[],
                  directives: { freshUntilAge: 1 },
                },
              ],
            };
          },
        });

        const res = await fetchStory({ id: "story:1" });
        expectType<Equal<typeof res.content, Story>>();
        expect(res.content).to.deep.equal({ id: "story:1", title: "x" });

        declareTypeOnly(() => {
          const collectionId = null as unknown as `collection:${string}`;
          // @ts-expect-error -- uncovered type's id must be rejected at the call site
          void fetchStory({ id: collectionId });
          const looseId = null as unknown as string;
          // @ts-expect-error -- plain string must be rejected too
          void fetchStory({ id: looseId });
        });
      } finally {
        await cache.close();
      }
    });

    it("rejects non-registry keys, mismatched contents, and keyless records at compile time", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        if (false as boolean) {
          wrapProducer(cache, undefined, {
            // @ts-expect-error -- 'sotry' is not a registry type name
            sotry: async (req: { id: `story:${string}` }) => ({
              content: { id: req.id, title: "x" } satisfies Story,
              directives: { freshUntilAge: 1 },
            }),
          });

          wrapProducer(cache, undefined, {
            // @ts-expect-error -- the story producer must return Story content, not Story[]
            story: async (_req) => ({
              content: [] as Story[],
              directives: { freshUntilAge: 1 },
            }),
            collection: async (_req) => ({
              content: [] satisfies Story[],
              directives: { freshUntilAge: 1 },
            }),
          });

          // A bare function structurally matches the record type as `{}`
          // (Covered = never): accepted at the wrap site, but the returned
          // wrapper is uncallable -- and construction throws at runtime.
          const mistake = wrapProducer(
            cache,
            undefined,
            async (req: { id: `story:${string}` }) => ({
              content: { id: req.id, title: "x" } satisfies Story,
              directives: { freshUntilAge: 1 },
            }),
          );
          // @ts-expect-error Covered = never, so no id is accepted
          void mistake({ id: "story:1" });

          const empty = wrapProducer(cache, undefined, {});
          // @ts-expect-error empty coverage is equally uncallable
          void empty({ id: "story:1" });
        }
      } finally {
        await cache.close();
      }
    });
  });

  describe("Type-level: soleResourceType", () => {
    // `Id` (default string) narrows the sole type's id space at the type
    // level; the runtime guard stays trivially true.
    type ZendeskSchemaId = `zendesk-ticket-schema:${string}`;

    const narrowedRts = {
      ticket_schema: soleResourceType<{ fields: string[] }, ZendeskSchemaId>(),
    } satisfies ResourceTypes;
    type TicketSpec = SpecOf<typeof narrowedRts>;

    // The narrowed Id flows through SpecOf...
    expectType<Equal<TicketSpec["id"], ZendeskSchemaId>>();
    expectType<Equal<TicketSpec["content"], { fields: string[] }>>();

    declareTypeOnly(() => {
      const bare = null as unknown as string;
      // @ts-expect-error bare string must NOT satisfy the narrowed sole id
      const rejected: TicketSpec["id"] = bare;
      void rejected;
      const acceptsLiteral: TicketSpec["id"] = "zendesk-ticket-schema:b1:abc";
      void acceptsLiteral;
    });

    // ...while the no-`Id` form still accepts any string.
    const defaultRts = {
      visits: soleResourceType<number[]>(),
    } satisfies ResourceTypes;
    expectType<Equal<SpecOf<typeof defaultRts>["id"], string>>();

    it("compiles (and the runtime guard accepts every id)", () => {
      expect(narrowedRts.ticket_schema.matches("anything at all")).to.eq(true);
    });
  });

  describe("Type-level: idStartsWith", () => {
    type AllIds = `story:${string}` | `collection:${string}`;
    const isStory = idStartsWith("story:");

    it("narrows a union id to the matching template-literal constituent", () => {
      const id = "story:abc" as AllIds;
      if (isStory(id)) {
        // Inside the guarded block, `id` is narrowed to the `story:*`
        // constituent, NOT widened to `string`.
        expectType<Equal<typeof id, `story:${string}`>>();
      } else {
        expectType<Equal<typeof id, `collection:${string}`>>();
      }
    });

    it("plays nicely with non-overlapping prefixes (returns false at runtime)", () => {
      const id = "collection:home" as AllIds;
      expect(isStory(id)).to.eq(false);
    });
  });

  // --------------------------------------------------------------------
  // Mixed runtime + compile-time tests follow. These exercise the same
  // machinery against an actual `Cache` / `wrapProducer` to confirm the
  // type-level guarantees above hold end-to-end.
  // --------------------------------------------------------------------
  describe("Cache.classify", () => {
    it("classifies each id to its own resource type", () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      expect(cache.classify("story:1")).to.eq("story");
      expect(cache.classify("collection:top")).to.eq("collection");
      expectType<
        Equal<ReturnType<typeof cache.classify>, "story" | "collection">
      >();
      void cache.close();
    });
  });

  describe("Cache.get", () => {
    it("narrows the result content based on the request id", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        const story1 = { id: "1", title: "Hello" };
        const story2 = { id: "2", title: "World" };

        await cache.store([
          {
            id: "story:1",
            content: story1,
            directives: { freshUntilAge: 100 },
          },
          {
            id: "collection:top",
            content: [story1, story2],
            directives: { freshUntilAge: 100 },
          },
        ]);

        const storyRes = await cache.get({
          id: "story:1",
          params: {},
          directives: {},
        });
        const collectionRes = await cache.get({
          id: "collection:top",
          params: {},
          directives: {},
        });

        // Compile-time: storyRes.usable.content is Story | undefined
        expectType<
          Equal<typeof storyRes.usable, undefined> extends true
            ? true
            : Equal<NonNullable<typeof storyRes.usable>["content"], Story>
        >();
        // Compile-time: collectionRes.usable.content is Story[] | undefined
        expectType<
          Equal<typeof collectionRes.usable, undefined> extends true
            ? true
            : Equal<
                NonNullable<typeof collectionRes.usable>["content"],
                Story[]
              >
        >();

        expect(storyRes.usable?.content).to.deep.equal(story1);
        expect(collectionRes.usable?.content).to.deep.equal([story1, story2]);
      } finally {
        await cache.close();
      }
    });

    it("rejects mismatched (id, content) pairs in cache.store", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        // Compile-time only: this call is guarded by `if (false)` so the
        // runtime doesn't actually try to store the bogus value, but TS is
        // asked to typecheck it. The expected behavior is a TS error,
        // expressed via @ts-expect-error.
        if (false as boolean) {
          await cache.store([
            // @ts-expect-error -- Story[] is not assignable to Story under story:*
            {
              id: "story:bogus",
              content: [] as Story[],
              directives: { freshUntilAge: 1 },
            },
          ]);
        }
      } finally {
        await cache.close();
      }
    });
  });

  describe("Cache.getMany", () => {
    it("narrows the result content per request id (tuple typing)", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        const story = { id: "42", title: "Mixed" };
        await cache.store([
          {
            id: "story:42",
            content: story,
            directives: { freshUntilAge: 100 },
          },
          {
            id: "collection:hot",
            content: [story],
            directives: { freshUntilAge: 100 },
          },
        ]);

        const [storyRes, collectionRes] = await cache.getMany([
          { id: "story:42", params: {}, directives: {} },
          { id: "collection:hot", params: {}, directives: {} },
        ] as const);

        expectType<
          Equal<NonNullable<typeof storyRes.usable>["content"], Story>
        >();
        expectType<
          Equal<NonNullable<typeof collectionRes.usable>["content"], Story[]>
        >();

        expect(storyRes.usable?.content).to.deep.equal(story);
        expect(collectionRes.usable?.content).to.deep.equal([story]);
      } finally {
        await cache.close();
      }
    });
  });

  describe("wrapProducer", () => {
    it("narrows the wrapped producer's return based on the request id", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        // With a multi-type registry, each producer in the record is
        // non-generic: its `req.id` is the covered type's concrete
        // (template-literal or branded) id type, so TypeScript fully checks
        // the (id, content) correlation per entry with no user-side casts.
        const fetcher = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          {
            story: async (req) => ({
              content: {
                id: req.id,
                title: `Story ${req.id}`,
              } satisfies Story,
              directives: { freshUntilAge: 1 },
            }),
            collection: async (_req) => ({
              content: [
                { id: "1", title: "a" },
                { id: "2", title: "b" },
              ] satisfies Story[],
              directives: { freshUntilAge: 1 },
            }),
          },
        );

        const storyResult = await fetcher({ id: "story:abc" });
        const collectionResult = await fetcher({ id: "collection:home" });

        // Compile-time: per-id content narrowing.
        expectType<Equal<typeof storyResult.content, Story>>();
        expectType<Equal<typeof collectionResult.content, Story[]>>();

        expect(storyResult.content).to.deep.equal({
          id: "story:abc",
          title: "Story story:abc",
        });
        expect(collectionResult.content).to.deep.equal([
          { id: "1", title: "a" },
          { id: "2", title: "b" },
        ]);
      } finally {
        await cache.close();
      }
    });

    it("serves each type independently from two partial wrappers over one cache", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        const fetchStory = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          {
            story: async (req) => ({
              content: { id: req.id, title: "from-story-wrapper" },
              directives: { freshUntilAge: 100 },
            }),
          },
        );
        const fetchCollection = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          {
            collection: async (_req) => ({
              content: [{ id: "c", title: "from-collection-wrapper" }],
              directives: { freshUntilAge: 100 },
            }),
          },
        );

        const story = await fetchStory({ id: "story:s" });
        const collection = await fetchCollection({ id: "collection:c" });
        expect(story.content.title).to.eq("from-story-wrapper");
        expect(collection.content[0]?.title).to.eq("from-collection-wrapper");
      } finally {
        await cache.close();
      }
    });

    it("throws NoProducerForResourceTypeError, before any cache read, for a (cast) uncovered id", async () => {
      const store = new MemoryStore<StoriesCacheSpec>();
      let storeGetCalls = 0;
      const origGet = store.get.bind(store);
      store.get = ((...args: Parameters<typeof origGet>) => {
        storeGetCalls++;
        return origGet(...args);
      }) as typeof store.get;

      const cache = new Cache(store, storiesCacheOptions);
      try {
        const fetchStory = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          {
            story: async (req) => ({
              content: { id: req.id, title: "x" },
              directives: { freshUntilAge: 1 },
            }),
          },
        );

        // Reachable only via a cast (the wrapped function's request type
        // bans uncovered ids at compile time):
        await fetchStory({
          id: "collection:top" as `story:${string}`,
        }).then(
          () => {
            throw new Error("should have rejected");
          },
          (e: unknown) => {
            expect(e).to.be.instanceOf(NoProducerForResourceTypeError);
            const err = e as NoProducerForResourceTypeError;
            expect(err.resourceType).to.eq("collection");
            expect(err.coveredResourceTypes).to.deep.eq(["story"]);
            expect(err.id).to.eq("collection:top");
            expect(err.cacheName).to.eq("per-id-typing-test");
          },
        );

        // ...and the store was never read.
        expect(storeGetCalls).to.eq(0);
      } finally {
        await cache.close();
      }
    });

    it("supports caching supplemental resources of a different resource type", async () => {
      const cache = new Cache(new MemoryStore<StoriesCacheSpec>(), storiesCacheOptions);
      try {
        const story1: Story = { id: "1", title: "First" };
        const story2: Story = { id: "2", title: "Second" };

        const fetcher = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          {
            collection: async (_req) => ({
              content: [story1, story2] satisfies Story[],
              directives: { freshUntilAge: 100 },
              // Supplemental resources can target a *different* resource
              // type than the request's (here: individual stories under a
              // request for a collection) -- including types this wrapper
              // doesn't cover.
              supplementalResources: [
                {
                  id: "story:1",
                  content: story1,
                  directives: { freshUntilAge: 100 },
                },
                {
                  id: "story:2",
                  content: story2,
                  directives: { freshUntilAge: 100 },
                },
              ],
            }),
          },
        );

        // Fetching the collection should also cache the individual stories.
        const collectionResult = await fetcher({ id: "collection:top" });
        expect(collectionResult.content).to.deep.equal([story1, story2]);

        // Now fetch one of the individual stories: it should come from the
        // cache (no second producer call), with the correctly-typed content.
        const storyHit = await cache.get({
          id: "story:1",
          params: {},
          directives: {},
        });
        expectType<
          Equal<NonNullable<typeof storyHit.usable>["content"], Story>
        >();
        expect(storyHit.usable?.content).to.deep.equal(story1);
      } finally {
        await cache.close();
      }
    });
  });

  /**
   * Sometimes id types aren't distinguishable by template-literal structure,
   * but rather by a brand/tag attached to the string. {@link JsonOf} from
   * `type-party` is a common example: `JsonOf<T>` is `Tagged<string, "JSON",
   * T>`, so two `JsonOf<T1>` and `JsonOf<T2>` with different `T`s are both
   * structurally `string` but are NOT mutually assignable.
   *
   * The cache's per-id narrowing should treat these the same way it treats
   * template-literal-keyed registries. (For branded ids, the registry guards
   * inspect the ids' runtime structure -- here, the parsed JSON's keys.)
   */
  describe("with tagged/branded string keys", () => {
    type StoryKey = JsonOf<{ story: string }>;
    type CollectionKey = JsonOf<{ collection: string }>;

    const brandedResourceTypes = {
      story: resourceType<Story>()({
        matches: (id: string): id is StoryKey =>
          "story" in (JSON.parse(id) as object),
      }),
      collection: resourceType<Story[]>()({
        matches: (id: string): id is CollectionKey =>
          "collection" in (JSON.parse(id) as object),
      }),
    } satisfies ResourceTypes;

    const brandedCacheOptions = {
      name: "per-id-typing-branded-test",
      resourceTypes: brandedResourceTypes,
    };
    type BrandedSpec = SpecOf<typeof brandedResourceTypes>;

    // Compile-time only: confirm that the two branded ids are mutually
    // non-assignable. (If TS ever changed this, the rest of the per-id
    // narrowing for branded keys would be silently broken.)
    expectType<Equal<StoryKey extends CollectionKey ? true : false, false>>();
    expectType<Equal<CollectionKey extends StoryKey ? true : false, false>>();

    it("narrows the result content based on the branded request id", async () => {
      const cache = new Cache(new MemoryStore<BrandedSpec>(), brandedCacheOptions);
      try {
        const story: Story = { id: "1", title: "Hello" };
        const storyId = jsonStringify({
          story: "1",
        }) satisfies string as StoryKey;
        const collectionId = jsonStringify({
          collection: "top",
        }) satisfies string as CollectionKey;

        await cache.store([
          {
            id: storyId,
            content: story,
            directives: { freshUntilAge: 100 },
          },
          {
            id: collectionId,
            content: [story],
            directives: { freshUntilAge: 100 },
          },
        ]);

        const storyRes = await cache.get({
          id: storyId,
          params: {},
          directives: {},
        });
        const collectionRes = await cache.get({
          id: collectionId,
          params: {},
          directives: {},
        });

        // Compile-time: branded id narrowing flows through to .content.
        expectType<
          Equal<NonNullable<typeof storyRes.usable>["content"], Story>
        >();
        expectType<
          Equal<NonNullable<typeof collectionRes.usable>["content"], Story[]>
        >();

        expect(storyRes.usable?.content).to.deep.equal(story);
        expect(collectionRes.usable?.content).to.deep.equal([story]);
      } finally {
        await cache.close();
      }
    });

    it("rejects mismatched branded (id, content) pairs in cache.store", async () => {
      const cache = new Cache(new MemoryStore<BrandedSpec>(), brandedCacheOptions);
      try {
        const storyId = jsonStringify({
          story: "bogus",
        }) satisfies string as StoryKey;
        // Compile-time-only check: storing a Story[] under a StoryKey is
        // rejected even though the keys are not template-literal-distinct.
        if (false as boolean) {
          await cache.store([
            // @ts-expect-error -- Story[] not assignable to Story under StoryKey
            {
              id: storyId,
              content: [] as Story[],
              directives: { freshUntilAge: 1 },
            },
          ]);
        }
      } finally {
        await cache.close();
      }
    });

    it("narrows wrapProducer's return type for branded ids", async () => {
      const cache = new Cache(new MemoryStore<BrandedSpec>(), brandedCacheOptions);
      try {
        const storyId = jsonStringify({
          story: "abc",
        }) satisfies string as StoryKey;
        const collectionId = jsonStringify({
          collection: "home",
        }) satisfies string as CollectionKey;

        // Each producer's `req.id` is the covered type's branded id, so the
        // handler's return is required to be content for that type.
        const fetcher = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          {
            story: async (req) => {
              expectType<Equal<typeof req.id, StoryKey>>();
              const parsed = JSON.parse(req.id) as { story: string };
              return {
                content: {
                  id: parsed.story,
                  title: `Story ${parsed.story}`,
                } satisfies Story,
                directives: { freshUntilAge: 1 },
              };
            },
            collection: async (req) => {
              expectType<Equal<typeof req.id, CollectionKey>>();
              const parsed = JSON.parse(req.id) as { collection: string };
              return {
                content: [
                  { id: parsed.collection, title: "first" },
                ] satisfies Story[],
                directives: { freshUntilAge: 1 },
              };
            },
          },
        );

        const storyResult = await fetcher({ id: storyId });
        const collectionResult = await fetcher({ id: collectionId });

        expectType<Equal<typeof storyResult.content, Story>>();
        expectType<Equal<typeof collectionResult.content, Story[]>>();

        expect(storyResult.content).to.deep.equal({
          id: "abc",
          title: "Story abc",
        });
        expect(collectionResult.content).to.deep.equal([
          { id: "home", title: "first" },
        ]);
      } finally {
        await cache.close();
      }
    });
  });
});

/**
 * Helper for writing type-level-only assertions that need `declare const`
 * bindings: the callback is never invoked, it just has to typecheck.
 */
function declareTypeOnly(_fn: () => void): void {}
