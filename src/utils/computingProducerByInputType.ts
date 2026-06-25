import type { CacheSpec } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  ProducerResultResource,
} from "../types/index.js";
import type { ComputingProducerResult } from "./wrapComputingProducer.js";

/**
 * `computingProducerByInputType` is the computing analog of `producerByIdType`:
 * it builds a single, correlated computing producer for a *heterogeneous* cache
 * by dispatching on the input variant. The producer it returns is an ordinary
 * computing producer, handed (with a `hashInput`) to {@link wrapComputingProducer}.
 *
 * @module
 */

/**
 * One variant of a heterogeneous computing cache: pairs an input shape with the
 * content computed from it. The set of variants is a *union* of these (no
 * names) — see {@link computingProducerByInputType}.
 *
 * There's deliberately no `id` here: a computing cache's id is just
 * `hashInput(input)`, supplied separately to {@link wrapComputingProducer}, and
 * can be any `string` subtype (e.g. `` `extract:${string}` ``) so the resulting
 * spec composes with other specs.
 */
export type ComputingVariant<Input = unknown, Content = unknown> = {
  input: Input;
  content: Content;
};

/** The (union) input accepted across a set of computing variants. */
export type InputForVariants<V extends ComputingVariant> = V["input"];

/** The (union) content produced across a set of computing variants. */
export type ContentForVariants<V extends ComputingVariant> = V["content"];

/** The content a given input variant produces, selected across the union. */
type ContentForInput<V extends ComputingVariant, I> = V extends unknown
  ? I extends V["input"]
    ? V["content"]
    : never
  : never;

/**
 * A supplemental resource for a {@link computingProducerByInputType} producer:
 * a discriminated union over the variants, each pairing a variant's `input`
 * with that *same* variant's `content`. So a supplemental whose `input` is one
 * variant's input must carry that variant's content — that's what makes
 * "computing a collection also caches its items" type-safe.
 */
export type ComputingVariantSupplemental<
  V extends ComputingVariant,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = V extends unknown
  ? Omit<
      ProducerResultResource<CacheSpec<string, V["content"]>, Validators, Params>,
      "id"
    > & { input: V["input"] }
  : never;

/** What a single `.when(...)` branch's `produce` returns. */
type ComputingBranchResult<
  V extends ComputingVariant,
  NarrowedInput,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Omit<
  ComputingProducerResult<
    NarrowedInput,
    CacheSpec<string, ContentForInput<V, NarrowedInput>>,
    Validators,
    Params
  >,
  "supplementalResources"
> & {
  supplementalResources?: ComputingVariantSupplemental<V, Validators, Params>[];
};

/**
 * The producer built by {@link computingProducerByInputType}: an ordinary,
 * id-agnostic computing producer (its result omits the primary `id` and keys
 * supplementals by input), so it composes with whatever `string`-subtype id the
 * cache / `hashInput` use.
 */
type ComputingInputDispatchProducer<
  V extends ComputingVariant,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = (
  input: V["input"],
  options?: { signal?: AbortSignal },
) => Promise<
  ComputingProducerResult<
    V["input"],
    CacheSpec<string, V["content"]>,
    Validators,
    Params
  >
>;

/**
 * Error type produced by `.build()` when the chain hasn't covered every input
 * in `V["input"]`. Surfaces as a TS error wherever the build result is used
 * (e.g. the `wrapComputingProducer(...)` call site), naming the missing inputs.
 */
type _NonExhaustiveComputingBuildError<Missing> = readonly [
  "computingProducerByInputType: builder is non-exhaustive; missing `.when(...)` branches for these inputs:",
  Missing,
];

type _ComputingBuildResult<
  V extends ComputingVariant,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Covered extends V["input"],
> = [Exclude<V["input"], Covered>] extends [never]
  ? ComputingInputDispatchProducer<V, Validators, Params>
  : _NonExhaustiveComputingBuildError<Exclude<V["input"], Covered>>;

/**
 * The fluent builder returned by {@link computingProducerByInputType}. Use
 * `.when(...)` to add per-input-variant branches; each call infers its own
 * `NarrowedInput` from the type guard, so the handler's `input` is concrete and
 * TypeScript fully verifies the input → content correlation (and that any
 * supplementals pair an input with that input's content). End with `.build()`.
 *
 * The phantom `Covered` parameter accumulates the handled inputs so `.build()`
 * can statically verify the chain is exhaustive for `V["input"]`; a
 * non-exhaustive chain makes `.build()` return a {@link
 * _NonExhaustiveComputingBuildError} that isn't assignable to a producer.
 */
export type ComputingProducerByInputTypeBuilder<
  V extends ComputingVariant,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Covered extends V["input"] = never,
> = {
  readonly when: <NarrowedInput extends V["input"]>(
    matches: (input: V["input"]) => input is NarrowedInput,
    produce: (
      input: NarrowedInput,
      options?: { signal?: AbortSignal },
    ) => Promise<ComputingBranchResult<V, NarrowedInput, Validators, Params>>,
  ) => ComputingProducerByInputTypeBuilder<
    V,
    Validators,
    Params,
    Covered | NarrowedInput
  >;
  readonly build: () => _ComputingBuildResult<V, Validators, Params, Covered>;
};

// The erased internal branch type for the `branches` array: the narrowed input
// is widened back to the union, and the result is the dispatch-facing
// (id-agnostic) `ComputingProducerResult` that `build()` returns — not the
// authoring-facing `ComputingBranchResult` (whose correlated supplemental union
// only makes sense paired with a *narrowed* input). Per-branch correlation is
// enforced by the public generic `when`, not here.
type _ComputingInputBranch<
  V extends ComputingVariant,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  matches: (input: V["input"]) => boolean;
  produce: ComputingInputDispatchProducer<V, Validators, Params>;
};

/**
 * Builds a correlated computing producer for a heterogeneous cache by
 * dispatching on the input variant — the computing analog of `producerByIdType`.
 *
 * You declare a `Variants` *union* (each variant pairing an input with its
 * content) and add a branch per variant with `.when(guard, produce)`. Because
 * each branch's `produce` is authored against a single, narrowed input, the
 * type system enforces that it returns that variant's content, and that any
 * `supplementalResources` pair a variant's input with that variant's content
 * (so "computing a collection also caches its items" is checked end to end).
 *
 * The result is an ordinary computing producer: pass it (with a `hashInput`) to
 * {@link wrapComputingProducer}, exactly like a hand-written one. As with the
 * other computing wrappers, `hashInput` (input → id) is supplied separately and
 * is the caller's responsibility to keep coherent with the variants — the types
 * correlate input → content, not input → id. (The id can be any `string`
 * subtype; the producer is id-agnostic, so it composes with a branded cache.)
 *
 * Branches are tried in declaration order; if none matches at runtime the
 * producer rejects.
 *
 * ```ts
 * type Variants =
 *   | ComputingVariant<StoryInput, Story>
 *   | ComputingVariant<CollInput, Story[]>;
 *
 * const compute = wrapComputingProducer(
 *   { cache, hashInput },
 *   computingProducerByInputType<Variants>()
 *     .when((i): i is StoryInput => i.kind === "story", async (i) => ({ content: makeStory(i.id) }))
 *     .when((i): i is CollInput => i.kind === "collection", async (i) => ({
 *        content: i.ids.map(makeStory),
 *        supplementalResources: i.ids.map((id) => ({ input: { kind: "story", id }, content: makeStory(id) })),
 *     }))
 *     .build(),
 * );
 * ```
 */
export function computingProducerByInputType<
  V extends ComputingVariant,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(): ComputingProducerByInputTypeBuilder<V, Validators, Params> {
  // Internal mutable list of accumulated branches; `.when(...)` appends and
  // returns the same builder. The narrowed input type is erased here
  // (`V["input"]` is the safe upper bound) — it was verified at each `.when`.
  const branches: _ComputingInputBranch<V, Validators, Params>[] = [];

  const builder = {
    when(
      matches: _ComputingInputBranch<V, Validators, Params>["matches"],
      produce: _ComputingInputBranch<V, Validators, Params>["produce"],
    ) {
      branches.push({ matches, produce });
      return builder;
    },

    build() {
      const dispatch: ComputingInputDispatchProducer<V, Validators, Params> =
        async (input, options) => {
          for (const branch of branches) {
            if (branch.matches(input)) {
              // The guard confirmed `input` belongs to this branch; its
              // `produce` already returns the dispatch-facing result type.
              return branch.produce(input, options);
            }
          }
          throw new Error(
            `computingProducerByInputType: no branch matched the input ${JSON.stringify(input)}`,
          );
        };

      // Runtime value is always a producer; in the non-exhaustive case the user
      // gets a TS error at the consuming call site naming the missing inputs.
      return dispatch as unknown as _ComputingBuildResult<
        V,
        Validators,
        Params,
        never
      >;
    },
  };

  return builder as unknown as ComputingProducerByInputTypeBuilder<
    V,
    Validators,
    Params
  >;
}
