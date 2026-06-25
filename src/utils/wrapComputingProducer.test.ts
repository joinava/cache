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
  RequestPairedProducerResult,
} from "../types/index.js";
import {
  wrapBulkComputingProducer,
  wrapComputingProducer,
} from "./wrapComputingProducer.js";

type Spec = CacheSpec<string, string>;
type Input = { text: string };

const hashInput = (input: Input): string => `computed:${input.text}`;

const result = (
  content: string,
): RequestPairedProducerResult<Spec, AnyValidators, AnyParams> => ({
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
    // The producer receives the full input object, never the derived id.
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
    // With collapsing disabled, both concurrent calls invoke the producer
    // separately; the registry must keep the input until BOTH have read it.
    // A naive set/delete would let the first finisher evict the entry before
    // the second's producer read, throwing "no input registered".
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
    // Two sequential uncacheable calls both reach the producer via the
    // registry, so this also proves the input is re-registered after the first
    // call released it — a leaked-or-dropped entry would throw "no input
    // registered" on the second call instead of producing a result.
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

    // Prime "b".
    await compute([{ text: "b" }]);
    expect(producer.mock.callCount()).to.eq(1);
    expect(producer.mock.calls[0]?.arguments[0]).to.deep.eq([{ text: "b" }]);

    // a, b, c -> only a and c miss; results stay aligned to input order.
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
