import { expect } from "chai";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as delay } from "timers/promises";

import Cache from "../Cache.js";
import { MemoryStore } from "../index.js";
import type {
  AnyParams,
  AnyValidators,
  CacheSpec,
  Entry,
} from "../types/index.js";
import {
  computingProducerByInputType,
  type ComputingVariant,
  type ContentForVariants,
  type InputForVariants,
} from "./computingProducerByInputType.js";
import {
  wrapBulkComputingProducer,
  wrapComputingProducer,
} from "./wrapComputingProducer.js";

type Spec = CacheSpec<string, string>;
type Input = { text: string };

const hashInput = (input: Input): string => `computed:${input.text}`;

const result = (content: string) => ({
  content,
  directives: { freshUntilAge: 100 },
});

const contentOf = (
  entry: Entry<Spec, AnyValidators, AnyParams> | Error,
): string => {
  if (entry instanceof Error) {
    throw entry;
  }
  return entry.content;
};

describe("wrapComputingProducer", () => {
  let cache: Cache<Spec>;

  beforeEach(() => {
    cache = new Cache(new MemoryStore());
  });

  afterEach(async () => cache.close());

  it("calls the producer with the full input (not an id) and caches by input hash", async () => {
    const producer = mock.fn(async (input: Input) =>
      result(input.text.toUpperCase()),
    );
    const compute = wrapComputingProducer<Input, Spec>(
      { cache, hashInput },
      producer,
    );

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
    const compute = wrapComputingProducer<Input, Spec>(
      { cache, hashInput },
      producer,
    );

    await compute({ text: "a" });
    await compute({ text: "b" });
    expect(producer.mock.callCount()).to.eq(2);
  });

  it("supports an async hashInput", async () => {
    const producer = mock.fn(async (input: Input) => result(input.text));
    const compute = wrapComputingProducer<Input, Spec>(
      {
        cache,
        hashInput: async (input) => {
          await delay(1);
          return `computed:${input.text}`;
        },
      },
      producer,
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
    const compute = wrapComputingProducer<Input, Spec>(
      { cache, hashInput, collapseOverlappingRequestsTime: 0 },
      producer,
    );

    const results = await Promise.all([
      compute({ text: "q" }),
      compute({ text: "q" }),
    ]);
    expect(results.map((r) => r.content)).to.deep.eq(["q", "q"]);
  });

  it("does not cache when isCacheable(input) is false (and re-registers the input each call)", async () => {
    const producer = mock.fn(async (input: Input) => result(input.text));
    const compute = wrapComputingProducer<Input, Spec>(
      { cache, hashInput, isCacheable: (input) => input.text !== "skip" },
      producer,
    );

    const first = await compute({ text: "skip" });
    const second = await compute({ text: "skip" });
    expect(first.content).to.eq("skip");
    expect(second.content).to.eq("skip");
    expect(producer.mock.callCount()).to.eq(2);
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
    const compute = wrapComputingProducer<Input, Spec>(
      { cache, hashInput },
      producer,
    );

    await compute({ text: "primary" });
    expect(producer.mock.callCount()).to.eq(1);

    const side = await compute({ text: "side" });
    expect(side.content).to.eq("SIDE");
    expect(producer.mock.callCount()).to.eq(1);
  });
});

describe("wrapBulkComputingProducer", () => {
  let cache: Cache<Spec>;

  beforeEach(() => {
    cache = new Cache(new MemoryStore());
  });

  afterEach(async () => cache.close());

  it("computes only the missing inputs and aligns results to the input order", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text.toUpperCase())),
    );
    const compute = wrapBulkComputingProducer<Input, Spec>(
      { cache, hashInput },
      producer,
    );

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
    const compute = wrapBulkComputingProducer<Input, Spec>(
      { cache, hashInput },
      producer,
    );

    const results = await compute([]);
    expect(results).to.deep.eq([]);
    expect(producer.mock.callCount()).to.eq(0);
  });

  it("serves a fully-cached batch without calling the producer", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text.toUpperCase())),
    );
    const compute = wrapBulkComputingProducer<Input, Spec>(
      { cache, hashInput },
      producer,
    );

    await compute([{ text: "a" }, { text: "b" }]);
    const results = await compute([{ text: "a" }, { text: "b" }]);
    expect(results.map(contentOf)).to.deep.eq(["A", "B"]);
    expect(producer.mock.callCount()).to.eq(1);
  });
});

// --- computingProducerByInputType: heterogeneous, correlated variants ---

type Story = { id: string; title: string };
type StoryInput = { kind: "story"; id: string };
type CollInput = { kind: "collection"; ids: string[] };
type Variants =
  | ComputingVariant<StoryInput, Story>
  | ComputingVariant<CollInput, Story[]>;
type VInput = InputForVariants<Variants>;
type VContent = ContentForVariants<Variants>;
// A branded id subtype: the resulting cache spec is `CacheSpec<`extract:${string}`, …>`,
// which composes safely with other specs (and exercises id-agnostic assignability).
type VSpec = CacheSpec<`extract:${string}`, VContent>;

const makeStory = (id: string): Story => ({ id, title: `Story ${id}` });
const isStory = (input: VInput): input is StoryInput => input.kind === "story";
const isCollection = (input: VInput): input is CollInput =>
  input.kind === "collection";
const hashVariant = (input: VInput): VSpec["id"] =>
  input.kind === "story"
    ? `extract:story:${input.id}`
    : `extract:collection:${input.ids.join(",")}`;

describe("computingProducerByInputType", () => {
  let cache: Cache<VSpec>;

  beforeEach(() => {
    cache = new Cache(new MemoryStore());
  });

  afterEach(async () => cache.close());

  it("dispatches by input variant and returns the right content per variant", async () => {
    const produce = computingProducerByInputType<Variants>()
      .when(isStory, async (input) => ({
        content: makeStory(input.id),
        directives: { freshUntilAge: 100 },
      }))
      .when(isCollection, async (input) => ({
        content: input.ids.map(makeStory),
        directives: { freshUntilAge: 100 },
      }))
      .build();
    const compute = wrapComputingProducer(
      { cache, hashInput: hashVariant },
      produce,
    );

    const story = await compute({ kind: "story", id: "1" });
    expect(story.content).to.deep.eq(makeStory("1"));

    const collection = await compute({ kind: "collection", ids: ["1", "2"] });
    expect(collection.content).to.deep.eq([makeStory("1"), makeStory("2")]);
  });

  it("populates cross-type supplementals: computing a collection caches its stories", async () => {
    const storyProduce = mock.fn(async (input: StoryInput) => ({
      content: makeStory(input.id),
      directives: { freshUntilAge: 100 },
    }));
    const collectionProduce = mock.fn(async (input: CollInput) => ({
      content: input.ids.map(makeStory),
      directives: { freshUntilAge: 100 },
      supplementalResources: input.ids.map((id) => ({
        input: { kind: "story" as const, id },
        content: makeStory(id),
        directives: { freshUntilAge: 100 },
      })),
    }));
    const produce = computingProducerByInputType<Variants>()
      .when(isStory, storyProduce)
      .when(isCollection, collectionProduce)
      .build();
    const compute = wrapComputingProducer(
      { cache, hashInput: hashVariant },
      produce,
    );

    await compute({ kind: "collection", ids: ["1", "2"] });
    expect(collectionProduce.mock.callCount()).to.eq(1);

    // Each story was cached as a supplemental keyed by its (story) input, so a
    // later compute() for that story is a hit and never invokes storyProduce.
    const s1 = await compute({ kind: "story", id: "1" });
    expect(s1.content).to.deep.eq(makeStory("1"));
    const s2 = await compute({ kind: "story", id: "2" });
    expect(s2.content).to.deep.eq(makeStory("2"));
    expect(storyProduce.mock.callCount()).to.eq(0);
  });
});

// Compile-time correlation checks: these `.when(...)` branches must fail to
// type-check, proving the input → content (and supplemental) correlation.

computingProducerByInputType<Variants>().when(
  isStory,
  // @ts-expect-error -- the story branch's `produce` must return Story content, not Story[]
  async (input) => ({
    content: [makeStory(input.id)],
    directives: { freshUntilAge: 1 },
  }),
);

computingProducerByInputType<Variants>().when(
  isCollection,
  // @ts-expect-error -- a story-input supplemental must carry Story content, not Story[]
  async (input) => ({
    content: input.ids.map(makeStory),
    directives: { freshUntilAge: 1 },
    supplementalResources: [
      {
        input: { kind: "story" as const, id: "x" },
        content: [makeStory("x")],
        directives: { freshUntilAge: 1 },
      },
    ],
  }),
);
