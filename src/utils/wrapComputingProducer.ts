import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ConsumerRequest,
  ProducerResultResource,
  RequestPairedProducer,
  RequestPairedProducerResult,
} from "../types/index.js";
import type { PartialConsumerRequest } from "./requestPairedProducerUtils.js";
import { wrapBulkProducer, type BulkProducer } from "./wrapBulkProducer.js";
import wrapProducer, { type WrapProducerOptions } from "./wrapProducer.js";

/**
 * ## Computing producers vs. (plain) producers
 *
 * `wrapProducer`/`wrapBulkProducer` model a cache as a **lookup of a mutable
 * entity by its id**: the caller already has the id, and the cached value is a
 * function of that id and time (e.g. "the current `User` for `user:123`"). The
 * id is the natural cache key, so the producer receives it directly.
 *
 * `wrapComputingProducer`/`wrapBulkComputingProducer` model the other common
 * case: the cached value is an **expensive-to-compute function of some input**,
 * reused whenever the same input recurs (e.g. an LLM extraction over a chunk of
 * text, a rendered template, a compiled artifact). Here the *input* is the
 * identity of the work, so a hash of the input is the natural cache key — but
 * the producer wants the original, un-hashed input to actually do the
 * computation. These wrappers encapsulate exactly that: you provide a
 * `hashInput` function and a producer that takes the full `Input`, and they
 * derive the cache id, keep the input around just long enough to hand it to the
 * producer on a miss, and otherwise behave like `wrapProducer` /
 * `wrapBulkProducer` (same caching, request-collapsing, stale-while-revalidate,
 * abort, and diagnostics behavior; see {@link WrapProducerOptions}).
 *
 * ## Supplemental resources are keyed by input, not id
 *
 * Like plain producers, a computing producer can return `supplementalResources`
 * — values it produced as a byproduct that are worth caching — and a union
 * `CacheSpec` lets those be a different content type than the primary (the
 * classic "computing a collection also yields its individual items" case). The
 * one twist that follows from keys being input-hashes: a supplemental is
 * identified by the **input** it would be computed from, not a bare id. The
 * wrapper hashes each supplemental's input the same way it hashes the primary
 * input, so a later `compute(thatInput)` finds it as a cache hit. (A bare id
 * would be unreachable, since computing lookups only ever go through
 * `hashInput`.)
 *
 * ## Correlating input to content
 *
 * For a union `CacheSpec`, `wrapComputingProducer` alone can't verify that
 * `hashInput` and the `producer` agree on a content type per input variant —
 * they're separate functions, so that coherence is the caller's responsibility
 * (just as a hand-written multi-id-type plain producer's would be). When you
 * want it enforced, build the producer with {@link computingProducerByInputType}
 * — the computing analog of `producerByIdType` — which dispatches per input
 * variant and checks input → content (and supplementals) end to end.
 *
 * @module
 */

/**
 * A supplemental resource returned by a computing producer: like a plain
 * {@link ProducerResultResource}, but identified by the **input** it would be
 * computed from instead of a bare `id`. The wrapper hashes that input to derive
 * the storage id, so the resource is reachable by a later `compute(input)`.
 */
type ComputingSupplementalResource<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Spec extends unknown
  ? Omit<ProducerResultResource<Spec, Validators, Params>, "id"> & {
      input: Input;
    }
  : never;

/**
 * What a computing producer returns: like a plain
 * {@link RequestPairedProducerResult}, but the primary carries no `id` (it's
 * stamped on from the derived hash) and `supplementalResources` are keyed by
 * input (see {@link ComputingSupplementalResource}).
 */
type ComputingProducerResult<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Omit<
  RequestPairedProducerResult<Spec, Validators, Params>,
  "id" | "supplementalResources"
> & {
  supplementalResources?: ComputingSupplementalResource<
    Input,
    Spec,
    Validators,
    Params
  >[];
};

/**
 * A reference-counted registry mapping a derived cache id back to the input it
 * was hashed from, so the internal producer can recover the input on a miss.
 *
 * Reference counting (rather than a plain set/delete) is required because of
 * request collapsing: several concurrent calls for the same input derive the
 * same id and may share a single producer call. If the first caller to settle
 * deleted the entry, a still-in-flight caller (or the shared producer call)
 * could find it missing. Each call `acquire`s on the way in and `release`s in a
 * `finally`; the entry is dropped only when the last holder releases it. This
 * keeps the map bounded (unlike a process-lifetime map), since nothing is
 * retained past the calls that need it.
 *
 * Soundness of "release after the wrapped call settles": the underlying
 * `wrapProducer`/`wrapBulkProducer` invoke the producer *synchronously* while
 * the wrapped call is still running (including the fire-and-forget
 * stale-while-revalidate refresh), and our internal producer reads the input as
 * its first, synchronous step — so the read always happens before the release.
 */
class InputRegistry<Input> {
  private readonly entries = new Map<
    string,
    { input: Input; refCount: number }
  >();

  acquire(id: string, input: Input): void {
    const existing = this.entries.get(id);
    if (existing) {
      existing.refCount += 1;
      // Keep the latest input. For a given id the inputs are equal (barring an
      // astronomically unlikely hash collision), so this is a no-op in practice.
      existing.input = input;
    } else {
      this.entries.set(id, { input, refCount: 1 });
    }
  }

  get(id: string): Input {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(
        `wrapComputingProducer: no input is registered for cache id "${id}". ` +
          "The producer was invoked for a key this wrapper did not produce, " +
          "which should be impossible (it would indicate a hash collision or a bug).",
      );
    }
    return entry.input;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.entries.delete(id);
    }
  }
}

/** Shared options for {@link wrapComputingProducer} / {@link wrapBulkComputingProducer}. */
type ComputingProducerOptions<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Omit<WrapProducerOptions<Params>, "isCacheable"> & {
  cache: PublicInterface<Cache<Spec, Validators, Params>>;
  hashInput: (input: Input) => Spec["id"] | Promise<Spec["id"]>;
  isCacheable?(this: void, input: Input): boolean;
};

/**
 * Shared setup for both computing wrappers: splits out the cache and hashing,
 * builds the input registry and supplemental hasher, and adapts the
 * input-based `isCacheable` to the id-based one `wrapProducer` expects.
 */
function computingProducerSetup<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  options: ComputingProducerOptions<Input, Spec, Validators, Params>,
): {
  cache: PublicInterface<Cache<Spec, Validators, Params>>;
  hashInput: (input: Input) => Spec["id"] | Promise<Spec["id"]>;
  registry: InputRegistry<Input>;
  hashSupplementals: (
    result: ComputingProducerResult<Input, Spec, Validators, Params>,
  ) => Promise<RequestPairedProducerResult<Spec, Validators, Params>>;
  baseOptions: WrapProducerOptions<Params>;
} {
  const {
    cache,
    hashInput,
    isCacheable: isInputCacheable,
    ...wrapOptions
  } = options;
  const registry = new InputRegistry<Input>();
  const hashSupplementals = makeSupplementalHasher<
    Input,
    Spec,
    Validators,
    Params
  >(hashInput);
  const baseOptions: WrapProducerOptions<Params> = {
    ...wrapOptions,
    // `registry.get` runs synchronously inside `wrapProducer`'s `isCacheable`
    // check, while the id is still registered.
    ...(isInputCacheable
      ? { isCacheable: (id: string) => isInputCacheable(registry.get(id)) }
      : {}),
  };
  return { cache, hashInput, registry, hashSupplementals, baseOptions };
}

/**
 * Builds the consumer request for a derived id. The cast bridges to
 * `PartialConsumerRequest`, whose id/directives are `ReadonlyDeep`-wrapped and
 * so opaque against the plain types here while the spec is generic — the same
 * boundary coercion `wrapProducer` uses. The conditional spread avoids passing
 * `directives: undefined` (rejected under `exactOptionalPropertyTypes`).
 */
function buildComputingRequest<Params extends AnyParams, Id extends string>(
  id: Id,
  directives: ConsumerDirectives | undefined,
): PartialConsumerRequest<Params, Id> {
  return {
    id,
    ...(directives ? { directives } : {}),
  } as PartialConsumerRequest<Params, Id>;
}

/**
 * Like {@link wrapProducer}, but for a "computing producer" whose value is a
 * function of an `Input` rather than a lookup by id. You provide `hashInput`
 * (to derive the cache id from the input) and a producer that receives the full
 * input; the returned function is called with the input directly.
 *
 * See the module docs for when to use this vs. {@link wrapProducer}.
 *
 * @param options - The same options as {@link wrapProducer}, plus: `cache` (the
 *   {@link Cache} to use — in the options object rather than a separate
 *   argument); `hashInput`, which derives the cache id from the input (sync or
 *   async, and returns the cache's `id` type so callers can mint a branded key);
 *   and an `isCacheable` that receives the **input** rather than an opaque id.
 * @param producer - Computes the value from the full input on a cache miss. See
 *   {@link ComputingProducerResult} for the return shape (no primary `id`;
 *   supplemental resources keyed by input).
 */
export function wrapComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  options: ComputingProducerOptions<Input, Spec, Validators, Params>,
  producer: (
    input: Input,
    producerOptions?: { signal?: AbortSignal },
  ) => Promise<ComputingProducerResult<Input, Spec, Validators, Params>>,
) {
  const { cache, hashInput, registry, hashSupplementals, baseOptions } =
    computingProducerSetup<Input, Spec, Validators, Params>(options);

  // `registry.get` runs synchronously before `producer` is invoked, so the
  // input is read while still registered (see InputRegistry docs). The cast
  // bridges the explicit signature to the `RequestPairedProducer` conditional
  // type, which is opaque while `Spec` is an unresolved generic — the same
  // coercion `wrapProducer` performs internally.
  const internalProducer = (async <Id extends Spec["id"]>(
    req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
    producerOptions?: { signal?: AbortSignal },
  ) => {
    const input = registry.get(req.id);
    return hashSupplementals(await producer(input, producerOptions));
  }) as unknown as RequestPairedProducer<Spec, Validators, Params>;

  const wrapped = wrapProducer<Spec, Validators, Params>(
    cache,
    baseOptions,
    internalProducer,
  );

  const wrappedComputingProducer = async (
    input: Input,
    callOptions?: { directives?: ConsumerDirectives; signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // `Awaited` doesn't reduce under the generic `Spec`, even though `Spec["id"]`
    // extends `string` (so can't be a thenable); the cast restores the id type.
    const id = (await hashInput(input)) as Spec["id"];
    signal?.throwIfAborted();

    registry.acquire(id, input);
    try {
      return await wrapped(
        buildComputingRequest<Params, Spec["id"]>(id, callOptions?.directives),
        signal ? { signal } : undefined,
      );
    } finally {
      registry.release(id);
    }
  };

  // Expose the cache on the returned function (for convenience, e.g. closing it).
  wrappedComputingProducer.cache = cache;

  return wrappedComputingProducer;
}

/**
 * The bulk analogue of {@link wrapComputingProducer}, layered over
 * {@link wrapBulkProducer}: looks each input's derived id up in the cache and
 * calls the producer only for the inputs that missed, computing them as a
 * single batch. Results are returned per input, aligned by index.
 *
 * See the module docs for when to use this vs. {@link wrapBulkProducer}.
 *
 * @param options - Same as {@link wrapComputingProducer}'s options.
 * @param producer - Computes the values for the missed inputs on a cache miss,
 *   returning a result (or `ErrorType`) per input, aligned by index.
 */
export function wrapBulkComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  options: ComputingProducerOptions<Input, Spec, Validators, Params>,
  producer: (
    inputs: readonly Input[],
    producerOptions?: { signal?: AbortSignal },
  ) => Promise<
    (ComputingProducerResult<Input, Spec, Validators, Params> | ErrorType)[]
  >,
) {
  const { cache, hashInput, registry, hashSupplementals, baseOptions } =
    computingProducerSetup<Input, Spec, Validators, Params>(options);

  // Each `registry.get` runs synchronously (while mapping) before `producer`
  // is invoked, so every input is read while still registered.
  const internalProducer: BulkProducer<Spec, Validators, Params, ErrorType> = (
    reqs,
    producerOptions,
  ) => {
    const inputs = reqs.map((req) => registry.get(req.id));
    return producer(inputs, producerOptions).then((results) =>
      Promise.all(
        results.map(async (result) =>
          result instanceof Error ? result : hashSupplementals(result),
        ),
      ),
    );
  };

  const wrapped = wrapBulkProducer<Spec, Validators, Params, ErrorType>(
    cache,
    baseOptions,
    internalProducer,
  );

  const wrappedBulkComputingProducer = async (
    inputs: readonly Input[],
    callOptions?: { directives?: ConsumerDirectives; signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // `Promise.resolve` since `hashInput` may be synchronous; cast for the same
    // reason as the single-producer variant.
    const ids = (await Promise.all(
      inputs.map((input) => Promise.resolve(hashInput(input))),
    )) as Spec["id"][];
    signal?.throwIfAborted();

    ids.forEach((id, index) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index-aligned with `ids`
      registry.acquire(id, inputs[index]!);
    });
    try {
      return await wrapped(
        ids.map((id) =>
          buildComputingRequest<Params, Spec["id"]>(id, callOptions?.directives),
        ),
        signal ? { signal } : undefined,
      );
    } finally {
      ids.forEach((id) => registry.release(id));
    }
  };

  // Expose the cache on the returned function (for convenience, e.g. closing it).
  wrappedBulkComputingProducer.cache = cache;

  return wrappedBulkComputingProducer;
}

/**
 * Builds the function that turns a {@link ComputingProducerResult} into the
 * plain {@link RequestPairedProducerResult} the underlying producer machinery
 * expects, by hashing each supplemental resource's `input` into its storage id.
 *
 * The casts reconstruct the canonical result shape from the computing result
 * (which differs only by how supplementals are keyed); TS can't track the
 * distributive transform across the `Omit`/re-add.
 */
function makeSupplementalHasher<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(hashInput: (input: Input) => Spec["id"] | Promise<Spec["id"]>) {
  return async (
    result: ComputingProducerResult<Input, Spec, Validators, Params>,
  ): Promise<RequestPairedProducerResult<Spec, Validators, Params>> => {
    const { supplementalResources, ...primary } = result;
    if (!supplementalResources || supplementalResources.length === 0) {
      return primary as unknown as RequestPairedProducerResult<
        Spec,
        Validators,
        Params
      >;
    }

    const hashed = await Promise.all(
      supplementalResources.map(async (resource) => {
        const { input, ...rest } = resource;
        return { ...rest, id: await Promise.resolve(hashInput(input)) };
      }),
    );

    return {
      ...primary,
      supplementalResources: hashed,
    } as unknown as RequestPairedProducerResult<Spec, Validators, Params>;
  };
}

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
