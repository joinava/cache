import { expect } from "chai";
import { describe, it } from "node:test";
import type { JsonOf } from "type-party";
import { jsonStringify } from "type-party/runtime/json.js";

import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import type { CacheSpec } from "./types/00_CacheSpec.js";
import type {
  MultiIdTypeRequestPairedProducer,
  SingleIdTypeRequestPairedProducer,
} from "./types/05_RequestPairedProducer.js";
import type {
  AnyParams,
  AnyValidators,
  RequestPairedProducer,
  RequestPairedProducerResult,
} from "./types/index.js";
import type { IsSingleType } from "./types/utils.js";
import {
  idStartsWith,
  producerByIdType,
  type ProducerByIdTypeBuilder,
} from "./utils/producerByIdType.js";
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
 * Both kinds of resources live in the same cache.
 */
type Story = { readonly id: string; readonly title: string };
type StoriesCacheSpec =
  | CacheSpec<`story:${string}`, Story>
  | CacheSpec<`collection:${string}`, Story[]>;

describe("Per-id content typing", () => {
  // --------------------------------------------------------------------
  // Pure type-level checks. Each `describe` below contains compile-time
  // assertions (via `expectType<Equal<...>>()`) plus a tiny `it("compiles")`
  // marker so the suite shows up in test output. These run as no-ops at
  // runtime; their value is that they fail to *typecheck* if the public
  // surface of the per-id-typing machinery regresses.
  // --------------------------------------------------------------------
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

    it("accepts a plain async lambda for a single-id-type spec", () => {
      type Spec = CacheSpec<string, string>;
      const cache = new Cache<Spec>(new MemoryStore());
      try {
        // No `producerByIdType` needed: in single-id-type mode the
        // producer is a plain non-generic function, and a vanilla
        // `async (req) => ({...})` lambda satisfies it.
        const _f = wrapProducer<Spec>(cache, {}, async (req) => ({
          content: req.id,
          directives: { freshUntilAge: 1 },
        }));
        void _f;
      } finally {
        void cache.close();
      }
    });
  });

  describe("Type-level: producerByIdType builder", () => {
    describe("Covered union accumulation", () => {
      // An empty builder has covered nothing yet.
      const empty = producerByIdType<StoriesCacheSpec>();
      expectType<
        Equal<
          typeof empty,
          ProducerByIdTypeBuilder<
            StoriesCacheSpec,
            AnyValidators,
            AnyParams,
            never
          >
        >
      >();

      // After one `.when(...)`, the covered union grows to that branch's
      // narrowed id.
      const oneBranch = empty.when(
        idStartsWith("story:"),
        async (req) => ({
          content: { id: req.id, title: "x" } satisfies Story,
          directives: { freshUntilAge: 1 },
        }),
      );
      expectType<
        Equal<
          typeof oneBranch,
          ProducerByIdTypeBuilder<
            StoriesCacheSpec,
            AnyValidators,
            AnyParams,
            `story:${string}`
          >
        >
      >();

      // After both `.when(...)` calls, the covered union equals
      // `Spec["id"]`, satisfying the exhaustiveness check.
      const twoBranches = oneBranch.when(
        idStartsWith("collection:"),
        async (_req) => ({
          content: [] satisfies Story[],
          directives: { freshUntilAge: 1 },
        }),
      );
      expectType<
        Equal<
          typeof twoBranches,
          ProducerByIdTypeBuilder<
            StoriesCacheSpec,
            AnyValidators,
            AnyParams,
            `story:${string}` | `collection:${string}`
          >
        >
      >();

      it("compiles", () => {});
    });

    describe(".build() return type by builder state", () => {
      type ExhaustivenessError<Missing> = readonly [
        "producerByIdType: builder is non-exhaustive; missing `.when(...)` branches for these ids:",
        Missing,
      ];

      // Empty builder: missing both spec variants.
      const empty = producerByIdType<StoriesCacheSpec>();
      expectType<
        Equal<
          ReturnType<typeof empty.build>,
          ExhaustivenessError<`story:${string}` | `collection:${string}`>
        >
      >();

      // Partial builder: missing only the un-covered variant.
      const partial = producerByIdType<StoriesCacheSpec>().when(
        idStartsWith("story:"),
        async (req) => ({
          content: { id: req.id, title: "x" } satisfies Story,
          directives: { freshUntilAge: 1 },
        }),
      );
      expectType<
        Equal<
          ReturnType<typeof partial.build>,
          ExhaustivenessError<`collection:${string}`>
        >
      >();

      // Fully exhaustive builder: `.build()` returns a real
      // `RequestPairedProducer`.
      const full = partial.when(
        idStartsWith("collection:"),
        async (_req) => ({
          content: [] satisfies Story[],
          directives: { freshUntilAge: 1 },
        }),
      );
      expectType<
        Equal<
          ReturnType<typeof full.build>,
          RequestPairedProducer<StoriesCacheSpec, AnyValidators, AnyParams>
        >
      >();

      it("compiles", () => {});
    });

    it("narrows handler arguments and return types per branch", () => {
      // Inline compile-time assertions inside each handler confirm that
      // `req.id` is the narrowed branch id, and that the handler's
      // (declared) return type is exactly the result for that variant.
      const _producer = producerByIdType<StoriesCacheSpec>()
        .when(idStartsWith("story:"), async (req) => {
          expectType<Equal<typeof req.id, `story:${string}`>>();
          const result: RequestPairedProducerResult<
            StoriesCacheSpec,
            AnyValidators,
            AnyParams,
            `story:${string}`
          > = {
            content: { id: req.id, title: "x" },
            directives: { freshUntilAge: 1 },
          };
          // The result's `content` slot is `Story`, not `Story | Story[]`.
          expectType<Equal<typeof result.content, Story>>();
          return result;
        })
        .when(idStartsWith("collection:"), async (req) => {
          expectType<Equal<typeof req.id, `collection:${string}`>>();
          const result: RequestPairedProducerResult<
            StoriesCacheSpec,
            AnyValidators,
            AnyParams,
            `collection:${string}`
          > = {
            content: [],
            directives: { freshUntilAge: 1 },
          };
          expectType<Equal<typeof result.content, Story[]>>();
          return result;
        })
        .build();
      void _producer;
    });

    it("rejects mismatched (id, content) pairs inside a `.when(...)` branch", () => {
      // Compile-time-only: per-branch (id, content) correlation is checked
      // by `.when`'s handle parameter. Returning Story[] from the `story:*`
      // branch should be rejected at the offending `.when(...)` call.
      if (false as boolean) {
        producerByIdType<StoriesCacheSpec>()
          // @ts-expect-error -- Story[] not assignable to Story under `story:*`
          .when(idStartsWith("story:"), async (_req) => ({
            content: [] as Story[],
            directives: { freshUntilAge: 1 },
          }))
          .when(idStartsWith("collection:"), async (_req) => ({
            content: [] satisfies Story[],
            directives: { freshUntilAge: 1 },
          }))
          .build();
      }
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
      const cache = new Cache<StoriesCacheSpec>(new MemoryStore());
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
      const cache = new Cache<StoriesCacheSpec>(new MemoryStore());
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
      const cache = new Cache<StoriesCacheSpec>(new MemoryStore());
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
      const cache = new Cache<StoriesCacheSpec>(new MemoryStore());
      try {
        // With multi-id-type specs, the recommended way to write a
        // per-id-typed producer is via `producerByIdType`: each branch's
        // `handle` is non-generic over `Id`, so TypeScript fully checks the
        // (id, content) correlation per-branch with no user-side casts.
        const fetcher = wrapProducer<StoriesCacheSpec>(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          producerByIdType<StoriesCacheSpec>()
            .when(idStartsWith("story:"), async (req) => ({
              content: {
                id: req.id,
                title: `Story ${req.id}`,
              } satisfies Story,
              directives: { freshUntilAge: 1 },
            }))
            .when(idStartsWith("collection:"), async (_req) => ({
              content: [
                { id: "1", title: "a" },
                { id: "2", title: "b" },
              ] satisfies Story[],
              directives: { freshUntilAge: 1 },
            }))
            .build(),
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

    it("rejects a non-exhaustive producerByIdType builder at compile time", async () => {
      const cache = new Cache<StoriesCacheSpec>(new MemoryStore());
      try {
        // Compile-time only: the builder below covers `story:*` but not
        // `collection:*`, so its `.build()` returns a
        // `_NonExhaustiveBuildError` tuple (not a `RequestPairedProducer`),
        // and `wrapProducer` should reject it. Guarded by `if (false)` so
        // we don't actually run the bogus producer at runtime.
        if (false as boolean) {
          wrapProducer<StoriesCacheSpec>(
            cache,
            {},
            // @ts-expect-error -- non-exhaustive: missing `collection:*` branch
            producerByIdType<StoriesCacheSpec>()
              .when(idStartsWith("story:"), async (req) => ({
                content: { id: req.id, title: "x" } satisfies Story,
                directives: { freshUntilAge: 1 },
              }))
              .build(),
          );
        }
      } finally {
        await cache.close();
      }
    });

    it("supports caching supplemental resources of a different spec variant", async () => {
      const cache = new Cache<StoriesCacheSpec>(new MemoryStore());
      try {
        const story1: Story = { id: "1", title: "First" };
        const story2: Story = { id: "2", title: "Second" };

        const fetcher = wrapProducer<StoriesCacheSpec>(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          producerByIdType<StoriesCacheSpec>()
            .when(idStartsWith("collection:"), async (_req) => ({
              content: [story1, story2] satisfies Story[],
              directives: { freshUntilAge: 100 },
              // Supplemental resources can target a *different* spec
              // variant than the request's id (here: individual stories
              // under a request for a collection).
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
            }))
            // Not reached in this test, but included so the producer is
            // exhaustive over `StoriesCacheSpec`.
            .when(idStartsWith("story:"), async (req) => ({
              content: { id: req.id, title: "fallback" } satisfies Story,
              directives: { freshUntilAge: 1 },
            }))
            .build(),
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
   * template-literal-keyed specs.
   */
  describe("with tagged/branded string keys", () => {
    type StoryKey = JsonOf<{ story: string }>;
    type CollectionKey = JsonOf<{ collection: string }>;
    type BrandedSpec =
      | CacheSpec<StoryKey, Story>
      | CacheSpec<CollectionKey, Story[]>;

    // Compile-time only: confirm that the two branded ids are mutually
    // non-assignable. (If TS ever changed this, the rest of the per-id
    // narrowing for branded keys would be silently broken.)
    expectType<Equal<StoryKey extends CollectionKey ? true : false, false>>();
    expectType<Equal<CollectionKey extends StoryKey ? true : false, false>>();

    it("narrows the result content based on the branded request id", async () => {
      const cache = new Cache<BrandedSpec>(new MemoryStore());
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
      const cache = new Cache<BrandedSpec>(new MemoryStore());
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
      const cache = new Cache<BrandedSpec>(new MemoryStore());
      try {
        const storyId = jsonStringify({
          story: "abc",
        }) satisfies string as StoryKey;
        const collectionId = jsonStringify({
          collection: "home",
        }) satisfies string as CollectionKey;

        // For branded keys the structural runtime check has to be written
        // inline (no `idStartsWith` shortcut). Each branch's `matches` is a
        // user-defined type guard; once it returns true, `producerByIdType`
        // narrows `req.id` to the matching branded type and the handler's
        // return is required to be content for that variant.
        const isStoryKey = (id: StoryKey | CollectionKey): id is StoryKey =>
          "story" in (JSON.parse(id) as object);
        const isCollectionKey = (
          id: StoryKey | CollectionKey,
        ): id is CollectionKey => "collection" in (JSON.parse(id) as object);

        const fetcher = wrapProducer<BrandedSpec>(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          producerByIdType<BrandedSpec>()
            .when(isStoryKey, async (req) => {
              const parsed = JSON.parse(req.id) as { story: string };
              return {
                content: {
                  id: parsed.story,
                  title: `Story ${parsed.story}`,
                } satisfies Story,
                directives: { freshUntilAge: 1 },
              };
            })
            .when(isCollectionKey, async (req) => {
              const parsed = JSON.parse(req.id) as { collection: string };
              return {
                content: [
                  { id: parsed.collection, title: "first" },
                ] satisfies Story[],
                directives: { freshUntilAge: 1 },
              };
            })
            .build(),
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
