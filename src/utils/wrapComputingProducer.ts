import pLimit from "p-limit";
import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import {
  AmbiguousResourceTypeError,
  UnclassifiableIdError,
} from "../Cache.js";
import type { CacheSpec, SpecForId } from "../types/00_CacheSpec.js";
import type {
  IdOfResourceType,
  ResourceTypeName,
  ResourceTypes,
  SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  Entry,
  ProducerResultResource,
  RequestPairedProducerResult,
} from "../types/index.js";
import wrapProducer, { type WrapProducerOptions } from "./wrapProducer.js";
import { wrapBulkProducer } from "./wrapBulkProducer.js";

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
 * computation. These wrappers encapsulate exactly that: each covered branch
 * provides a `hashInput` function and a `produce` that takes the full `Input`,
 * and the wrapper derives the cache id, keeps the input around just long
 * enough to hand it to the producer on a miss, and otherwise behaves like
 * `wrapProducer` / `wrapBulkProducer` (same caching, request-collapsing,
 * stale-while-revalidate, abort, and diagnostics behavior; see
 * {@link WrapProducerOptions}).
 *
 * ## Branches, coverage, and minted ids
 *
 * Like the plain wrappers, coverage — any non-empty subset of the cache's
 * registry — is inferred from the `branches` record's keys. Because computing
 * ids are hashes, the registry's in-band-discriminator requirement falls on
 * `hashInput`: each branch's `hashInput` must mint ids that its resource
 * type's `matches` guard accepts. This is checked at runtime: the wrapper
 * classifies each hashed id and throws
 * `UnclassifiableIdError`/`AmbiguousResourceTypeError` on mismatch, naming
 * the branch. For `soleResourceType` registries that runtime check is vacuous
 * (the guard accepts everything); there, `hashInput`'s compile-checked return
 * type — `IdOfResourceType`, i.e. the narrowed `Id` when the sole type
 * declares one — is the line of defense.
 *
 * When a wrapper covers more than one type, each branch must also provide
 * `matchesInput`, the input-side classifier used to pick the branch for an
 * incoming input (tried in the record's key order; an input no covered
 * branch accepts throws). With exactly one covered type, `matchesInput` is
 * unnecessary and ignored.
 *
 * ## Supplemental resources are keyed by input, not id
 *
 * Like plain producers, a computing producer can return `supplementalResources`
 * — values it produced as a byproduct that are worth caching. The twist that
 * follows from keys being input-hashes: a supplemental is identified by the
 * **input** it would be computed from, not a bare id. The wrapper hashes each
 * supplemental's input with the producing branch's own `hashInput`, so a
 * later `compute(thatInput)` finds it as a cache hit. (A bare id would be
 * unreachable, since computing lookups only ever go through `hashInput`.)
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
 * stamped on from the derived hash), and each `supplementalResources` entry is
 * identified by the **input** it would be computed from rather than a bare `id`
 * (otherwise it's a plain {@link ProducerResultResource}). The wrapper hashes
 * each supplemental's input to derive its storage id, so a supplemental is
 * reachable by a later `compute(input)`.
 */
export type ComputingProducerResult<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Omit<
  RequestPairedProducerResult<Spec, Validators, Params>,
  "id" | "supplementalResources"
> & {
  supplementalResources?: (Spec extends unknown
    ? Omit<ProducerResultResource<Spec, Validators, Params>, "id"> & {
        input: Input;
      }
    : never)[];
};

/**
 * One covered resource type's slice of a computing wrapper: how to recognize
 * its inputs, how to mint its cache ids, and how to compute its values.
 */
export type ComputingBranch<
  Input,
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  /**
   * Input classifier for this branch. Required when the wrapper covers more
   * than one type; forbidden (and ignored) when it covers exactly one.
   */
  matchesInput?: (input: unknown) => input is Input;
  /** Must mint ids that this branch's `matches` guard accepts. */
  hashInput: (
    input: Input,
  ) => IdOfResourceType<RT[K]> | Promise<IdOfResourceType<RT[K]>>;
  produce: (
    // `input` is `ReadonlyDeep` because the same input object can be handed to
    // more than one producer call (concurrent callers share it via the
    // registry), so a producer must not mutate what another might be reading.
    input: ReadonlyDeep<Input>,
    options?: { signal?: AbortSignal },
  ) => Promise<
    ComputingProducerResult<
      Input,
      SpecForId<SpecOf<RT>, IdOfResourceType<RT[K]>>,
      Validators,
      Params
    >
  >;
};

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
    options?: { signal?: AbortSignal },
  ) => Promise<ComputingProducerResult<Input, CacheSpec, AnyValidators, AnyParams>>;
};

/**
 * Validates a computing wrapper's `branches` record at construction time and
 * returns its (erased) entries. Throws on a keyless record (same as the plain
 * wrappers) and, for multi-type coverage, on any branch missing its
 * `matchesInput` input classifier.
 */
function checkedBranchEntries<Input>(
  wrapperName: string,
  branches: object,
): [string, LooseBranch<Input>][] {
  const entries = Object.entries(branches) as [string, LooseBranch<Input>][];

  if (entries.length === 0) {
    throw new Error(
      `${wrapperName}: \`branches\` must be a record with one entry per ` +
        "covered resource type and cannot be empty.",
    );
  }

  if (entries.length > 1) {
    const missing = entries
      .filter(([, branch]) => typeof branch.matchesInput !== "function")
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `${wrapperName}: this wrapper covers more than one resource type, so ` +
          `every branch needs a \`matchesInput\` input classifier; missing ` +
          `on: ${missing.join(", ")}`,
      );
    }
  }

  return entries;
}

/**
 * Picks the branch for an input: with one covered type, that branch; with
 * several, the first (in record key order) whose `matchesInput` accepts the
 * input. Throws if no covered branch matches.
 */
function findBranch<B extends { matchesInput?: (input: unknown) => boolean }>(
  wrapperName: string,
  branchEntries: readonly [string, B][],
  input: unknown,
): [string, B] {
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
 * Checks that a branch's `hashInput` minted an id that classifies to that
 * branch's own resource type, rethrowing the classification errors with the
 * offending branch named. Runs before the id is used for anything (in
 * particular, before any cache read). Vacuous for `soleResourceType`
 * registries, whose guard accepts every id.
 */
function checkMintedId(
  cache: { readonly name: string; classify: (id: string) => string },
  branchName: string,
  id: string,
): void {
  let classified: string;
  try {
    classified = cache.classify(id);
  } catch (e) {
    if (e instanceof UnclassifiableIdError) {
      throw new UnclassifiableIdError({
        cacheName: cache.name,
        id,
        message: `Cache "${cache.name}": \`hashInput\` for branch "${branchName}" minted id ${JSON.stringify(id)}, which matches no resource type in the registry`,
      });
    }
    if (e instanceof AmbiguousResourceTypeError) {
      throw new AmbiguousResourceTypeError({
        cacheName: cache.name,
        id,
        matchedResourceTypes: e.matchedResourceTypes,
        message: `Cache "${cache.name}": \`hashInput\` for branch "${branchName}" minted id ${JSON.stringify(id)}, which matches more than one resource type in the registry (${e.matchedResourceTypes.join(", ")})`,
      });
    }
    throw e;
  }

  if (classified !== branchName) {
    throw new UnclassifiableIdError({
      cacheName: cache.name,
      id,
      message: `Cache "${cache.name}": \`hashInput\` for branch "${branchName}" minted id ${JSON.stringify(id)}, which classifies to resource type "${classified}" instead of "${branchName}"`,
    });
  }
}

/**
 * Like {@link wrapProducer}, but for "computing producers" whose values are a
 * function of an `Input` rather than a lookup by id. Each covered branch
 * provides `hashInput` (to derive the branch's cache ids from its inputs) and
 * a `produce` that receives the full input; the returned function is called
 * with the input directly.
 *
 * See the module docs for when to use this vs. {@link wrapProducer}, and for
 * the branch/coverage/minted-id contracts.
 *
 * @param cache - The {@link Cache} to use.
 * @param options - The same options as {@link wrapProducer}.
 * @param branches - One {@link ComputingBranch} per covered resource type
 *   (any non-empty subset of the registry; coverage is inferred from the
 *   record's keys).
 */
export function wrapComputingProducer<
  Input,
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  branches: {
    readonly [K in Covered]: ComputingBranch<Input, RT, K, Validators, Params>;
  },
): (
  input: Input,
  options?: { signal?: AbortSignal },
) => Promise<
  Entry<
    SpecForId<SpecOf<RT>, IdOfResourceType<RT[Covered]>>,
    Validators,
    Params
  >
> {
  const branchEntries = checkedBranchEntries<Input>(
    "wrapComputingProducer",
    branches,
  );
  const registry = new InputRegistry<Input>();
  const hashSupplementals = makeSupplementalHasher<Input>();

  // The internal producer for each branch recovers the branch's input from
  // the registry and hands it to the branch's `produce`. `registry.get` runs
  // synchronously before `produce` is invoked, so the input is read while
  // still registered (see InputRegistry docs).
  const producers = Object.fromEntries(
    branchEntries.map(([name, branch]) => [
      name,
      async (
        req: { readonly id: string },
        producerOptions?: { signal?: AbortSignal },
      ) => {
        const input = registry.get(req.id) as ReadonlyDeep<Input>;
        const result = producerOptions
          ? await branch.produce(input, producerOptions)
          : await branch.produce(input);
        return hashSupplementals(branch.hashInput, result);
      },
    ]),
  );

  // SAFETY: the cast bridges the erased internal producers record to
  // `wrapProducer`'s per-type record type, which is opaque while `RT` is an
  // unresolved generic. Runtime dispatch upholds the contract: each producer
  // only ever receives ids its branch's `hashInput` minted (checked, below,
  // to classify to that branch's type before any request is made).
  const wrapped = wrapProducer<RT, Covered, Validators, Params>(
    cache,
    options,
    producers as unknown as Parameters<
      typeof wrapProducer<RT, Covered, Validators, Params>
    >[2],
  );

  const wrappedComputingProducer = async (
    input: Input,
    callOptions?: { signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    const [branchName, branch] = findBranch("wrapComputingProducer", branchEntries, input);
    const id = await branch.hashInput(input);
    signal?.throwIfAborted();

    checkMintedId(cache, branchName, id);

    registry.acquire(id, input);
    try {
      return await wrapped(
        // SAFETY: bridges to `PartialConsumerRequest`, whose id is opaque
        // against the plain `string` here while `RT` is generic; the id was
        // just checked to classify to this branch's covered type.
        { id } as unknown as Parameters<typeof wrapped>[0],
        signal ? { signal } : undefined,
      );
    } finally {
      registry.release(id);
    }
  };

  return wrappedComputingProducer;
}

/**
 * The bulk analogue of {@link wrapComputingProducer}, layered over
 * {@link wrapBulkProducer}: looks each input's derived id up in the cache and
 * calls each covered branch's `produce` only for the inputs that missed,
 * computing them as a single batch per branch. Results are returned per
 * input, aligned by index.
 *
 * See the module docs for when to use this vs. {@link wrapBulkProducer}.
 *
 * @param cache - The {@link Cache} to use.
 * @param options - Same as {@link wrapComputingProducer}'s options.
 * @param branches - Same as {@link wrapComputingProducer}'s branches, except
 *   each branch's `produce` computes the values for a batch of missed inputs,
 *   returning a result (or `ErrorType`) per input, aligned by index.
 */
export function wrapBulkComputingProducer<
  Input,
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  branches: {
    readonly [K in Covered]: Omit<
      ComputingBranch<Input, RT, K, Validators, Params>,
      "produce"
    > & {
      produce: (
        // `input`s are `ReadonlyDeep` for the same reason as the single
        // variant: they can be shared with other producer calls via the
        // registry, so a producer must not mutate them.
        inputs: readonly ReadonlyDeep<Input>[],
        options?: { signal?: AbortSignal },
      ) => Promise<
        (
          | ComputingProducerResult<
              Input,
              SpecForId<SpecOf<RT>, IdOfResourceType<RT[K]>>,
              Validators,
              Params
            >
          | ErrorType
        )[]
      >;
    };
  },
): (
  inputs: readonly Input[],
  options?: { signal?: AbortSignal },
) => Promise<
  (
    | Entry<
        SpecForId<SpecOf<RT>, IdOfResourceType<RT[Covered]>>,
        Validators,
        Params
      >
    | ErrorType
  )[]
> {
  type LooseBulkBranch = Omit<LooseBranch<Input>, "produce"> & {
    produce: (
      inputs: readonly ReadonlyDeep<Input>[],
      options?: { signal?: AbortSignal },
    ) => Promise<
      (
        | ComputingProducerResult<Input, CacheSpec, AnyValidators, AnyParams>
        | ErrorType
      )[]
    >;
  };

  const branchEntries = checkedBranchEntries<Input>(
    "wrapBulkComputingProducer",
    branches,
  ) as unknown as [string, LooseBulkBranch][];
  const branchesByName = new Map(branchEntries);
  const registry = new InputRegistry<Input>();
  const hashSupplementals = makeSupplementalHasher<Input>();
  // Bound concurrent input hashing (see HASH_CONCURRENCY); shared across calls.
  const hashLimit = pLimit(HASH_CONCURRENCY);

  // Each branch's internal bulk producer recovers the inputs from the
  // registry (synchronously, while still registered) and hands the batch to
  // the branch's `produce`.
  const producers = Object.fromEntries(
    branchEntries.map(([name, branch]) => [
      name,
      (
        reqs: readonly { readonly id: string }[],
        producerOptions?: { signal?: AbortSignal },
      ) => {
        const inputs = reqs.map((req) =>
          registry.get(req.id),
        ) as readonly ReadonlyDeep<Input>[];
        const producerPromise = producerOptions
          ? branch.produce(inputs, producerOptions)
          : branch.produce(inputs);
        return producerPromise.then(async (results) =>
          Promise.all(
            results.map(async (result) =>
              result instanceof Error
                ? result
                : hashSupplementals(branch.hashInput, result),
            ),
          ),
        );
      },
    ]),
  );

  // SAFETY: same bridge as wrapComputingProducer's (see there).
  const wrapped = wrapBulkProducer<RT, Covered, Validators, Params, ErrorType>(
    cache,
    options,
    producers as unknown as Parameters<
      typeof wrapBulkProducer<RT, Covered, Validators, Params, ErrorType>
    >[2],
  );

  const wrappedBulkComputingProducer = async (
    inputs: readonly Input[],
    callOptions?: { signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // Route each input to its branch, then hash it with that branch's
    // `hashInput` (bounded by `hashLimit`; `hashInput` may be sync — p-limit
    // handles that).
    const branchNames = inputs.map(
      (input) => findBranch("wrapBulkComputingProducer", branchEntries, input)[0],
    );
    const ids = await Promise.all(
      inputs.map(async (input, index) =>
        hashLimit(async () => {
          // Non-null assertion is safe: index-aligned with `inputs`, and every
          // branch name came from `branchEntries`.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const branch = branchesByName.get(branchNames[index]!)!;
          return branch.hashInput(input);
        }),
      ),
    );
    signal?.throwIfAborted();

    ids.forEach((id, index) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index-aligned with `ids`
      checkMintedId(cache, branchNames[index]!, id);
    });

    ids.forEach((id, index) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index-aligned with `ids`
      registry.acquire(id, inputs[index]!);
    });
    try {
      return await wrapped(
        // SAFETY: same bridge as wrapComputingProducer's (see there).
        ids.map((id) => ({ id })) as unknown as Parameters<typeof wrapped>[0],
        signal ? { signal } : undefined,
      );
    } finally {
      ids.forEach((id) => registry.release(id));
    }
  };

  return wrappedBulkComputingProducer;
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
function makeSupplementalHasher<Input>() {
  // One limiter shared across every call of the returned hasher.
  const limit = pLimit(HASH_CONCURRENCY);
  return async (
    hashInput: (input: Input) => string | Promise<string>,
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
        supplementalResources.map(async (resource) =>
          limit(async () => {
            const { input, ...rest } = resource;
            return { ...rest, id: await Promise.resolve(hashInput(input)) };
          }),
        ),
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
