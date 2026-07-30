import { expect } from "chai";
import { describe, it } from "node:test";
import type { JsonOf } from "type-party";
import { jsonStringify } from "type-party/runtime/json.js";

import {
  expectType,
  memoryStoreFor,
  type Equal,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  idStartsWith,
  producerByIdType,
  resourceType,
  type ResourceTypes,
  type SpecOf,
} from "./index.js";
import type { CacheSpec } from "./types/00_CacheSpec.js";
import wrapProducer from "./utils/wrapProducer.js";

/**
 * Sample domain for per-id-typing tests:
 *
 * - id `story:${string}` returns a single `Story`,
 * - id `collection:${string}` returns a `Story[]` (a collection of stories).
 *
 * Both kinds of resources live in the same cache. The cache's `Spec` union is
 * derived from the resource-type registry rather than hand-declared; the
 * `Equal` bridge below pins that the derivation produces exactly the union you
 * would otherwise have written out.
 */
type Story = { readonly id: string; readonly title: string };

const storiesRegistry = {
  story: resourceType<Story>()({ matches: idStartsWith("story:") }),
  collection: resourceType<Story[]>()({ matches: idStartsWith("collection:") }),
} satisfies ResourceTypes;
type StoriesCacheSpec = SpecOf<typeof storiesRegistry>;

const makeStoriesCache = () =>
  new Cache({
    store: memoryStoreFor(storiesRegistry),
    name: "per-id-typing-test",
    resourceTypes: storiesRegistry,
  });

describe("Per-id content typing", () => {
  // --------------------------------------------------------------------
  // Pure type-level checks. Each `describe` below contains compile-time
  // assertions (via `expectType<Equal<...>>()`) plus a tiny `it("compiles")`
  // marker so the suite shows up in test output. These run as no-ops at
  // runtime; their value is that they fail to *typecheck* if the public
  // surface of the per-id-typing machinery regresses.
  // --------------------------------------------------------------------
  describe("Type-level: SpecOf derivation matches the hand-written union", () => {
    expectType<
      Equal<
        StoriesCacheSpec,
        | CacheSpec<`story:${string}`, Story>
        | CacheSpec<`collection:${string}`, Story[]>
      >
    >();

    it("compiles", () => {});
  });

  describe("Producer shape for a sole-type cache", () => {
    it("accepts a plain async lambda producer for a sole-type cache", () => {
      // A sole-type cache's one producer covers the whole registry, so it goes
      // in bare: a vanilla `async (req) => ({...})` lambda satisfies the
      // wrapper directly, with no record and no dispatch helper.
      const soleRegistry = {
        entries: resourceType<string>()({
          matches: (id): id is string => typeof id === "string",
        }),
      } satisfies ResourceTypes;
      const cache = new Cache({
        store: memoryStoreFor(soleRegistry),
        name: "per-id-sole-type-test",
        resourceTypes: soleRegistry,
      });
      try {
        const _f = wrapProducer(cache, {}, async (req) => ({
          content: req.id,
          directives: { freshUntilAge: 1 },
        }));
        void _f;
      } finally {
        void cache.close();
      }
    });
  });

  // `producerByIdType` turns a per-resource-type record into one covering
  // function, inferring coverage from the record's keys. Its typing is covered
  // in coverageTyping.test.ts and its runtime in coverageRuntime.test.ts.

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
      // No type narrowing in the false branch beyond what Extract gives;
      // the runtime check is what matters here.
      expect(isStory(id)).to.eq(false);
    });
  });

  // --------------------------------------------------------------------
  // Mixed runtime + compile-time tests follow. These exercise the same
  // machinery against an actual `Cache` / `wrapProducer` to confirm the
  // type-level guarantees above hold end-to-end.
  // --------------------------------------------------------------------
  describe("Cache.get", () => {
    it("narrows the result content based on the request id", async () => {
      const cache = makeStoriesCache();
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
      const cache = makeStoriesCache();
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
      const cache = makeStoriesCache();
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
      const cache = makeStoriesCache();
      try {
        // With a multi-type registry, the per-id-typed producer is written as
        // a per-resource-type record routed through `producerByIdType`: each
        // entry's producer is non-generic over its own branch's id, so
        // TypeScript fully checks the (id, content) correlation per branch with
        // no user-side casts.
        const fetcher = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          producerByIdType(cache, {
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
          }),
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

    it("supports caching supplemental resources of a different spec variant", async () => {
      const cache = makeStoriesCache();
      try {
        const story1: Story = { id: "1", title: "First" };
        const story2: Story = { id: "2", title: "Second" };

        const fetcher = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          producerByIdType(cache, {
            collection: async (_req) => ({
              content: [story1, story2] satisfies Story[],
              directives: { freshUntilAge: 100 },
              // Supplemental resources can target a *different* spec
              // variant than the request's id (here: individual stories
              // under a request for a collection).
              supplementalResources: [
                {
                  id: "story:1" as const,
                  content: story1,
                  directives: { freshUntilAge: 100 },
                },
                {
                  id: "story:2" as const,
                  content: story2,
                  directives: { freshUntilAge: 100 },
                },
              ],
            }),
            // Not reached in this test, but included to show record coverage
            // of both types alongside the supplemental writes.
            story: async (req) => ({
              content: { id: req.id, title: "fallback" } satisfies Story,
              directives: { freshUntilAge: 1 },
            }),
          }),
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
   * template-literal-keyed registries. This mirrors the design doc's own §6.1
   * authoring pattern: JSON-parsing guards over branded JSON-string ids.
   */
  describe("with tagged/branded string keys", () => {
    type StoryKey = JsonOf<{ story: string }>;
    type CollectionKey = JsonOf<{ collection: string }>;

    const isStoryKey = (id: string): id is StoryKey =>
      "story" in (JSON.parse(id) as object);
    const isCollectionKey = (id: string): id is CollectionKey =>
      "collection" in (JSON.parse(id) as object);

    const brandedRegistry = {
      story: resourceType<Story>()({ matches: isStoryKey }),
      collection: resourceType<Story[]>()({ matches: isCollectionKey }),
    } satisfies ResourceTypes;

    const makeBrandedCache = () =>
      new Cache({
        store: memoryStoreFor(brandedRegistry),
        name: "per-id-branded-test",
        resourceTypes: brandedRegistry,
      });

    // Compile-time only: confirm that the two branded ids are mutually
    // non-assignable. (If TS ever changed this, the rest of the per-id
    // narrowing for branded keys would be silently broken.)
    expectType<Equal<StoryKey extends CollectionKey ? true : false, false>>();
    expectType<Equal<CollectionKey extends StoryKey ? true : false, false>>();

    it("narrows the result content based on the branded request id", async () => {
      const cache = makeBrandedCache();
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
      const cache = makeBrandedCache();
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
      const cache = makeBrandedCache();
      try {
        const storyId = jsonStringify({
          story: "abc",
        }) satisfies string as StoryKey;
        const collectionId = jsonStringify({
          collection: "home",
        }) satisfies string as CollectionKey;

        // For branded keys the registry guards do the structural runtime
        // check; each branch's producer receives `req.id` narrowed to its
        // branch's branded key, and its return is required to be content for
        // that variant.
        const fetcher = wrapProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          producerByIdType(cache, {
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
          }),
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
