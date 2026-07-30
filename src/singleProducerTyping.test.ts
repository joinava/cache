import { expect } from "chai";
import { describe, it } from "node:test";

import {
  expectType,
  memoryStoreFor,
  uniqueCacheName,
  type Equal,
} from "../test/v2AcceptanceHelpers.js";
import Cache from "./Cache.js";
import {
  bulkProducerByIdType,
  coveredTypes,
  idStartsWith,
  producerByIdType,
  resourceType,
  wrapBulkProducer,
  wrapProducer,
  type ResourceTypes,
} from "./index.js";

/**
 * Type-level acceptance tests for the single-producer-function change
 * (docs/plans/2026-07-30-single-producer-fn-and-by-id-type-sugar.md §3.1,
 * §3.2, §5.2): a bare function covers the whole registry (`Covered` takes its
 * default), a function typed for a strict subset is REJECTED where a bare
 * producer is expected (finding 4: `Covered` never infers from the parameter
 * type), the `*ByIdType` helpers narrow `Covered` through their symbol-keyed
 * coverage carrier so an uncovered id is a compile error at the WRAPPED
 * function's call site, and narrowing `Covered` at all REQUIRES that carrier --
 * an explicit type argument alone is rejected, because it would narrow the
 * types while leaving the wrapper's runtime coverage reading as the whole
 * registry.
 *
 * Follows the coverageTyping.test.ts conventions: `expectType<Equal<...>>()`,
 * `@ts-expect-error` fixtures kept on ONE line so the error's reported position
 * can't drift off the suppressed line, and `if (false)` guards around calls
 * that must typecheck (or fail to) without running.
 *
 * (These belong logically alongside the coverageTyping.test.ts fixtures; they
 * live in their own file to keep this change's tests separable from the 2.0
 * acceptance suites.)
 */

type StoryId = `story:${string}`;
type CollectionId = `collection:${string}`;
type ExtraId = `extra:${string}`;
type Story = { title: string };
type Collection = { storyTitles: string[] };
type Extra = { blob: string };

const registry = {
  story: resourceType<Story>()({ matches: idStartsWith("story:") }),
  collection: resourceType<Collection>()({
    matches: idStartsWith("collection:"),
  }),
  extra: resourceType<Extra>()({ matches: idStartsWith("extra:") }),
} satisfies ResourceTypes;

const freshFor1 = { freshUntilAge: 1 };

const makeCache = (label: string) =>
  new Cache({
    store: memoryStoreFor(registry),
    name: uniqueCacheName(label),
    resourceTypes: registry,
  });

/** A producer that only accepts `story:` ids -- i.e. strict partial coverage. */
const storyOnlyProducer = async (req: { readonly id: StoryId }) => ({
  content: { title: `t-${req.id}` } satisfies Story,
  directives: freshFor1,
});

const storyOnlyBulkProducer = async (
  reqs: readonly { readonly id: StoryId }[],
) =>
  reqs.map((req) => ({
    content: { title: `t-${req.id}` } satisfies Story,
    directives: freshFor1,
  }));

describe("single producer function -- typing (§3.1, §3.2, §5.2)", () => {
  describe("a bare function covers the whole registry", () => {
    it("accepts every registry type's id, sees the full id union in `req`, and keeps per-id content narrowing", async () => {
      const cache = makeCache("sp-typing-bare");
      try {
        const fetchAny = wrapProducer(cache, {}, async (req) => {
          // `Covered` took its default, so the producer sees -- and must
          // handle -- every registry id. Not narrowed to one type, not `any`.
          expectType<Equal<typeof req.id, StoryId | CollectionId | ExtraId>>();
          return req.id.startsWith("story:")
            ? {
                content: { title: `t-${req.id}` } satisfies Story,
                directives: freshFor1,
              }
            : req.id.startsWith("collection:")
              ? {
                  content: { storyTitles: [] } satisfies Collection,
                  directives: freshFor1,
                }
              : {
                  content: { blob: `b-${req.id}` } satisfies Extra,
                  directives: freshFor1,
                };
        });

        // Every registry type's id is accepted by the wrapped function, and
        // each answer's content is narrowed to that id's own content type.
        const story = await fetchAny({ id: "story:1" });
        expectType<Equal<typeof story.content, Story>>();
        expect(story.content).to.deep.equal({ title: "t-story:1" });

        const collection = await fetchAny({ id: "collection:1" });
        expectType<Equal<typeof collection.content, Collection>>();
        expect(collection.content).to.deep.equal({ storyTitles: [] });

        const extra = await fetchAny({ id: "extra:1" });
        expectType<Equal<typeof extra.content, Extra>>();
        expect(extra.content).to.deep.equal({ blob: "b-extra:1" });

        if (false as boolean) {
          const looseId = "anything" as string;
          // @ts-expect-error a plain string is not an id of any registry type
          void fetchAny({ id: looseId });
        }
      } finally {
        await cache.close();
      }
    });

    it("wrapBulkProducer: a bare bulk producer accepts request elements of every registry type", async () => {
      const cache = makeCache("sp-typing-bare-bulk");
      try {
        const getBulk = wrapBulkProducer(cache, {}, async (reqs) => {
          expectType<
            Equal<(typeof reqs)[number]["id"], StoryId | CollectionId | ExtraId>
          >();
          return reqs.map((req) =>
            req.id.startsWith("story:")
              ? {
                  content: { title: `t-${req.id}` } satisfies Story,
                  directives: freshFor1,
                }
              : req.id.startsWith("collection:")
                ? {
                    content: { storyTitles: [] } satisfies Collection,
                    directives: freshFor1,
                  }
                : {
                    content: { blob: `b-${req.id}` } satisfies Extra,
                    directives: freshFor1,
                  },
          );
        });

        const results = await getBulk([
          { id: "story:1" },
          { id: "collection:1" },
          { id: "extra:1" },
        ]);
        const first = results[0];
        if (!(first instanceof Error)) {
          expectType<Equal<typeof first.content, Story>>();
        }
        const third = results[2];
        if (!(third instanceof Error)) {
          expectType<Equal<typeof third.content, Extra>>();
        }
      } finally {
        await cache.close();
      }
    });
  });

  describe("a partially-typed function is rejected where a bare producer is expected", () => {
    it("rejects a subset-typed producer, and rejects the per-resource-type record the wrappers used to take", async () => {
      const cache = makeCache("sp-typing-rejections");
      try {
        if (false as boolean) {
          // `Covered` never infers from the producer's parameter type (finding
          // 4), so it stays at the whole-registry default and the compiler
          // makes the function prove it accepts every registry id. Partial
          // coverage must go through a helper instead.
          // prettier-ignore
          // @ts-expect-error a story-only producer cannot satisfy the whole-registry default
          void wrapProducer(cache, {}, storyOnlyProducer);

          // prettier-ignore
          // @ts-expect-error same for the bulk wrapper
          void wrapBulkProducer(cache, {}, storyOnlyBulkProducer);

          // The record form is no longer a producer: it is the *helper's*
          // parameter now. (A surviving record overload would be exactly the
          // compatibility layer this change exists to avoid.)
          // prettier-ignore
          // @ts-expect-error a per-resource-type record is not a function; records go through producerByIdType
          void wrapProducer(cache, {}, { story: storyOnlyProducer });

          // prettier-ignore
          // @ts-expect-error likewise for wrapBulkProducer / bulkProducerByIdType
          void wrapBulkProducer(cache, {}, { story: storyOnlyBulkProducer });
        }
      } finally {
        await cache.close();
      }
    });
  });

  describe("the helpers narrow `Covered` (§3.2's optional coverage carrier)", () => {
    it("producerByIdType: covered ids are accepted with per-id narrowing; an uncovered id is an error at the WRAPPED function's call site", async () => {
      const cache = makeCache("sp-typing-helper-single");
      try {
        const fetchStoryOrCollection = wrapProducer(
          cache,
          {},
          producerByIdType(cache, {
            story: async (req) => {
              // Contextually narrowed per key, exactly as under the 2.0 record.
              expectType<Equal<typeof req.id, StoryId>>();
              return {
                content: { title: `t-${req.id}` } satisfies Story,
                directives: freshFor1,
              };
            },
            collection: async (req) => {
              expectType<Equal<typeof req.id, CollectionId>>();
              return {
                content: { storyTitles: [req.id] } satisfies Collection,
                directives: freshFor1,
              };
            },
          }),
        );

        const story = await fetchStoryOrCollection({ id: "story:1" });
        expectType<Equal<typeof story.content, Story>>();
        expect(story.content).to.deep.equal({ title: "t-story:1" });

        const collection = await fetchStoryOrCollection({ id: "collection:1" });
        expectType<Equal<typeof collection.content, Collection>>();
        expect(collection.content).to.deep.equal({
          storyTitles: ["collection:1"],
        });

        if (false as boolean) {
          const extraId = "extra:1" as ExtraId;
          // @ts-expect-error `extra` is outside the helper's record, so Covered excludes it
          void fetchStoryOrCollection({ id: extraId });
        }
      } finally {
        await cache.close();
      }
    });

    it("bulkProducerByIdType: covered ids mix freely in one batch; an uncovered element is an error", async () => {
      const cache = makeCache("sp-typing-helper-bulk");
      try {
        const getBulk = wrapBulkProducer(
          cache,
          {},
          bulkProducerByIdType(cache, {
            story: async (reqs) => {
              expectType<Equal<(typeof reqs)[number]["id"], StoryId>>();
              return reqs.map((req) => ({
                content: { title: `t-${req.id}` } satisfies Story,
                directives: freshFor1,
              }));
            },
            collection: async (reqs) => {
              expectType<Equal<(typeof reqs)[number]["id"], CollectionId>>();
              return reqs.map((req) => ({
                content: { storyTitles: [req.id] } satisfies Collection,
                directives: freshFor1,
              }));
            },
          }),
        );

        const results = await getBulk([
          { id: "story:1" },
          { id: "collection:1" },
        ]);
        const first = results[0];
        if (!(first instanceof Error)) {
          expectType<Equal<typeof first.content, Story>>();
          expect(first.content).to.deep.equal({ title: "t-story:1" });
        }

        if (false as boolean) {
          // prettier-ignore
          // @ts-expect-error `extra` is uncovered, so it is rejected element-wise
          void getBulk([{ id: "story:1" }, { id: "extra:1" as ExtraId }]);
        }
      } finally {
        await cache.close();
      }
    });

    it("an explicit `Covered` type argument cannot narrow a BARE producer: narrowed coverage requires the runtime carrier", async () => {
      const cache = makeCache("sp-typing-explicit-covered");
      try {
        if (false as boolean) {
          // The function itself fits `Covered = "story"` perfectly (its
          // parameter takes story ids; its result is story-pinned). What it
          // lacks is the runtime covered set, which is REQUIRED once `Covered`
          // is a strict subset -- otherwise the type would say "story only"
          // while the wrapper's runtime check read "the whole registry", and a
          // cast-in `collection:` id would reach this story producer instead of
          // throwing NoProducerForResourceTypeError.
          // prettier-ignore
          // @ts-expect-error narrowing Covered requires the [coveredTypes] runtime value
          void wrapProducer<typeof registry, "story">(cache, {}, storyOnlyProducer);
        }

        // CONTROL isolating the cause: attach the carrier and the exact same
        // function is accepted. So the rejection above is about the missing
        // runtime coverage value, not about the function's signature.
        const storyOnlyWithCoverage = Object.assign(storyOnlyProducer, {
          [coveredTypes]: ["story"] as const,
        });
        const fetchStoryOnly = wrapProducer<typeof registry, "story">(
          cache,
          {},
          storyOnlyWithCoverage,
        );

        const story = await fetchStoryOnly({ id: "story:1" });
        expectType<Equal<typeof story.content, Story>>();
        expect(story.content).to.deep.equal({ title: "t-story:1" });

        if (false as boolean) {
          const collectionId = "collection:1" as CollectionId;
          // @ts-expect-error only `story` is covered by the explicit type argument
          void fetchStoryOnly({ id: collectionId });
        }
      } finally {
        await cache.close();
      }
    });
  });

  describe("empty records", () => {
    it("both helpers throw at construction on an empty record (§3.4: the check moves out of wrapProducer)", async () => {
      const cache = makeCache("sp-typing-empty-record");
      try {
        // Compiles (`Covered` infers as `never`, so the mapped record is `{}`)
        // and is compile-dead at every call site -- so construction time is the
        // only place this mistake can be caught.
        expect(() => producerByIdType(cache, {})).to.throw();
        expect(() => bulkProducerByIdType(cache, {})).to.throw();
      } finally {
        await cache.close();
      }
    });
  });
});
