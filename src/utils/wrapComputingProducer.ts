import pLimit from "p-limit";
import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import { AmbiguousResourceTypeError, UnclassifiableIdError } from "../Cache.js";
import type { CacheSpec, SpecForId } from "../types/00_CacheSpec.js";
import type {
  ContentOfResourceType,
  IdOfResourceType,
  ResourceTypeName,
  ResourceTypes,
  SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  Entry,
  ProducerResultResource,
  RequestPairedProducerResult,
} from "../types/index.js";
import { zip2 } from "./utils.js";
import wrapProducer, {
  producerByIdType,
  type ProducersFor,
  type WrapProducerOptions,
} from "./wrapProducer.js";
import {
  bulkProducerByIdType,
  wrapBulkProducer,
  type BulkProducersFor,
} from "./wrapBulkProducer.js";

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
 * computation. These wrappers encapsulate exactly that: a `hashInput` derives
 * the cache id from an input and a `produce` takes the full input, and the
 * wrapper keeps the input around just long enough to hand it over on a miss,
 * otherwise behaving like `wrapProducer` / `wrapBulkProducer` (same caching,
 * request-collapsing, stale-while-revalidate, abort, and diagnostics behavior;
 * see {@link WrapProducerOptions}).
 *
 * ## One resource type, or several
 *
 * A cache with one resource type needs nothing but the two functions:
 *
 * ```ts
 * const compute = wrapComputingProducer({ cache, hashInput, produce });
 * ```
 *
 * For several, {@link hashingProducerByInputType} builds a *hashing producer* —
 * one `.when` per covered resource type, dispatching on the input — and the
 * wrapper takes that instead:
 *
 * ```ts
 * const compute = wrapComputingProducer({ cache, hashingProducer });
 * ```
 *
 * A hashing producer is built with **no cache**: it is a value in its own right,
 * constructible (and reusable) before any cache exists, and checked against a
 * cache's registry only where the two are wired together. Coverage is whatever
 * the chain added — any non-empty subset of the registry.
 *
 * ## Minted ids
 *
 * Because computing ids are hashes, the registry's in-band-discriminator
 * requirement falls on `hashInput`: a branch's `hashInput` must mint ids that
 * its resource type's `matches` guard accepts. That is checked twice. At compile
 * time, wiring a hashing producer to a cache compares each branch's minted-id
 * type against its variant's `IdOfResourceType`. At runtime, each hashed id is
 * classified before it is used for anything, and a mismatch throws
 * `UnclassifiableIdError`/`AmbiguousResourceTypeError` naming the branch — the
 * backstop for a mint that reached the wrapper through a cast or an untyped
 * boundary. For accept-everything registries the runtime check is vacuous (the
 * guard accepts every id), and the compile-time one carries the weight.
 *
 * The single-producer form declares no resource type, so there is no name to
 * check a mint against; classifying the id at all is the whole runtime check
 * there.
 *
 * ## Supplemental resources: input-keyed or id-keyed
 *
 * Like plain producers, a computing producer can return `supplementalResources`
 * — values it produced as a byproduct that are worth caching. They come in
 * two forms, distinguished by which key is present:
 *
 * - **Input-keyed** (`{ input, content, … }`): identified by the input the
 *   value would be computed from. The wrapper routes the input through the
 *   same `matchesInput` branch selection it applies to call-time inputs,
 *   hashes it with the routed branch's `hashInput` (so any COVERED branch
 *   can be the target, not just the producing one), and mint-checks the
 *   result against that branch's type — a bad mint rejects the invocation
 *   loudly, naming the branch. A later `compute(thatInput)` finds the entry
 *   as a cache hit. In a hashing producer these are correlated per variant:
 *   the `input` and `content` must come from the SAME variant, so "computing a
 *   collection also caches its stories" is checked rather than merely allowed.
 * - **Id-keyed** (`{ id, content, … }`, a plain {@link ProducerResultResource}):
 *   for ANY registry type, covered or not — exactly what plain producers'
 *   supplementals are. Classified by their own id at store time. This makes
 *   computing wrappers used as "hashed-input producers" (for key privacy
 *   rather than pure computation) full peers of `wrapProducer`: derive the
 *   primary key by hashing, and still supplementally store other resources
 *   under their natural ids. Typing these needs the registry's id space, which
 *   the single-producer form has; a (cache-free) hashing producer must be
 *   declared with the registry's `SpecOf` to return them — see
 *   {@link hashingProducerByInputType}.
 *
 * @module
 */

/**
 * Cap on concurrent `hashInput` calls — for both bulk input hashing and
 * supplemental hashing — so a large batch with a possibly-async `hashInput`
 * doesn't flood the event loop.
 */
const HASH_CONCURRENCY = 10;

/**
 * What a computing producer returns: like a plain
 * {@link RequestPairedProducerResult}, but the primary carries no `id` (it's
 * stamped on from the derived hash), and each `supplementalResources` entry
 * is either **input-keyed** (`{ input, … }` — hashed and mint-checked via
 * the `matchesInput`-routed covered branch) or **id-keyed** (`{ id, … }` —
 * a plain {@link ProducerResultResource} for any registry type, classified
 * at store time). See the module docs.
 */
export type ComputingProducerResult<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  /**
   * The union of specs input-keyed supplementals may target. The wrappers
   * pass every COVERED branch's spec (inputs route by `matchesInput`, so
   * any covered branch can produce a supplemental); defaults to `Spec` so a
   * bare 4-arg instantiation keeps the producing-branch-confined meaning.
   */
  CoveredSpec extends CacheSpec = Spec,
  /**
   * The union of specs id-keyed supplementals may target. The wrappers pass
   * the FULL registry union (id-keyed supplementals are classified by their
   * own id at store time, like plain producers').
   */
  RegistrySpec extends CacheSpec = Spec,
> = Omit<
  RequestPairedProducerResult<Spec, Validators, Params>,
  "id" | "supplementalResources"
> & {
  supplementalResources?: (
    | (CoveredSpec extends unknown
        ? Omit<
            ProducerResultResource<CoveredSpec, Validators, Params>,
            "id"
          > & {
            input: Input;
            id?: never;
          }
        : never)
    | (RegistrySpec extends unknown
        ? ProducerResultResource<RegistrySpec, Validators, Params> & {
            input?: never;
          }
        : never)
  )[];
};

/**
 * One variant of a computing cache: the `input` a resource type's values are
 * computed FROM, paired with the `output` computed from it. A variant map --
 * resource-type name to variant -- is what {@link hashingProducerByInputType}
 * is declared over.
 *
 * There is deliberately no `id` here. A computing cache's id is whatever
 * `hashInput` mints, which the builder infers per branch and the wrapper checks
 * against the registry.
 */
export type ComputingVariant<Input, Output> = {
  readonly input: Input;
  readonly output: Output;
};

/** Constraint for a variant map. */
type AnyComputingVariants = Record<string, ComputingVariant<unknown, unknown>>;

/**
 * Every input a variant map accepts, i.e. what a `.when` guard narrows FROM.
 * A guard proves only its OWN branch's input, so this is the only place the
 * whole union appears.
 */
type AllVariantInputs<V extends AnyComputingVariants> = V[keyof V]["input"];

/**
 * What one built branch's `produce` must resolve to. Everything is expressed
 * against the DECLARED variant map, so a branch is validated where it is
 * written -- no cache required (see {@link hashingProducerByInputType}).
 *
 * Input-keyed supplementals are correlated per target variant: the mapped type
 * pairs each variant's `input` with that SAME variant's `output`, so "computing
 * a collection also caches its stories" is checked rather than merely allowed.
 * Id-keyed supplementals need the registry's id space, which a cache-free
 * builder does not have, so they are typed against the `IdKeyedSpec` the
 * builder was declared with (`never`, i.e. unavailable, unless declared).
 */
type BuiltBranchResult<
  V extends AnyComputingVariants,
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
 * The type-level record a {@link HashingProducer} carries so that
 * {@link wrapComputingProducer} can check it against a cache's registry. Bundled
 * into one object rather than seven type parameters, since consumers never
 * write it.
 */
type HashingProducerMeta = {
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
 * The module-private key under which a built producer carries its branch table.
 * Not exported, so the branches are unreachable from outside this module: a
 * `HashingProducer` is opaque to its holder and consumable only by the
 * computing wrappers.
 */
const builtBranches = Symbol("hashingProducer.branches");

/**
 * A built, cache-free computing producer. Opaque by construction, but carrying
 * its per-branch types in `Meta` so the wrapper can verify each branch against
 * the registry it will actually run over.
 *
 * The `Meta` phantoms are OPTIONAL and never written at runtime: `build()` only
 * has real branches to hand over, and making them required would force a cast
 * there. The types are still fully present, because `build()`'s declared return
 * type is what carries them.
 */
export type HashingProducer<Meta extends HashingProducerMeta> = {
  readonly [builtBranches]: {
    readonly entries: readonly (readonly [string, LooseBranch<never>])[];
    readonly meta?: Meta;
  };
};

/**
 * Accumulates branches for a heterogeneous computing cache, one `.when` per
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
export type HashingProducerBuilder<
  V extends AnyComputingVariants,
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
  ): HashingProducerBuilder<
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
  build(): HashingProducer<{
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
 * Starts a {@link HashingProducerBuilder} over a declared variant map. Curried
 * because the map cannot be inferred from anything, and TS has no partial
 * type-argument inference.
 *
 * ```ts
 * const producer = hashingProducerByInputType<{
 *   story: ComputingVariant<StoryInput, Story>;
 *   collection: ComputingVariant<CollInput, Story[]>;
 * }>()
 *   .when((i): i is StoryInput => i.kind === "story", {
 *     name: "story",
 *     hashInput: (input) => `extract:story:${input.id}`,
 *     produce: async (input) => ({ content: makeStory(input.id) }),
 *   })
 *   .build();
 *
 * const compute = wrapComputingProducer({ cache, hashingProducer: producer });
 * ```
 *
 * `Validators`/`Params` are declared here rather than taken from a cache
 * because a branch's result carries them (`validators`, `vary`), and there is
 * no cache to read them from; the wrapper requires the cache to agree. Likewise
 * `IdKeyedSpec`: pass a registry's `SpecOf` to return id-keyed supplementals
 * (see {@link BuiltBranchResult}).
 */
function makeBuilderChain(
  builderName: string,
  entries: readonly (readonly [string, LooseBranch<never>])[],
): unknown {
  return {
    when: (
      matchesInput: (input: never) => boolean,
      branch: { name: string; hashInput: unknown; produce: unknown },
    ) =>
      makeBuilderChain(builderName, [
        ...entries,
        [
          branch.name,
          { ...branch, matchesInput } as unknown as LooseBranch<never>,
        ],
      ]),
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

export function hashingProducerByInputType<
  V extends AnyComputingVariants,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  IdKeyedSpec extends CacheSpec = never,
>(): HashingProducerBuilder<
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
    "hashingProducerByInputType",
    [],
  ) as HashingProducerBuilder<
    V,
    Validators,
    Params,
    IdKeyedSpec,
    never,
    Record<string, never>
  >;
}

/**
 * The bulk analogue of {@link HashingProducerBuilder}: each branch's `produce`
 * computes a batch of that branch's missed inputs, returning a result (or an
 * `ErrorType`) per input, aligned by index.
 */
export type BulkHashingProducerBuilder<
  V extends AnyComputingVariants,
  Validators extends AnyValidators,
  Params extends AnyParams,
  IdKeyedSpec extends CacheSpec,
  ErrorType extends Error,
  Covered extends keyof V & string,
  MintedIds extends Record<string, string>,
> = {
  /** See {@link HashingProducerBuilder}'s `when`. */
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
  ): BulkHashingProducerBuilder<
    V,
    Validators,
    Params,
    IdKeyedSpec,
    ErrorType,
    Covered | Name,
    MintedIds & { readonly [K in Name]: Id }
  >;
  /** See {@link HashingProducerBuilder}'s `build`. */
  build(): HashingProducer<{
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
 * Starts a {@link BulkHashingProducerBuilder}. Same contract as
 * {@link hashingProducerByInputType}, for {@link wrapBulkComputingProducer}.
 */
export function bulkHashingProducerByInputType<
  V extends AnyComputingVariants,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  IdKeyedSpec extends CacheSpec = never,
  ErrorType extends Error = Error,
>(): BulkHashingProducerBuilder<
  V,
  Validators,
  Params,
  IdKeyedSpec,
  ErrorType,
  never,
  Record<string, never>
> {
  // SAFETY: as in hashingProducerByInputType.
  return makeBuilderChain(
    "bulkHashingProducerByInputType",
    [],
  ) as BulkHashingProducerBuilder<
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
 * accepted (or, single-coverage, any input — matching the declared `Input`),
 * and each minted id is classified against the branch's own resource type
 * before use.
 */
type LooseBranch<Input> = {
  matchesInput?: (input: unknown) => boolean;
  hashInput: (input: Input) => string | Promise<string>;
  produce: (
    input: ReadonlyDeep<Input>,
  ) => Promise<
    ComputingProducerResult<Input, CacheSpec, AnyValidators, AnyParams>
  >;
};

/**
 * Picks the branch for an input: with one covered type, that branch; with
 * several, the first (in record key order) whose `matchesInput` accepts the
 * input. Throws if no covered branch matches.
 */
function findBranch<B extends { matchesInput?: (input: unknown) => boolean }>(
  wrapperName: string,
  branchEntries: readonly (readonly [string | undefined, B])[],
  input: unknown,
): readonly [string | undefined, B] {
  if (branchEntries.length === 1) {
    // Non-null assertion is safe: length was just checked.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return branchEntries[0]!;
  }
  const entry = branchEntries.find(([, branch]) =>
    branch.matchesInput?.(input),
  );
  if (entry === undefined) {
    throw new Error(
      `${wrapperName}: no branch matched the input ${JSON.stringify(input)}`,
    );
  }
  return entry;
}

/**
 * Every way a built {@link HashingProducer} can fail to fit a cache's registry,
 * as a union of named problem objects. Surfaced through
 * {@link wrapComputingProducer}'s RETURN type rather than its parameter: a
 * conditional over a type parameter placed on the parameter is resolved before
 * that parameter is inferred, which reports every branch as broken. In the
 * return position everything is already inferred.
 */
type HashingProducerProblems<
  RT extends ResourceTypes,
  Meta extends HashingProducerMeta,
> =
  | ([Exclude<Meta["covered"], ResourceTypeName<RT>>] extends [never]
      ? never
      : {
          ERROR: "hashingProducer covers resource types that are not in this cache's registry";
          got: Exclude<Meta["covered"], ResourceTypeName<RT>>;
          expected: ResourceTypeName<RT>;
        })
  | ([Meta["idKeyedSpec"]] extends [SpecOf<RT>]
      ? never
      : {
          ERROR: "hashingProducer declares id-keyed supplementals outside this cache's registry";
          got: Meta["idKeyedSpec"];
          expected: SpecOf<RT>;
        })
  | {
      [K in Meta["covered"] & ResourceTypeName<RT>]: [
        Meta["mintedIds"][K],
      ] extends [IdOfResourceType<RT[K]>]
        ? [Meta["outputs"][K]] extends [ContentOfResourceType<RT[K]>]
          ? never
          : {
              ERROR: "a variant's declared output does not match its resource type's content";
              variant: K;
              expected: ContentOfResourceType<RT[K]>;
              got: Meta["outputs"][K];
            }
        : {
            ERROR: "a branch's hashInput mints ids outside its variant's resource type";
            variant: K;
            expected: IdOfResourceType<RT[K]>;
            got: Meta["mintedIds"][K];
          };
    }[Meta["covered"] & ResourceTypeName<RT>];

/**
 * The function a computing wrapper returns. `Extract` rather than `&` when
 * satisfying `SpecForId`'s id constraint: an intersection with a union does not
 * reduce, which silently widens the content back to the whole registry's union
 * on a partially-covering producer.
 */
type WrappedComputingProducer<
  RT extends ResourceTypes,
  Input,
  MintedId,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = (
  input: Input,
  options?: { directives?: ConsumerDirectives; signal?: AbortSignal },
) => Promise<
  Entry<
    SpecForId<SpecOf<RT>, Extract<MintedId, SpecOf<RT>["id"]>>,
    Validators,
    Params
  >
>;

/** The bulk analogue of {@link WrappedComputingProducer}. */
type WrappedBulkComputingProducer<
  RT extends ResourceTypes,
  Input,
  MintedId,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = (
  inputs: readonly Input[],
  options?: { directives?: ConsumerDirectives; signal?: AbortSignal },
) => Promise<
  (
    | Entry<
        SpecForId<SpecOf<RT>, Extract<MintedId, SpecOf<RT>["id"]>>,
        Validators,
        Params
      >
    | ErrorType
  )[]
>;

/**
 * Checks that a branch's `hashInput` minted an id that classifies to that
 * branch's own resource type, rethrowing the classification errors with the
 * offending branch named. Runs before the id is used for anything (in
 * particular, before any cache read). Vacuous for accept-everything
 * registries, whose guard accepts every id.
 *
 * `branchName` is absent for the single-producer form, which declares no
 * resource type to check against; there, classifying the id at all is the whole
 * check (an unclassifiable mint still fails loud, just without a name).
 */
function checkMintedId(
  cache: { readonly name: string; classify: (id: string) => string },
  branchName: string | undefined,
  id: string,
): void {
  let classified: string;
  try {
    classified = cache.classify(id);
  } catch (e) {
    // `cause` is carried through deliberately: `classify` puts a throwing
    // registry guard's own error there, and that parse failure is the only
    // debuggable account of WHY the mint didn't classify. Rebuilding the error
    // without it would strip it at exactly the boundary that names the branch.
    if (e instanceof UnclassifiableIdError) {
      throw new UnclassifiableIdError({
        cacheName: cache.name,
        id,
        message: `Cache "${cache.name}": \`hashInput\`${branchName === undefined ? "" : ` for branch "${branchName}"`} minted id ${JSON.stringify(id)}, which matches no resource type in the registry`,
        cause: e.cause,
      });
    }
    if (e instanceof AmbiguousResourceTypeError) {
      throw new AmbiguousResourceTypeError({
        cacheName: cache.name,
        id,
        matchedResourceTypes: e.matchedResourceTypes,
        message: `Cache "${cache.name}": \`hashInput\`${branchName === undefined ? "" : ` for branch "${branchName}"`} minted id ${JSON.stringify(id)}, which matches more than one resource type in the registry (${e.matchedResourceTypes.join(", ")})`,
      });
    }
    throw e;
  }

  if (branchName !== undefined && classified !== branchName) {
    throw new UnclassifiableIdError({
      cacheName: cache.name,
      id,
      message: `Cache "${cache.name}": \`hashInput\` for branch "${branchName}" minted id ${JSON.stringify(id)}, which classifies to resource type "${classified}" instead of "${branchName}"`,
    });
  }
}

/**
 * Resolves either call form to the branch table the plumbing dispatches over.
 * The single-producer form has no resource-type name to check mints against, so
 * its one entry is nameless (see {@link checkMintedId}).
 */
function branchEntriesFor(
  wrapperName: string,
  hashingProducer: HashingProducer<HashingProducerMeta> | undefined,
  hashInput: ((input: never) => string | Promise<string>) | undefined,
  produce: ((input: never) => Promise<unknown>) | undefined,
): readonly (readonly [string | undefined, LooseBranch<never>])[] {
  if (hashingProducer !== undefined) {
    if (hashInput !== undefined || produce !== undefined) {
      throw new Error(
        `${wrapperName}: pass EITHER \`hashingProducer\`, or \`hashInput\` and ` +
          "`produce`; passing both leaves it ambiguous which produces a value.",
      );
    }
    return hashingProducer[builtBranches].entries;
  }
  if (hashInput === undefined || produce === undefined) {
    throw new Error(
      `${wrapperName}: pass either \`hashingProducer\` (built by ` +
        "`hashingProducerByInputType`), or both `hashInput` and `produce`.",
    );
  }
  return [
    [undefined, { hashInput, produce } as unknown as LooseBranch<never>],
  ];
}

/**
 * Like {@link wrapProducer}, but for "computing producers" whose values are a
 * function of an `Input` rather than a lookup by id: `hashInput` derives the
 * cache id from an input, and `produce` receives the full input. The returned
 * function is called with the input directly.
 *
 * Two forms, one options bag:
 *
 * ```ts
 * // one resource type: no builder, no variant map, no type arguments
 * const compute = wrapComputingProducer({ cache, hashInput, produce });
 *
 * // several: a hashingProducer built (cache-free) by hashingProducerByInputType
 * const compute = wrapComputingProducer({ cache, hashingProducer });
 * ```
 *
 * See the module docs for when to use this vs. {@link wrapProducer}, and for the
 * branch/coverage/minted-id contracts. Any {@link WrapProducerOptions} field may
 * be set alongside.
 */
export function wrapComputingProducer<
  RT extends ResourceTypes,
  Meta extends HashingProducerMeta & { kind: "single" },
>(
  options: WrapProducerOptions & {
    cache: PublicInterface<Cache<RT, Meta["validators"], Meta["params"]>>;
    hashingProducer: HashingProducer<Meta>;
  },
): [HashingProducerProblems<RT, Meta>] extends [never]
  ? WrappedComputingProducer<
      RT,
      Meta["inputs"][Meta["covered"]],
      Meta["mintedIds"][Meta["covered"]],
      Meta["validators"],
      Meta["params"]
    >
  : HashingProducerProblems<RT, Meta>;
export function wrapComputingProducer<
  RT extends ResourceTypes,
  Input,
  MintedId extends SpecOf<RT>["id"],
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  options: WrapProducerOptions & {
    cache: PublicInterface<Cache<RT, Validators, Params>>;
    hashInput: (input: Input) => MintedId | Promise<MintedId>;
    produce: (
      input: ReadonlyDeep<Input>,
    ) => Promise<
      ComputingProducerResult<
        Input,
        SpecForId<SpecOf<RT>, MintedId>,
        Validators,
        Params,
        SpecForId<SpecOf<RT>, MintedId>,
        SpecOf<RT>
      >
    >;
  },
): WrappedComputingProducer<RT, Input, MintedId, Validators, Params>;
export function wrapComputingProducer(
  options: WrapProducerOptions & {
    cache: PublicInterface<Cache<ResourceTypes, AnyValidators, AnyParams>>;
    hashingProducer?: HashingProducer<HashingProducerMeta>;
    hashInput?: (input: never) => string | Promise<string>;
    produce?: (input: never) => Promise<unknown>;
  },
): unknown {
  const { cache, hashingProducer, hashInput, produce, ...producerOptions } =
    options;
  const branchEntries = branchEntriesFor(
    "wrapComputingProducer",
    hashingProducer,
    hashInput,
    produce,
  );
  const registry = new InputRegistry<never>();
  const hashSupplementals = makeSupplementalHasher<never>(
    "wrapComputingProducer",
    branchEntries,
    cache,
  );

  // The internal producer for a branch recovers that branch's input from the
  // registry and hands it to the branch's `produce`. `registry.get` runs
  // synchronously before `produce` is invoked, so the input is read while
  // still registered (see InputRegistry docs).
  const internalProducerFor =
    (branch: LooseBranch<never>) => async (req: { readonly id: string }) => {
      const input = registry.get(req.id);
      return hashSupplementals(await branch.produce(input as never));
    };

  // With named branches the per-type record goes through `producerByIdType`,
  // which turns it into the single producer function `wrapProducer` takes and
  // which carries this wrapper's coverage, so the branch keys still bound the
  // delegated requests. The single-producer form needs none of that: there is
  // one producer for every id it mints.
  //
  // SAFETY: the casts bridge the erased internal producers to the helper's
  // per-type record type (and to `wrapProducer`'s producer type), which are
  // opaque while `RT` is an unresolved generic. Runtime dispatch upholds the
  // contract: each producer only ever receives ids its own branch's `hashInput`
  // minted, checked below to classify to that branch's type before any request.
  const wrapped =
    hashingProducer === undefined
      ? wrapProducer(
          cache,
          producerOptions,
          // Non-null: branchEntriesFor guarantees exactly one entry here.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          internalProducerFor(branchEntries[0]![1]) as unknown as Parameters<
            typeof wrapProducer
          >[2],
        )
      : wrapProducer(
          cache,
          producerOptions,
          producerByIdType(
            cache.resourceTypes,
            Object.fromEntries(
              branchEntries.map(([name, branch]) => [
                name,
                internalProducerFor(branch),
              ]),
            ) as unknown as ProducersFor<
              ResourceTypes,
              string,
              AnyValidators,
              AnyParams
            >,
          ),
        );

  return async (
    input: never,
    callOptions?: { directives?: ConsumerDirectives; signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    const [branchName, branch] = findBranch(
      "wrapComputingProducer",
      branchEntries,
      input,
    );
    const id = await branch.hashInput(input);
    signal?.throwIfAborted();

    checkMintedId(cache, branchName, id);

    registry.acquire(id, input);
    try {
      return await wrapped(
        // SAFETY: bridges to `PartialConsumerRequest`, whose id/directives
        // are `ReadonlyDeep`-wrapped and so opaque against the plain types
        // here while `RT` is generic; the id was just checked to classify to
        // this branch's covered type. The conditional spread avoids
        // `directives: undefined` (rejected under
        // `exactOptionalPropertyTypes`).
        {
          id,
          ...(callOptions?.directives === undefined
            ? {}
            : { directives: callOptions.directives }),
        } as unknown as Parameters<typeof wrapped>[0],
        signal ? { signal } : undefined,
      );
    } finally {
      registry.release(id);
    }
  };
}

/**
 * The bulk analogue of {@link wrapComputingProducer}, layered over
 * {@link wrapBulkProducer}: looks each input's derived id up in the cache and
 * computes only the inputs that missed, as a single batch per branch. Results
 * are returned per input, aligned by index.
 *
 * Same two forms as {@link wrapComputingProducer}, with `hashingProducer` built
 * by {@link bulkHashingProducerByInputType}.
 */
export function wrapBulkComputingProducer<
  RT extends ResourceTypes,
  Meta extends HashingProducerMeta & { kind: "bulk" },
>(
  options: WrapProducerOptions & {
    cache: PublicInterface<Cache<RT, Meta["validators"], Meta["params"]>>;
    hashingProducer: HashingProducer<Meta>;
  },
): [HashingProducerProblems<RT, Meta>] extends [never]
  ? WrappedBulkComputingProducer<
      RT,
      Meta["inputs"][Meta["covered"]],
      Meta["mintedIds"][Meta["covered"]],
      Meta["validators"],
      Meta["params"],
      Meta["errorType"]
    >
  : HashingProducerProblems<RT, Meta>;
export function wrapBulkComputingProducer<
  RT extends ResourceTypes,
  Input,
  MintedId extends SpecOf<RT>["id"],
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  options: WrapProducerOptions & {
    cache: PublicInterface<Cache<RT, Validators, Params>>;
    hashInput: (input: Input) => MintedId | Promise<MintedId>;
    produce: (
      inputs: readonly ReadonlyDeep<Input>[],
    ) => Promise<
      readonly (
        | ComputingProducerResult<
            Input,
            SpecForId<SpecOf<RT>, MintedId>,
            Validators,
            Params,
            SpecForId<SpecOf<RT>, MintedId>,
            SpecOf<RT>
          >
        | ErrorType
      )[]
    >;
  },
): WrappedBulkComputingProducer<
  RT,
  Input,
  MintedId,
  Validators,
  Params,
  ErrorType
>;
export function wrapBulkComputingProducer(
  options: WrapProducerOptions & {
    cache: PublicInterface<Cache<ResourceTypes, AnyValidators, AnyParams>>;
    hashingProducer?: HashingProducer<HashingProducerMeta>;
    hashInput?: (input: never) => string | Promise<string>;
    produce?: (inputs: readonly never[]) => Promise<unknown>;
  },
): unknown {
  const { cache, hashingProducer, hashInput, produce, ...producerOptions } =
    options;
  type LooseBulkBranch = Omit<LooseBranch<never>, "produce"> & {
    produce: (
      inputs: readonly ReadonlyDeep<never>[],
    ) => Promise<
      (
        | ComputingProducerResult<never, CacheSpec, AnyValidators, AnyParams>
        | Error
      )[]
    >;
  };

  const branchEntries = branchEntriesFor(
    "wrapBulkComputingProducer",
    hashingProducer,
    hashInput,
    produce as ((input: never) => Promise<unknown>) | undefined,
  ) as unknown as readonly (readonly [string | undefined, LooseBulkBranch])[];
  const registry = new InputRegistry<never>();
  const hashSupplementals = makeSupplementalHasher<never>(
    "wrapBulkComputingProducer",
    branchEntries,
    cache,
  );
  // Bound concurrent input hashing (see HASH_CONCURRENCY); shared across calls.
  const hashLimit = pLimit(HASH_CONCURRENCY);

  // Each branch's internal bulk producer recovers its inputs from the registry
  // (synchronously, while still registered) and hands the batch to `produce`.
  const internalProducerFor =
    (branch: LooseBulkBranch) =>
    (reqs: readonly { readonly id: string }[]) => {
      const inputs = reqs.map((req) =>
        registry.get(req.id),
      ) as readonly ReadonlyDeep<never>[];
      return branch
        .produce(inputs)
        .then(async (results) =>
          Promise.all(
            results.map(async (result) =>
              result instanceof Error ? result : hashSupplementals(result),
            ),
          ),
        );
    };

  // Same routing choice and bridging casts as wrapComputingProducer's; see there.
  const wrapped =
    hashingProducer === undefined
      ? wrapBulkProducer(
          cache,
          producerOptions,
          // Non-null: branchEntriesFor guarantees exactly one entry here.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          internalProducerFor(branchEntries[0]![1]) as unknown as Parameters<
            typeof wrapBulkProducer
          >[2],
        )
      : wrapBulkProducer(
          cache,
          producerOptions,
          bulkProducerByIdType(
            cache.resourceTypes,
            Object.fromEntries(
              branchEntries.map(([name, branch]) => [
                name,
                internalProducerFor(branch),
              ]),
            ) as unknown as BulkProducersFor<
              ResourceTypes,
              string,
              AnyValidators,
              AnyParams,
              Error
            >,
          ),
        );

  return async (
    inputs: readonly never[],
    callOptions?: { directives?: ConsumerDirectives; signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // Route each input to its branch, keeping the branch itself (not just its
    // name) so hashing doesn't have to look it up again, then hash with that
    // branch's `hashInput` (bounded by `hashLimit`; `hashInput` may be sync --
    // p-limit handles that).
    const routed = zip2(
      inputs,
      inputs.map((input) =>
        findBranch("wrapBulkComputingProducer", branchEntries, input),
      ),
    );
    const ids = await Promise.all(
      routed.map(async ([input, [, branch]]) =>
        hashLimit(async () => branch.hashInput(input)),
      ),
    );
    signal?.throwIfAborted();

    const mintedIds = zip2(ids, routed);

    mintedIds.forEach(([id, [, [branchName]]]) => {
      checkMintedId(cache, branchName, id);
    });

    // A separate pass from the mint check, deliberately: `acquire` is only
    // balanced by the `finally` below, so a `checkMintedId` throw partway
    // through a combined loop would leave earlier ids acquired and never
    // released -- retaining their (potentially large) inputs for the process
    // lifetime.
    mintedIds.forEach(([id, [input]]) => {
      registry.acquire(id, input);
    });
    try {
      return await wrapped(
        // SAFETY: same bridge as wrapComputingProducer's (see there). The
        // call-level directives apply to every element (conditional spread
        // for `exactOptionalPropertyTypes`, as in the single variant).
        ids.map((id) => ({
          id,
          ...(callOptions?.directives === undefined
            ? {}
            : { directives: callOptions.directives }),
        })) as unknown as Parameters<typeof wrapped>[0],
        signal ? { signal } : undefined,
      );
    } finally {
      ids.forEach((id) => registry.release(id));
    }
  };
}

/**
 * Builds the function that turns a {@link ComputingProducerResult} into the
 * plain {@link RequestPairedProducerResult} the underlying producer machinery
 * expects, by hashing each supplemental resource's `input` -- with the
 * producing branch's own `hashInput` -- into its storage id.
 *
 * The casts reconstruct the canonical result shape from the computing result
 * (which differs only by how supplementals are keyed); TS can't track the
 * distributive transform across the `Omit`/re-add.
 */
function makeSupplementalHasher<Input>(
  wrapperName: string,
  branchEntries: readonly (readonly [
    string | undefined,
    Pick<LooseBranch<Input>, "matchesInput" | "hashInput">,
  ])[],
  cache: { readonly name: string; classify: (id: string) => string },
) {
  // One limiter shared across every call of the returned resolver.
  const limit = pLimit(HASH_CONCURRENCY);
  return async (
    result: ComputingProducerResult<Input, CacheSpec, AnyValidators, AnyParams>,
  ): Promise<
    RequestPairedProducerResult<CacheSpec, AnyValidators, AnyParams>
  > => {
    const { supplementalResources, ...primary } = result;
    if (!supplementalResources || supplementalResources.length === 0) {
      return primary as unknown as RequestPairedProducerResult<
        CacheSpec,
        AnyValidators,
        AnyParams
      >;
    }

    return {
      ...primary,
      supplementalResources: await Promise.all(
        supplementalResources.map((resource) => {
          if (!("input" in resource)) {
            // Id-keyed: a plain ProducerResultResource for any registry type,
            // stored as-is (classified by its own id at store time, exactly
            // like plain producers' supplementals). Resolved OUTSIDE the
            // limiter -- there is nothing to hash, so queueing it would buy a
            // p-limit job and a tick to hand back the same object, and would
            // make id-keyed entries wait behind hashing ones.
            return Promise.resolve(resource);
          }
          // Input-keyed: route to a covered branch with the same
          // `matchesInput` selection applied to call-time inputs, hash
          // with THAT branch's `hashInput`, and mint-check eagerly -- so
          // a producer minting a bad supplemental id fails the invocation
          // loudly (named branch) instead of a silent store-time
          // rejection behind the wrappers' fire-and-forget store.
          const { input, ...rest } = resource;
          return limit(async () => {
            const [branchName, branch] = findBranch(
              wrapperName,
              branchEntries,
              input,
            );
            const id = await branch.hashInput(input as Input);
            checkMintedId(cache, branchName, id);
            return { ...rest, id };
          });
        }),
      ),
    } as unknown as RequestPairedProducerResult<
      CacheSpec,
      AnyValidators,
      AnyParams
    >;
  };
}

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
