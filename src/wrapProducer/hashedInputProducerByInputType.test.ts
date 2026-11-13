import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { freshFor100 } from "../../test/v2AcceptanceHelpers.js";
import {
  bulkHashedInputProducerByInputType,
  hashedInputProducerByInputType,
  type HashedInputVariant,
} from "./hashedInputProducerByInputType.js";

/**
 * The builders' own contracts, checked with no cache in sight: a chain with no
 * `.when` is unconstructible, and a duplicate `.when` for one variant throws
 * rather than silently splitting dispatch from storage. What a built producer
 * means once wired to a cache is `wrapHashedInputProducer.test.ts`'s subject.
 */

describe("hashedInputProducerByInputType / bulkHashedInputProducerByInputType", () => {
  it("hashed-input producer builders: a duplicate `.when` for one variant throws, rather than splitting dispatch from storage", () => {
    type Variants = { site_day: HashedInputVariant<{ key: string }, string> };
    const isSiteDay = (input: { key: string }): input is { key: string } =>
      typeof input.key === "string";
    const hashInput = (input: { key: string }) => `site:${input.key}`;
    const singleBranch = {
      name: "site_day" as const,
      hashInput,
      produce: async (input: { readonly key: string }) => ({
        content: `computed-${input.key}`,
        directives: freshFor100,
      }),
    };
    const bulkBranch = {
      name: "site_day" as const,
      hashInput,
      produce: async (inputs: readonly { readonly key: string }[]) =>
        inputs.map((input) => ({
          content: `computed-${input.key}`,
          directives: freshFor100,
        })),
    };

    // `Name extends Exclude<keyof V & string, Covered>` rejects the repeat
    // where it is written (a compile fixture pins that), so re-typing the
    // builder as a fresh one is what lets the duplicate be reached at all.
    // Without the runtime guard it would not merely be shadowed: dispatch
    // takes the first matching branch while the per-resource-type producer
    // table keeps the last, storing the second branch's content under the
    // first branch's minted id.
    assert.throws(
      () =>
        (
          hashedInputProducerByInputType<Variants>().when(
            isSiteDay,
            singleBranch,
          ) as unknown as ReturnType<
            typeof hashedInputProducerByInputType<Variants>
          >
        ).when(isSiteDay, singleBranch),
      {
        message:
          /hashedInputProducerByInputType: `\.when` was called twice for branch "site_day"/,
      },
    );

    assert.throws(
      () =>
        (
          bulkHashedInputProducerByInputType<Variants>().when(
            isSiteDay,
            bulkBranch,
          ) as unknown as ReturnType<
            typeof bulkHashedInputProducerByInputType<Variants>
          >
        ).when(isSiteDay, bulkBranch),
      {
        message:
          /bulkHashedInputProducerByInputType: `\.when` was called twice for branch "site_day"/,
      },
    );
  });
});
