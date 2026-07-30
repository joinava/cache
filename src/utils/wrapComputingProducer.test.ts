import { expect } from "chai";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as delay } from "timers/promises";
import type { ReadonlyDeep } from "type-fest";

import { expectRejection } from "../../test/v2AcceptanceHelpers.js";
import Cache from "../Cache.js";
import {
  idStartsWith,
  MemoryStore,
  resourceType,
  soleResourceType,
  UnclassifiableIdError,
  type ResourceTypes,
  type SpecOf,
} from "../index.js";
import type { AnyParams, AnyValidators, Entry } from "../types/index.js";
import {
  wrapBulkComputingProducer,
  wrapComputingProducer,
} from "./wrapComputingProducer.js";

// 2.0: computing wrappers take (cache, options, branches) with per-covered-
// type { matchesInput, hashInput, produce } branches; the
// computingProducerByInputType builder is deleted. The 1.6.0 `isCacheable`
// test was removed with the option itself (§6.3). All computing-wrapper calls
// pass explicit type arguments: `Input` inference degrades to `unknown` when
// branch functions are pre-typed references (see the acceptance report).
const testRegistry = {
  computed: soleResourceType<string>(),
} satisfies ResourceTypes;
const testCacheOptions = {
  name: "wrap-computing-producer-test",
  resourceTypes: testRegistry,
};

type Input = { text: string };

const hashInput = (input: Input): string => `computed:${input.text}`;

const result = (content: string) => ({
  content,
  directives: { freshUntilAge: 100 },
});

const contentOf = (
  entry: Entry<SpecOf<typeof testRegistry>, AnyValidators, AnyParams> | Error,
): string => {
  if (entry instanceof Error) {
    throw entry;
  }
  return entry.content;
};

describe("wrapComputingProducer", () => {
  let cache: Cache<typeof testRegistry>;

  beforeEach(() => {
    cache = new Cache({
      store: new MemoryStore<SpecOf<typeof testRegistry>>(),
      ...testCacheOptions,
    });
  });

  afterEach(async () => cache.close());

  it("calls the producer with the full input (not an id) and caches by input hash", async () => {
    const producer = mock.fn(async (input: Input) =>
      result(input.text.toUpperCase()),
    );
    const compute = wrapComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    const first = await compute({ text: "hello" });
    expect(first.content).to.eq("HELLO");
    expect(producer.mock.calls[0]?.arguments[0]).to.deep.eq({ text: "hello" });

    const second = await compute({ text: "hello" });
    expect(second.content).to.eq("HELLO");
    expect(producer.mock.callCount()).to.eq(1);
  });

  it("recomputes for a different input", async () => {
    const producer = mock.fn(async (input: Input) =>
      result(input.text.toUpperCase()),
    );
    const compute = wrapComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    await compute({ text: "a" });
    await compute({ text: "b" });
    expect(producer.mock.callCount()).to.eq(2);
  });

  it("supports an async hashInput", async () => {
    const producer = mock.fn(async (input: Input) => result(input.text));
    const compute = wrapComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(
      cache,
      {},
      {
        computed: {
          hashInput: async (input) => {
            await delay(1);
            return `computed:${input.text}`;
          },
          produce: producer,
        },
      },
    );

    await compute({ text: "x" });
    await compute({ text: "x" });
    expect(producer.mock.callCount()).to.eq(1);
  });

  it("keeps the input registered for concurrent un-collapsed calls (reference counting)", async () => {
    const producer = mock.fn(async (input: Input) => {
      await delay(20);
      return result(input.text);
    });
    const compute = wrapComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(
      cache,
      { collapseOverlappingRequestsTime: 0 },
      { computed: { hashInput, produce: producer } },
    );

    const results = await Promise.all([
      compute({ text: "q" }),
      compute({ text: "q" }),
    ]);
    expect(results.map((r) => r.content)).to.deep.eq(["q", "q"]);
  });

  it("stores supplementals under their input's hash, so a later compute() hits", async () => {
    const producer = mock.fn(async (input: Input) => ({
      content: input.text.toUpperCase(),
      directives: { freshUntilAge: 100 },
      supplementalResources:
        input.text === "primary"
          ? [
              {
                input: { text: "side" },
                content: "SIDE",
                directives: { freshUntilAge: 100 },
              },
            ]
          : [],
    }));
    const compute = wrapComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    await compute({ text: "primary" });
    expect(producer.mock.callCount()).to.eq(1);

    const side = await compute({ text: "side" });
    expect(side.content).to.eq("SIDE");
    expect(producer.mock.callCount()).to.eq(1);
  });

  it("call-time directives: maxAge 0 forces recomputation of a memoized input (restored 1.6.0 parity)", async () => {
    const producer = mock.fn(async (input: Input) =>
      result(input.text.toUpperCase()),
    );
    const compute = wrapComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    expect((await compute({ text: "hello" })).content).to.eq("HELLO");
    expect((await compute({ text: "hello" })).content).to.eq("HELLO");
    expect(producer.mock.callCount()).to.eq(1);

    // Bypass directives skip the cache read and force producer contact,
    // exactly as on a plain wrapped producer.
    const forced = await compute(
      { text: "hello" },
      { directives: { maxAge: 0 } },
    );
    expect(forced.content).to.eq("HELLO");
    expect(producer.mock.callCount()).to.eq(2);

    // Plain calls still serve from cache (the memoized entry stands).
    expect((await compute({ text: "hello" })).content).to.eq("HELLO");
    expect(producer.mock.callCount()).to.eq(2);
  });
});

describe("wrapBulkComputingProducer", () => {
  let cache: Cache<typeof testRegistry>;

  beforeEach(() => {
    cache = new Cache({
      store: new MemoryStore<SpecOf<typeof testRegistry>>(),
      ...testCacheOptions,
    });
  });

  afterEach(async () => cache.close());

  it("computes only the missing inputs and aligns results to the input order", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text.toUpperCase())),
    );
    const compute = wrapBulkComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    await compute([{ text: "b" }]);
    expect(producer.mock.callCount()).to.eq(1);
    expect(producer.mock.calls[0]?.arguments[0]).to.deep.eq([{ text: "b" }]);

    const results = await compute([
      { text: "a" },
      { text: "b" },
      { text: "c" },
    ]);
    expect(results.map(contentOf)).to.deep.eq(["A", "B", "C"]);
    expect(producer.mock.callCount()).to.eq(2);
    expect(producer.mock.calls[1]?.arguments[0]).to.deep.eq([
      { text: "a" },
      { text: "c" },
    ]);
  });

  it("returns an empty array for no inputs without calling the producer", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text)),
    );
    const compute = wrapBulkComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    const results = await compute([]);
    expect(results).to.deep.eq([]);
    expect(producer.mock.callCount()).to.eq(0);
  });

  it("serves a fully-cached batch without calling the producer", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text.toUpperCase())),
    );
    const compute = wrapBulkComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    await compute([{ text: "a" }, { text: "b" }]);
    const results = await compute([{ text: "a" }, { text: "b" }]);
    expect(results.map(contentOf)).to.deep.eq(["A", "B"]);
    expect(producer.mock.callCount()).to.eq(1);
  });

  it("call-time directives apply to every element: maxAge 0 recomputes a memoized batch (restored 1.6.0 parity)", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text.toUpperCase())),
    );
    const compute = wrapBulkComputingProducer<
      Input,
      typeof testRegistry,
      "computed"
    >(cache, {}, { computed: { hashInput, produce: producer } });

    expect(
      (await compute([{ text: "a" }, { text: "b" }])).map(contentOf),
    ).to.deep.eq(["A", "B"]);
    expect(
      (await compute([{ text: "a" }, { text: "b" }])).map(contentOf),
    ).to.deep.eq(["A", "B"]);
    expect(producer.mock.callCount()).to.eq(1);

    const forced = await compute([{ text: "a" }, { text: "b" }], {
      directives: { maxAge: 0 },
    });
    expect(forced.map(contentOf)).to.deep.eq(["A", "B"]);
    expect(producer.mock.callCount()).to.eq(2);
  });
});

// --- heterogeneous branches: correlated (input kind, id space, content) ---
//
// (Successor of the 1.6.0 computingProducerByInputType tests, including its
// cross-variant supplemental coverage: supplementals may be input-keyed for
// ANY covered branch — routed by `matchesInput`, hashed by the routed
// branch's `hashInput` — or id-keyed for any registry type, restored to full
// 1.6.0 parity on 2026-07-29.)

type Story = { id: string; title: string };
type StoryInput = { kind: "story"; id: string };
type CollInput = { kind: "collection"; ids: string[] };
type VInput = StoryInput | CollInput;

const storiesRegistry = {
  story: resourceType<Story>()({ matches: idStartsWith("extract:story:") }),
  collection: resourceType<Story[]>()({
    matches: idStartsWith("extract:collection:"),
  }),
} satisfies ResourceTypes;

const makeStory = (id: string): Story => ({ id, title: `Story ${id}` });
const isStory = (input: unknown): input is VInput =>
  (input as { kind?: unknown }).kind === "story";
const isCollection = (input: unknown): input is VInput =>
  (input as { kind?: unknown }).kind === "collection";

describe("computing wrappers with heterogeneous branches", () => {
  let cache: Cache<typeof storiesRegistry>;

  beforeEach(() => {
    cache = new Cache({
      store: new MemoryStore<SpecOf<typeof storiesRegistry>>(),
      name: "computing-branches-test",
      resourceTypes: storiesRegistry,
    });
  });

  afterEach(async () => cache.close());

  it("dispatches by matchesInput and returns the right (typed) content per branch", async () => {
    const compute = wrapComputingProducer<
      VInput,
      typeof storiesRegistry,
      "story" | "collection"
    >(
      cache,
      {},
      {
        story: {
          matchesInput: isStory,
          hashInput: (input): `extract:story:${string}` =>
            `extract:story:${(input as StoryInput).id}`,
          produce: async (input) => ({
            content: makeStory((input as StoryInput).id),
            directives: { freshUntilAge: 100 },
          }),
        },
        collection: {
          matchesInput: isCollection,
          hashInput: (input): `extract:collection:${string}` =>
            `extract:collection:${(input as CollInput).ids.join(",")}`,
          produce: async (input) => ({
            content: (input as CollInput).ids.map(makeStory),
            directives: { freshUntilAge: 100 },
          }),
        },
      },
    );

    const story = await compute({ kind: "story", id: "1" });
    expect(story.content).to.deep.eq(makeStory("1"));

    const collection = await compute({ kind: "collection", ids: ["1", "2"] });
    expect(collection.content).to.deep.eq([makeStory("1"), makeStory("2")]);
  });

  it("caches same-branch supplementals under their input's hash across branch dispatch", async () => {
    const storyProduce = mock.fn(async (input: ReadonlyDeep<VInput>) => ({
      content: makeStory((input as StoryInput).id),
      directives: { freshUntilAge: 100 },
      supplementalResources: [
        // A related story this computation produced as a byproduct: same
        // branch (story), keyed by ITS input, so compute({...related}) hits.
        {
          input: {
            kind: "story",
            id: `${(input as StoryInput).id}-related`,
          } satisfies StoryInput as VInput,
          content: makeStory(`${(input as StoryInput).id}-related`),
          directives: { freshUntilAge: 100 },
        },
      ],
    }));
    const collectionProduce = mock.fn(async (input: ReadonlyDeep<VInput>) => ({
      content: (input as CollInput).ids.map(makeStory),
      directives: { freshUntilAge: 100 },
    }));

    const compute = wrapComputingProducer<
      VInput,
      typeof storiesRegistry,
      "story" | "collection"
    >(
      cache,
      {},
      {
        story: {
          matchesInput: isStory,
          hashInput: (input): `extract:story:${string}` =>
            `extract:story:${(input as StoryInput).id}`,
          produce: storyProduce,
        },
        collection: {
          matchesInput: isCollection,
          hashInput: (input): `extract:collection:${string}` =>
            `extract:collection:${(input as CollInput).ids.join(",")}`,
          produce: collectionProduce,
        },
      },
    );

    const s1 = await compute({ kind: "story", id: "1" });
    expect(s1.content).to.deep.eq(makeStory("1"));
    expect(storyProduce.mock.callCount()).to.eq(1);

    // The supplemental was cached under its own (story) input's hash, so
    // computing it directly never invokes the producer again...
    const related = await compute({ kind: "story", id: "1-related" });
    expect(related.content).to.deep.eq(makeStory("1-related"));
    expect(storyProduce.mock.callCount()).to.eq(1);

    // ...and collection dispatch still works independently.
    const coll = await compute({ kind: "collection", ids: ["9"] });
    expect(coll.content).to.deep.eq([makeStory("9")]);
    expect(collectionProduce.mock.callCount()).to.eq(1);
  });

  it("input-keyed supplementals may target OTHER covered branches: routed by matchesInput, hashed by the routed branch's hashInput (restored 1.6.0 parity)", async () => {
    const collectionProduce = mock.fn(async (input: ReadonlyDeep<VInput>) => ({
      content: (input as CollInput).ids.map(makeStory),
      directives: { freshUntilAge: 100 },
    }));
    const compute = wrapComputingProducer<
      VInput,
      typeof storiesRegistry,
      "story" | "collection"
    >(
      cache,
      {},
      {
        story: {
          matchesInput: isStory,
          hashInput: (input): `extract:story:${string}` =>
            `extract:story:${(input as StoryInput).id}`,
          produce: async (input) => ({
            content: makeStory((input as StoryInput).id),
            directives: { freshUntilAge: 100 },
            supplementalResources: [
              // A byproduct belonging to the OTHER branch: keyed by a
              // collection input, so the wrapper must route it via
              // matchesInput to the collection branch and hash it with ITS
              // hashInput.
              {
                input: {
                  kind: "collection",
                  ids: [(input as StoryInput).id],
                } satisfies CollInput as VInput,
                content: [makeStory((input as StoryInput).id)],
                directives: { freshUntilAge: 100 },
              },
            ],
          }),
        },
        collection: {
          matchesInput: isCollection,
          hashInput: (input): `extract:collection:${string}` =>
            `extract:collection:${(input as CollInput).ids.join(",")}`,
          produce: collectionProduce,
        },
      },
    );

    const s7 = await compute({ kind: "story", id: "7" });
    expect(s7.content).to.deep.eq(makeStory("7"));

    // The cross-branch supplemental is a hit for the collection branch: its
    // producer is never invoked.
    const coll = await compute({ kind: "collection", ids: ["7"] });
    expect(coll.content).to.deep.eq([makeStory("7")]);
    expect(collectionProduce.mock.callCount()).to.eq(0);
  });

  it("id-keyed supplementals may target ANY registry type -- even one no wrapper covers (restored plain-producer parity)", async () => {
    const snapshotRegistry = {
      story: resourceType<Story>()({ matches: idStartsWith("extract:story:") }),
      collection: resourceType<Story[]>()({
        matches: idStartsWith("extract:collection:"),
      }),
      // Never covered by any wrapper: written only as a supplemental,
      // read via serve-if-present Cache.get.
      site_snapshot: resourceType<string>()({
        matches: idStartsWith("snapshot:"),
      }),
    } satisfies ResourceTypes;
    const snapshotCache = new Cache({
      store: new MemoryStore<SpecOf<typeof snapshotRegistry>>(),
      name: "computing-id-keyed-suppl-test",
      resourceTypes: snapshotRegistry,
    });
    try {
      const compute = wrapComputingProducer<
        VInput,
        typeof snapshotRegistry,
        "story" | "collection"
      >(
        snapshotCache,
        {},
        {
          story: {
            matchesInput: isStory,
            hashInput: (input): `extract:story:${string}` =>
              `extract:story:${(input as StoryInput).id}`,
            produce: async (input) => ({
              content: makeStory((input as StoryInput).id),
              directives: { freshUntilAge: 100 },
              supplementalResources: [
                // Id-keyed: a plain ProducerResultResource, stored under its
                // own natural id and classified at store time.
                {
                  id: `snapshot:${(input as StoryInput).id}`,
                  content: `raw-html-${(input as StoryInput).id}`,
                  directives: { freshUntilAge: 100 },
                },
              ],
            }),
          },
          collection: {
            matchesInput: isCollection,
            hashInput: (input): `extract:collection:${string}` =>
              `extract:collection:${(input as CollInput).ids.join(",")}`,
            produce: async (input) => ({
              content: (input as CollInput).ids.map(makeStory),
              directives: { freshUntilAge: 100 },
            }),
          },
        },
      );

      const s3 = await compute({ kind: "story", id: "3" });
      expect(s3.content).to.deep.eq(makeStory("3"));

      // The supplemental store is fire-and-forget behind the wrapper, so
      // poll via direct Cache.get (which never triggers producers).
      const readSnapshot = async () =>
        (
          await snapshotCache.get({
            id: "snapshot:3",
            params: {},
            directives: {},
          })
        ).usable;
      let entry = await readSnapshot();
      let attempts = 0;
      while (entry === undefined && attempts < 200) {
        await delay(5);
        attempts += 1;
        entry = await readSnapshot();
      }
      expect(entry?.content).to.eq("raw-html-3");
    } finally {
      await snapshotCache.close();
    }
  });

  it("a supplemental input matching no covered branch rejects the invocation loudly", async () => {
    const compute = wrapComputingProducer<
      VInput,
      typeof storiesRegistry,
      "story" | "collection"
    >(
      cache,
      {},
      {
        story: {
          matchesInput: isStory,
          hashInput: (input): `extract:story:${string}` =>
            `extract:story:${(input as StoryInput).id}`,
          produce: async (input) => ({
            content: makeStory((input as StoryInput).id),
            directives: { freshUntilAge: 100 },
            supplementalResources: [
              {
                // Matches neither branch's matchesInput.
                input: { kind: "neither" } as unknown as VInput,
                content: makeStory("x"),
                directives: { freshUntilAge: 100 },
              },
            ],
          }),
        },
        collection: {
          matchesInput: isCollection,
          hashInput: (input): `extract:collection:${string}` =>
            `extract:collection:${(input as CollInput).ids.join(",")}`,
          produce: async (input) => ({
            content: (input as CollInput).ids.map(makeStory),
            directives: { freshUntilAge: 100 },
          }),
        },
      },
    );

    const thrown = await expectRejection(() =>
      compute({ kind: "story", id: "9" }),
    );
    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.match(/no branch matched/);
  });

  it("a supplemental whose routed branch mints a misclassified id rejects loudly, naming that branch", async () => {
    const compute = wrapComputingProducer<
      VInput,
      typeof storiesRegistry,
      "story" | "collection"
    >(
      cache,
      {},
      {
        story: {
          matchesInput: isStory,
          hashInput: (input): `extract:story:${string}` =>
            `extract:story:${(input as StoryInput).id}`,
          produce: async (input) => ({
            content: makeStory((input as StoryInput).id),
            directives: { freshUntilAge: 100 },
            supplementalResources: [
              // Routed to the collection branch, whose buggy hashInput below
              // mints a story-prefixed id.
              {
                input: {
                  kind: "collection",
                  ids: ["9"],
                } satisfies CollInput as VInput,
                content: [makeStory("9")],
                directives: { freshUntilAge: 100 },
              },
            ],
          }),
        },
        collection: {
          matchesInput: isCollection,
          // BUG under test: mints an id in the story branch's id space. The
          // type system rejects this honestly, so the buggy value is cast
          // through -- the runtime mint-check is the net for exactly these
          // type-level bypasses.
          hashInput: (input): `extract:collection:${string}` =>
            `extract:story:${(input as CollInput).ids.join(",")}` as unknown as `extract:collection:${string}`,
          produce: async (input) => ({
            content: (input as CollInput).ids.map(makeStory),
            directives: { freshUntilAge: 100 },
          }),
        },
      },
    );

    const thrown = await expectRejection(() =>
      compute({ kind: "story", id: "9" }),
    );
    expect(thrown).to.be.instanceOf(UnclassifiableIdError);
    expect((thrown as Error).message).to.match(/branch "collection"/);
  });
});
