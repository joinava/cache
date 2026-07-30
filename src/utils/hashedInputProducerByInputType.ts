/**
 * @fileoverview The hashed-input producer builder: a `.when` chain over a
 * declared variant map that produces an opaque value only
 * {@link wrapHashedInputProducer}/`wrapBulkHashedInputProducer` can consume.
 *
 * Split out from the wrappers because it deliberately does not need them, or a
 * `Cache`: a hashed-input producer is a value in its own right, buildable and
 * reusable before any cache exists. The only thing it takes from the wrapper
 * side is a *type*, so nothing here imports a wrapper at runtime -- the runtime
 * edge runs the other way, the wrapper reading {@link builtBranches}.
 *
 * @module
 */
import type { ReadonlyDeep } from "type-fest";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  ProducerResultResource,
  RequestPairedProducerResult,
} from "../types/index.js";
import type { HashedInputProducerResult } from "./wrapHashedInputProducer.js";

/**
 * One variant of a hashed-input cache: the `input` a resource type's values are
 * computed FROM, paired with the `output` computed from it. A variant map --
 * resource-type name to variant -- is what {@link hashedInputProducerByInputType}
 * is declared over.
 *
 * There is deliberately no `id` here. A hashed-input cache's id is whatever
 * `hashInput` mints, which the builder infers per branch and the wrapper checks
 * against the registry.
 */
export type HashedInputVariant<Input, Output> = {
  readonly input: Input;
  readonly output: Output;
};

/** Constraint for a variant map. */
export type AnyHashedInputVariants = Record<
  string,
  HashedInputVariant<unknown, unknown>
>;

/**
 * Every input a variant map accepts, i.e. what a `.when` guard narrows FROM.
 * A guard proves only its OWN branch's input, so this is the only place the
 * whole union appears.
 */
type AllVariantInputs<V extends AnyHashedInputVariants> = V[keyof V]["input"];

/**
 * What one built branch's `produce` must resolve to. Everything is expressed
 * against the DECLARED variant map, so a branch is validated where it is
 * written -- no cache required (see {@link hashedInputProducerByInputType}).
 *
 * Input-keyed supplementals are correlated per target variant: the mapped type
 * pairs each variant's `input` with that SAME variant's `output`, so "computing
 * a collection also caches its stories" is checked rather than merely allowed.
 * Id-keyed supplementals need the registry's id space, which a cache-free
 * builder does not have, so they are typed against the `IdKeyedSpec` the
 * builder was declared with (`never`, i.e. unavailable, unless declared).
 */
type BuiltBranchResult<
  V extends AnyHashedInputVariants,
  Name extends keyof V & string,
  Validators extends AnyValidators,
  Params extends AnyParams,
  IdKeyedSpec extends CacheSpec,
> = Omit<
  RequestPairedProducerResult<
    CacheSpec<string, V[Name]["output"]>,
    Validators,
    Params
  >,
  "id" | "supplementalResources"
> & {
  supplementalResources?: (
    | {
        [S in keyof V & string]: Omit<
          ProducerResultResource<
            CacheSpec<string, V[S]["output"]>,
            Validators,
            Params
          >,
          "id"
        > & { input: V[S]["input"]; id?: never };
      }[keyof V & string]
    | (IdKeyedSpec extends unknown
        ? ProducerResultResource<IdKeyedSpec, Validators, Params> & {
            input?: never;
          }
        : never)
  )[];
};

/**
 * The type-level record a {@link HashedInputProducer} carries so that
 * {@link wrapHashedInputProducer} can check it against a cache's registry. Bundled
 * into one object rather than seven type parameters, since consumers never
 * write it.
 */
export type HashedInputProducerMeta = {
  /**
   * Which wrapper this producer is for. Both builders hand back the same
   * carrier, so without this a bulk producer would satisfy the single wrapper's
   * parameter and fail at runtime when handed one input instead of a batch.
   */
  readonly kind: "single" | "bulk";
  readonly covered: string;
  readonly inputs: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly mintedIds: Record<string, string>;
  readonly validators: AnyValidators;
  readonly params: AnyParams;
  readonly idKeyedSpec: CacheSpec;
  /** Only meaningful for `kind: "bulk"`; the single builder stamps `never`. */
  readonly errorType: Error;
};

/**
 * The key under which a built producer carries its branch table.
 *
 * Exported only so the wrappers, now in their own module, can read it; it is
 * deliberately NOT re-exported from the package's entry point, so a
 * `HashedInputProducer` stays opaque to its holder and consumable only by the
 * hashed-input wrappers. Keep it out of `src/index.ts`.
 */
export const builtBranches = Symbol("hashedInputProducer.branches");

/**
 * A built, cache-free hashed-input producer. Opaque by construction, but carrying
 * its per-branch types in `Meta` so the wrapper can verify each branch against
 * the registry it will actually run over.
 *
 * `meta` is a phantom: it appears only in the type and is never written at
 * runtime (`build()` has only real branches to hand over). It has to appear
 * somewhere, though -- without it `Meta` would be an unused parameter, and any
 * two `HashedInputProducer`s would be mutually assignable, which is what would let
 * a bulk producer satisfy the single wrapper's parameter. The types are fully
 * present regardless, because `build()`'s declared return type carries them.
 */
export type HashedInputProducer<Meta extends HashedInputProducerMeta> = {
  readonly [builtBranches]: {
    readonly entries: readonly (readonly [string, LooseBranch<never>])[];
    readonly meta?: Meta;
  };
};

/**
 * Accumulates branches for a heterogeneous hashed-input cache, one `.when` per
 * covered resource type, with NO cache involved -- a producer is a value in its
 * own right, buildable (and reusable) before any cache exists, and checked
 * against a cache only when the two are wired together.
 *
 * `name` selects the variant; the guard is only the runtime dispatcher. That
 * split matters in two ways an input-derived selection could not manage: two
 * variants may be computed from the SAME input type (a summary and a
 * translation of one story) without becoming ambiguous, and a guard may prove a
 * SUBTYPE of the declared input rather than having to match it exactly.
 */
export type HashedInputProducerBuilder<
  V extends AnyHashedInputVariants,
  Validators extends AnyValidators,
  Params extends AnyParams,
  IdKeyedSpec extends CacheSpec,
  Covered extends keyof V & string,
  MintedIds extends Record<string, string>,
> = {
  /**
   * Adds the branch for one variant. `Name` is constrained to the variants NOT
   * yet covered, so a second `.when` for the same variant is rejected where it
   * is written rather than silently shadowed at runtime.
   */
  when<
    Name extends Exclude<keyof V & string, Covered>,
    Input extends V[Name]["input"],
    Id extends string,
  >(
    matchesInput: (input: AllVariantInputs<V>) => input is Input,
    branch: {
      readonly name: Name;
      /**
       * Must mint ids the variant's resource type accepts -- checked against
       * the registry when this producer is wired to a cache, and again at
       * runtime by classifying each minted id (see {@link checkMintedId}).
       */
      hashInput: (input: Input) => Id | Promise<Id>;
      produce: (
        // `ReadonlyDeep` and no `AbortSignal`, for the reasons on
        // `RequestPairedProducer`: the input may be shared between collapsed
        // callers, and the invocation forwards no signal.
        input: ReadonlyDeep<Input>,
      ) => Promise<BuiltBranchResult<V, Name, Validators, Params, IdKeyedSpec>>;
    },
  ): HashedInputProducerBuilder<
    V,
    Validators,
    Params,
    IdKeyedSpec,
    Covered | Name,
    MintedIds & { readonly [K in Name]: Id }
  >;
  /**
   * Finishes the producer. Coverage is whatever was added: any non-empty subset
   * of the variant map. Building with no branches at all throws, since the
   * result could never produce anything.
   */
  build(): HashedInputProducer<{
    kind: "single";
    covered: Covered;
    inputs: { readonly [K in Covered]: V[K]["input"] };
    outputs: { readonly [K in Covered]: V[K]["output"] };
    mintedIds: MintedIds;
    validators: Validators;
    params: Params;
    idKeyedSpec: IdKeyedSpec;
    errorType: never;
  }>;
};

/**
 * One `.when` argument, type-erased the way {@link LooseBranch} is: the public
 * signature has already checked the branch against its own variant at the call
 * site, so all the chain itself needs is that the fields are there.
 */
type LooseBranchArg = {
  readonly name: string;
  readonly hashInput: LooseBranch<never>["hashInput"];
  /**
   * Erased further than the rest, because this chain serves both entry points
   * and their `produce`s genuinely disagree: the single form returns one result,
   * the bulk form an array of them. Which one a branch holds is known to the
   * wrapper that reads it (`wrapBulkHashedInputProducer` re-reads the entries as
   * its local `LooseBulkBranch`), never to the chain.
   */
  readonly produce: (input: never) => Promise<unknown>;
};

/**
 * The internal, type-erased shape of the builder chain, shared by the single
 * and bulk entry points.
 *
 * Deliberately NOT the public builder type: `.when` accumulates
 * `Covered`/`MintedIds` into its own return type, which one runtime signature
 * cannot express -- hence the erasing cast at each entry point. Everything
 * else about the chain is checkable, though, and none of it was being checked
 * while this function returned `unknown`: that both methods exist and are
 * spelled the way the public type spells them, that `.when` returns another
 * chain rather than (say) the entries array, that the duplicate-name guard
 * reads a `name` that is really present, and that `build()` returns the
 * {@link builtBranches} carrier the wrappers read.
 */
type LooseBuilderChain = {
  when: (
    matchesInput: (input: never) => boolean,
    branch: LooseBranchArg,
  ) => LooseBuilderChain;
  build: () => {
    readonly [builtBranches]: {
      readonly entries: readonly (readonly [string, LooseBranch<never>])[];
    };
  };
};

/**
 * The runtime behind both entry points' builders: an immutable chain that
 * accumulates branches and hands them to the wrappers under
 * {@link builtBranches}. `builderName` only names the thrower in errors.
 */
function makeBuilderChain(
  builderName: string,
  entries: readonly (readonly [string, LooseBranch<never>])[],
): LooseBuilderChain {
  return {
    when: (matchesInput, branch) => {
      if (entries.some(([name]) => name === branch.name)) {
        // `Name extends Exclude<keyof V & string, Covered>` already rejects a
        // repeat name, so reaching here took a cast -- and the duplicate would
        // not merely be shadowed: dispatch takes the FIRST matching branch
        // while the per-resource-type producer table keeps the LAST, so the
        // second branch's content would be stored under the first branch's
        // minted id.
        throw new Error(
          `${builderName}: \`.when\` was called twice for branch ` +
            `"${branch.name}"; each variant may be covered only once.`,
        );
      }
      return makeBuilderChain(builderName, [
        ...entries,
        [
          branch.name,
          {
            hashInput: branch.hashInput,
            // SAFETY: re-narrows the single-form `produce` this entries array
            // declares. A bulk branch really does return an array here, which is
            // why the bulk wrapper re-reads the entries as `LooseBulkBranch`.
            produce: branch.produce as LooseBranch<never>["produce"],
            // SAFETY (variance only): a guard is declared over its own variant's
            // input at the call site, but `findBranch` has to call every branch's
            // guard with an as-yet-unclassified input. `name` is deliberately not
            // carried over: a stored branch is keyed by it, and `LooseBranch`
            // never declared it.
            matchesInput: matchesInput as NonNullable<
              LooseBranch<never>["matchesInput"]
            >,
          },
        ],
      ]);
    },
    build: () => {
      if (entries.length === 0) {
        throw new Error(
          `${builderName}: \`.build()\` was called with no \`.when\` branches, ` +
            "so the producer could never produce anything.",
        );
      }
      return { [builtBranches]: { entries } };
    },
  };
}

/**
 * Starts a {@link HashedInputProducerBuilder} over a declared variant map. Curried
 * because the map cannot be inferred from anything, and TS has no partial
 * type-argument inference.
 *
 * ```ts
 * const producer = hashedInputProducerByInputType<{
 *   story: HashedInputVariant<StoryInput, Story>;
 *   collection: HashedInputVariant<CollInput, Story[]>;
 * }>()
 *   .when((i): i is StoryInput => i.kind === "story", {
 *     name: "story",
 *     hashInput: (input) => `extract:story:${input.id}`,
 *     produce: async (input) => ({ content: makeStory(input.id) }),
 *   })
 *   .build();
 *
 * const compute = wrapHashedInputProducer({ cache, hashedInputProducer: producer });
 * ```
 *
 * `Validators`/`Params` are declared here rather than taken from a cache
 * because a branch's result carries them (`validators`, `vary`), and there is
 * no cache to read them from; the wrapper requires the cache to agree. Likewise
 * `IdKeyedSpec`: pass a registry's `SpecOf` to return id-keyed supplementals
 * (see {@link BuiltBranchResult}).
 */
export function hashedInputProducerByInputType<
  V extends AnyHashedInputVariants,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  IdKeyedSpec extends CacheSpec = never,
>(): HashedInputProducerBuilder<
  V,
  Validators,
  Params,
  IdKeyedSpec,
  never,
  Record<string, never>
> {
  // SAFETY: the builder is a chain of closures whose only type-level job is to
  // accumulate `Covered`/`MintedIds`; the runtime value carries no types, so
  // the accumulation cannot be expressed in the implementation. Every branch
  // the chain stores came from a `.when` call the signature above type-checked.
  return makeBuilderChain(
    "hashedInputProducerByInputType",
    [],
  ) as HashedInputProducerBuilder<
    V,
    Validators,
    Params,
    IdKeyedSpec,
    never,
    Record<string, never>
  >;
}

/**
 * The bulk analogue of {@link HashedInputProducerBuilder}: each branch's `produce`
 * computes a batch of that branch's missed inputs, returning a result (or an
 * `ErrorType`) per input, aligned by index.
 */
export type BulkHashedInputProducerBuilder<
  V extends AnyHashedInputVariants,
  Validators extends AnyValidators,
  Params extends AnyParams,
  IdKeyedSpec extends CacheSpec,
  ErrorType extends Error,
  Covered extends keyof V & string,
  MintedIds extends Record<string, string>,
> = {
  /** See {@link HashedInputProducerBuilder}'s `when`. */
  when<
    Name extends Exclude<keyof V & string, Covered>,
    Input extends V[Name]["input"],
    Id extends string,
  >(
    matchesInput: (input: AllVariantInputs<V>) => input is Input,
    branch: {
      readonly name: Name;
      hashInput: (input: Input) => Id | Promise<Id>;
      produce: (
        inputs: readonly ReadonlyDeep<Input>[],
      ) => Promise<
        readonly (
          | BuiltBranchResult<V, Name, Validators, Params, IdKeyedSpec>
          | ErrorType
        )[]
      >;
    },
  ): BulkHashedInputProducerBuilder<
    V,
    Validators,
    Params,
    IdKeyedSpec,
    ErrorType,
    Covered | Name,
    MintedIds & { readonly [K in Name]: Id }
  >;
  /** See {@link HashedInputProducerBuilder}'s `build`. */
  build(): HashedInputProducer<{
    kind: "bulk";
    covered: Covered;
    inputs: { readonly [K in Covered]: V[K]["input"] };
    outputs: { readonly [K in Covered]: V[K]["output"] };
    mintedIds: MintedIds;
    validators: Validators;
    params: Params;
    idKeyedSpec: IdKeyedSpec;
    errorType: ErrorType;
  }>;
};

/**
 * Starts a {@link BulkHashedInputProducerBuilder}. Same contract as
 * {@link hashedInputProducerByInputType}, for {@link wrapBulkHashedInputProducer}.
 */
export function bulkHashedInputProducerByInputType<
  V extends AnyHashedInputVariants,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  IdKeyedSpec extends CacheSpec = never,
  ErrorType extends Error = Error,
>(): BulkHashedInputProducerBuilder<
  V,
  Validators,
  Params,
  IdKeyedSpec,
  ErrorType,
  never,
  Record<string, never>
> {
  // SAFETY: as in hashedInputProducerByInputType.
  return makeBuilderChain(
    "bulkHashedInputProducerByInputType",
    [],
  ) as BulkHashedInputProducerBuilder<
    V,
    Validators,
    Params,
    IdKeyedSpec,
    ErrorType,
    never,
    Record<string, never>
  >;
}

/**
 * The internal, type-erased branch shape all wrapper plumbing dispatches
 * through. SAFETY: a branch is only invoked for inputs its own `matchesInput`
 * accepted, and each minted id is classified against the branch's own resource
 * type before use.
 */
export type LooseBranch<Input> = {
  /**
   * Absent only for the single-producer form's sole entry, which has no guard to
   * dispatch on and so matches every input (see {@link findBranch}). Every
   * `.when` branch carries one.
   */
  matchesInput?: (input: unknown) => boolean;
  hashInput: (input: Input) => string | Promise<string>;
  produce: (
    input: ReadonlyDeep<Input>,
  ) => Promise<
    HashedInputProducerResult<Input, CacheSpec, AnyValidators, AnyParams>
  >;
};
