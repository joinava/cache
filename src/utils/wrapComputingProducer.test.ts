import { expect } from "chai";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as delay } from "timers/promises";

import Cache, { UnclassifiableIdError } from "../Cache.js";
import { MemoryStore } from "../index.js";
import {
  idStartsWith,
  resourceType,
  soleResourceType,
} from "../types/00_ResourceTypes.js";
import type { AnyParams, AnyValidators, CacheSpec, Entry } from "../types/index.js";
import {
  wrapBulkComputingProducer,
  wrapComputingProducer,
} from "./wrapComputingProducer.js";

type Spec = CacheSpec<string, string>;
type Input = { text: string };

const computedResourceTypes = { computed: soleResourceType<string>() };
const cacheOptions = {
  name: "computing-test",
  resourceTypes: computedResourceTypes,
};

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
  let cache: Cache<typeof computedResourceTypes>;

  beforeEach(() => {
    cache = new Cache(new MemoryStore(), cacheOptions);
  });

  afterEach(async () => cache.close());

  it("calls the producer with the full input (not an id) and caches by input hash", async () => {
    const producer = mock.fn(async (input: Input) =>
      result(input.text.toUpperCase()),
    );
    const compute = wrapComputingProducer(cache, {}, {
      computed: { hashInput, produce: producer },
    });

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
    const compute = wrapComputingProducer(cache, {}, {
      computed: { hashInput, produce: producer },
    });

    await compute({ text: "a" });
    await compute({ text: "b" });
    expect(producer.mock.callCount()).to.eq(2);
  });

  it("supports an async hashInput", async () => {
    const producer = mock.fn(async (input: Input) => result(input.text));
    const compute = wrapComputingProducer(cache, {}, {
      computed: {
        hashInput: async (input: Input) => {
          await delay(1);
          return `computed:${input.text}`;
        },
        produce: producer,
      },
    });

    await compute({ text: "x" });
    await compute({ text: "x" });
    expect(producer.mock.callCount()).to.eq(1);
  });

  it("keeps the input registered for concurrent un-collapsed calls (reference counting)", async () => {
    const producer = mock.fn(async (input: Input) => {
      await delay(20);
      return result(input.text);
    });
    const compute = wrapComputingProducer(
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
    const compute = wrapComputingProducer(cache, {}, {
      computed: { hashInput, produce: producer },
    });

    await compute({ text: "primary" });
    expect(producer.mock.callCount()).to.eq(1);

    const side = await compute({ text: "side" });
    expect(side.content).to.eq("SIDE");
    expect(producer.mock.callCount()).to.eq(1);
  });

  it("throws at construction time on a keyless branches record", () => {
    expect(() => wrapComputingProducer(cache, {}, {})).to.throw(
      /cannot be empty/,
    );
  });
});

describe("wrapBulkComputingProducer", () => {
  let cache: Cache<typeof computedResourceTypes>;

  beforeEach(() => {
    cache = new Cache(new MemoryStore(), cacheOptions);
  });

  afterEach(async () => cache.close());

  it("computes only the missing inputs and aligns results to the input order", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text.toUpperCase())),
    );
    const compute = wrapBulkComputingProducer(cache, {}, {
      computed: { hashInput, produce: producer },
    });

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
    const compute = wrapBulkComputingProducer(cache, {}, {
      computed: { hashInput, produce: producer },
    });

    const results = await compute([]);
    expect(results).to.deep.eq([]);
    expect(producer.mock.callCount()).to.eq(0);
  });

  it("serves a fully-cached batch without calling the producer", async () => {
    const producer = mock.fn(async (inputs: readonly Input[]) =>
      inputs.map((input) => result(input.text.toUpperCase())),
    );
    const compute = wrapBulkComputingProducer(cache, {}, {
      computed: { hashInput, produce: producer },
    });

    await compute([{ text: "a" }, { text: "b" }]);
    const results = await compute([{ text: "a" }, { text: "b" }]);
    expect(results.map(contentOf)).to.deep.eq(["A", "B"]);
    expect(producer.mock.callCount()).to.eq(1);
  });
});

// --- multi-branch computing wrappers: heterogeneous, correlated variants ---

type Story = { id: string; title: string };
type StoryInput = { kind: "story"; id: string };
type CollInput = { kind: "collection"; ids: string[] };
type VInput = StoryInput | CollInput;

const makeStory = (id: string): Story => ({ id, title: `Story ${id}` });
const isStory = (input: unknown): input is VInput =>
  (input as Partial<StoryInput>).kind === "story";
const isCollection = (input: unknown): input is VInput =>
  (input as Partial<CollInput>).kind === "collection";

const variantResourceTypes = {
  story: resourceType<Story>()({ matches: idStartsWith("extract:story:") }),
  collection: resourceType<Story[]>()({
    matches: idStartsWith("extract:collection:"),
  }),
};

const hashStoryInput = (input: VInput): `extract:story:${string}` => {
  if (input.kind !== "story") {
    throw new Error("story branch got a non-story input");
  }
  return `extract:story:${input.id}`;
};
const hashCollectionInput = (
  input: VInput,
): `extract:collection:${string}` => {
  if (input.kind !== "collection") {
    throw new Error("collection branch got a non-collection input");
  }
  return `extract:collection:${input.ids.join(",")}`;
};

describe("wrapComputingProducer with multiple branches", () => {
  let cache: Cache<typeof variantResourceTypes>;

  beforeEach(() => {
    cache = new Cache(new MemoryStore(), {
      name: "computing-variants-test",
      resourceTypes: variantResourceTypes,
    });
  });

  afterEach(async () => cache.close());

  it("dispatches by matchesInput and returns the right content per branch", async () => {
    const compute = wrapComputingProducer(cache, {}, {
      story: {
        matchesInput: isStory,
        hashInput: hashStoryInput,
        produce: async (input) => ({
          content: makeStory((input as StoryInput).id),
          directives: { freshUntilAge: 100 },
        }),
      },
      collection: {
        matchesInput: isCollection,
        hashInput: hashCollectionInput,
        produce: async (input) => ({
          content: (input as CollInput).ids.map(makeStory),
          directives: { freshUntilAge: 100 },
        }),
      },
    });

    const story = await compute({ kind: "story", id: "1" });
    expect(story.content).to.deep.eq(makeStory("1"));

    const collection = await compute({ kind: "collection", ids: ["1", "2"] });
    expect(collection.content).to.deep.eq([makeStory("1"), makeStory("2")]);
  });

  it("throws for an input that no branch's matchesInput accepts", async () => {
    const compute = wrapComputingProducer(cache, {}, {
      story: {
        matchesInput: isStory,
        hashInput: hashStoryInput,
        produce: async (input) => ({
          content: makeStory((input as StoryInput).id),
          directives: { freshUntilAge: 100 },
        }),
      },
      collection: {
        matchesInput: isCollection,
        hashInput: hashCollectionInput,
        produce: async (input) => ({
          content: (input as CollInput).ids.map(makeStory),
          directives: { freshUntilAge: 100 },
        }),
      },
    });

    await compute({ kind: "wat" } as unknown as VInput).then(
      () => {
        throw new Error("should have rejected");
      },
      (e: unknown) => {
        expect((e as Error).message).to.match(/no branch matched the input/);
      },
    );
  });

  it("throws at construction when a multi-branch wrapper is missing matchesInput", () => {
    expect(() =>
      wrapComputingProducer(cache, {}, {
        story: {
          // no matchesInput
          hashInput: hashStoryInput,
          produce: async (input) => ({
            content: makeStory((input as StoryInput).id),
            directives: { freshUntilAge: 100 },
          }),
        },
        collection: {
          matchesInput: isCollection,
          hashInput: hashCollectionInput,
          produce: async (input) => ({
            content: (input as CollInput).ids.map(makeStory),
            directives: { freshUntilAge: 100 },
          }),
        },
      }),
    ).to.throw(/matchesInput/);
  });

  it("throws UnclassifiableIdError, naming the branch, when hashInput mints an id of another type", async () => {
    const compute = wrapComputingProducer(cache, {}, {
      story: {
        matchesInput: isStory,
        // BUG under test: mints collection-shaped ids from the story branch.
        hashInput: (input: VInput) =>
          `extract:collection:${(input as StoryInput).id}` as unknown as `extract:story:${string}`,
        produce: async (input) => ({
          content: makeStory((input as StoryInput).id),
          directives: { freshUntilAge: 100 },
        }),
      },
      collection: {
        matchesInput: isCollection,
        hashInput: hashCollectionInput,
        produce: async (input) => ({
          content: (input as CollInput).ids.map(makeStory),
          directives: { freshUntilAge: 100 },
        }),
      },
    });

    await compute({ kind: "story", id: "1" }).then(
      () => {
        throw new Error("should have rejected");
      },
      (e: unknown) => {
        expect(e).to.be.instanceOf(UnclassifiableIdError);
        expect((e as Error).message).to.include('branch "story"');
        expect((e as Error).message).to.include('"collection"');
      },
    );
  });

  it("throws UnclassifiableIdError, naming the branch, when hashInput mints an unclassifiable id", async () => {
    const compute = wrapComputingProducer(cache, {}, {
      story: {
        matchesInput: isStory,
        // BUG under test: mints ids outside every registry type's id space.
        hashInput: (input: VInput) =>
          `bogus:${(input as StoryInput).id}` as unknown as `extract:story:${string}`,
        produce: async (input) => ({
          content: makeStory((input as StoryInput).id),
          directives: { freshUntilAge: 100 },
        }),
      },
      collection: {
        matchesInput: isCollection,
        hashInput: hashCollectionInput,
        produce: async (input) => ({
          content: (input as CollInput).ids.map(makeStory),
          directives: { freshUntilAge: 100 },
        }),
      },
    });

    await compute({ kind: "story", id: "1" }).then(
      () => {
        throw new Error("should have rejected");
      },
      (e: unknown) => {
        expect(e).to.be.instanceOf(UnclassifiableIdError);
        expect((e as Error).message).to.include('branch "story"');
      },
    );
  });
});

// Compile-time correlation checks: these branch records must fail to
// type-check, proving the branch → (id, content) correlation.

// eslint-disable-next-line @typescript-eslint/no-unused-expressions
() => {
  const cache = null as unknown as Cache<typeof variantResourceTypes>;

  wrapComputingProducer(cache, {}, {
    story: {
      matchesInput: isStory,
      hashInput: hashStoryInput,
      // @ts-expect-error -- the story branch's `produce` must return Story content, not Story[]
      produce: async (input) => ({
        content: [makeStory((input as StoryInput).id)],
        directives: { freshUntilAge: 1 },
      }),
    },
    collection: {
      matchesInput: isCollection,
      hashInput: hashCollectionInput,
      produce: async (input) => ({
        content: (input as CollInput).ids.map(makeStory),
        directives: { freshUntilAge: 1 },
      }),
    },
  });

  wrapComputingProducer(cache, {}, {
    story: {
      matchesInput: isStory,
      // @ts-expect-error -- the story branch's hashInput must mint story-typed ids
      hashInput: hashCollectionInput,
      produce: async (input) => ({
        content: makeStory((input as StoryInput).id),
        directives: { freshUntilAge: 1 },
      }),
    },
    collection: {
      matchesInput: isCollection,
      hashInput: hashCollectionInput,
      produce: async (input) => ({
        content: (input as CollInput).ids.map(makeStory),
        directives: { freshUntilAge: 1 },
      }),
    },
  });
};
