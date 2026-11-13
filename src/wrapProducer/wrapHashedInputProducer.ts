import {
  wrappedReadStartedAt,
  type WrappedReadOptions,
} from "./wrapProducer.js";
import pLimit from "p-limit";
import type { ReadonlyDeep } from "type-fest";

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
  RequestPairedProducerResult,
} from "../types/index.js";
import {
  builtBranches,
  type HashedInputProducer,
  type HashedInputProducerMeta,
  type HashedInputProducerResult,
  type LooseBranch,
} from "../producer-builders/hashedInputProducerByInputType.js";
import {
  bulkProducerByIdType,
  type BulkProducersFor,
} from "../producer-builders/bulkProducerByIdType.js";
import {
  producerByIdType,
  type ProducersFor,
} from "../producer-builders/producerByIdType.js";
import { PendingPromisesTracker } from "../scheduling/pendingPromisesTracker.js";
import { asError, CacheContractError } from "../utils/utils.js";
import wrapProducer, { type WrapProducerOptions } from "./wrapProducer.js";

/**
 * ## Hashed-input producers vs. (plain) producers
 *
 * `wrapProducer` models a cache as a **lookup of a mutable
 * entity by its id**: the caller already has the id, and the cached value is a
 * function of that id and time (e.g. "the current `User` for `user:123`"). The
 * id is the natural cache key, so the producer receives it directly.
 *
 * `wrapHashedInputProducer` models the other common
 * case: the cached value is an **expensive-to-compute function of some input**,
 * reused whenever the same input recurs (e.g. an LLM extraction over a chunk of
 * text, a rendered template, a compiled artifact). Here the *input* is the
 * identity of the work, so a hash of the input is the natural cache key — but
 * the producer wants the original, un-hashed input to actually do the
 * computation. These wrappers encapsulate exactly that: a `hashInput` derives
 * the cache id from an input and a `produce` takes the full input, and the
 * wrapper keeps the input around just long enough to hand it over on a miss,
 * otherwise behaving like `wrapProducer` (same caching,
 * request-collapsing, fire-and-forget store with in-flight writes counting as
 * hits, stale-while-revalidate, abort, and diagnostics behavior; see
 * {@link WrapProducerOptions} and `wrapProducer`'s docs).
 *
 * ## One resource type, or several
 *
 * A cache with one resource type needs nothing but the two functions:
 *
 * ```ts
 * const compute = wrapHashedInputProducer({ cache, hashInput, produce });
 * ```
 *
 * For several, {@link hashedInputProducerByInputType} builds a *hashed-input producer* —
 * one `.when` per covered resource type, dispatching on the input — and the
 * wrapper takes that instead:
 *
 * ```ts
 * const compute = wrapHashedInputProducer({ cache, produce: hashedInputProducer });
 * ```
 *
 * A hashed-input producer is built with **no cache**: it is a value in its own right,
 * constructible (and reusable) before any cache exists, and checked against a
 * cache's registry only where the two are wired together. Coverage is whatever
 * the chain added — any non-empty subset of the registry.
 *
 * ## Minted ids
 *
 * Because hashed-input ids are hashes, the registry's in-band-discriminator
 * requirement falls on `hashInput`: a branch's `hashInput` must mint ids that
 * its resource type's `matches` guard accepts. That is checked twice. At compile
 * time, wiring a hashed-input producer to a cache compares each branch's minted-id
 * type against its variant's `IdOfResourceType`. At runtime, each hashed id is
 * classified before it is used for anything — the backstop for a mint that
 * reached the wrapper through a cast or an untyped boundary. Each way that can
 * fail gets its own error, all naming the branch: the mint matched no resource
 * type (`UnclassifiableIdError`), or several (`AmbiguousResourceTypeError`), or
 * exactly one that isn't the branch's own
 * ({@link MintedIdResourceTypeMismatchError} — a *successful* classification
 * with the wrong answer, so it indicts the branch's `hashInput` rather than the
 * registry's guards, and carries both the expected and the actual type as
 * fields). For accept-everything registries the runtime check is vacuous (the
 * guard accepts every id), and the compile-time one carries the weight.
 *
 * The single-producer form declares no resource type, so there is no name to
 * check a mint against; classifying the id at all is the whole runtime check
 * there, and the mismatch case is unreachable.
 *
 * ## Supplemental resources: input-keyed or id-keyed
 *
 * Like plain producers, a hashed-input producer can return `supplementalResources`
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
 *   as a cache hit. In a hashed-input producer these are correlated per variant:
 *   the `input` and `content` must come from the SAME variant, so "computing a
 *   collection also caches its stories" is checked rather than merely allowed.
 * - **Id-keyed** (`{ id, content, … }`, a plain `ProducerResultResource`):
 *   for ANY registry type, covered or not — exactly what plain producers'
 *   supplementals are. Classified by their own id at store time. This is what
 *   makes these wrappers full peers of `wrapProducer` when the hash exists for
 *   **key privacy** rather than for expensive computation: derive the primary
 *   key by hashing, and still supplementally store other resources under their
 *   natural ids. Typing these needs the registry's id space, which
 *   the single-producer form has; a (cache-free) hashed-input producer must be
 *   declared with the registry's `SpecOf` to return them — see
 *   {@link hashedInputProducerByInputType}.
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
 * Picks the branch for an input: the first (in `.when` order) whose
 * `matchesInput` accepts it. Throws if none does.
 *
 * A branch with NO guard matches unconditionally, which is exactly -- and only
 * -- the single-producer form's one nameless entry (see
 * {@link branchEntriesFor}; every `.when` branch has a guard). Selecting on the
 * guard's ABSENCE rather than on `branchEntries.length === 1` is load-bearing:
 * a hashed-input producer built from a single `.when` is also one entry, and its
 * guard must still be consulted, or an input that guard rejects would be
 * produced and stored anyway under that branch's minted id.
 *
 * A guard that THROWS counts as a non-match, exactly as a registry guard does
 * in {@link Cache.classify}: guards routinely reject foreign inputs by failing
 * to read them (a property access on the wrong shape, a parse that throws), so
 * one branch's failure to recognize an input must not stop a later branch from
 * claiming it. When nothing matches, the guard error(s) surface as the routing
 * error's `cause` rather than leaking with no wrapper/input attribution. Unlike
 * `classify` this stays first-match-wins -- `.when` order is the documented
 * tie-break, since two variants may accept the same input type -- so guards
 * after the match are never evaluated and cannot contribute an error.
 */
function findBranch<B extends { matchesInput?: (input: unknown) => boolean }>(
  wrapperName: string,
  branchEntries: readonly (readonly [string | undefined, B])[],
  input: unknown,
): readonly [string | undefined, B] {
  // Allocates nothing unless a guard actually throws (as in `classify`).
  let guardErrors: unknown[] | undefined;

  const entry = branchEntries.find(([, branch]) => {
    if (branch.matchesInput === undefined) {
      return true;
    }
    try {
      return branch.matchesInput(input);
    } catch (error) {
      (guardErrors ??= []).push(error);
      return false;
    }
  });

  if (entry === undefined) {
    throw new CacheContractError(
      `${wrapperName}: no branch matched the input ${JSON.stringify(input)}`,
      guardErrors === undefined
        ? undefined
        : {
            cause:
              guardErrors.length === 1
                ? guardErrors[0]
                : new AggregateError(
                    guardErrors,
                    "one or more branch guards threw while routing an input",
                  ),
          },
    );
  }
  return entry;
}

/**
 * Every way a built {@link HashedInputProducer} can fail to fit a cache's registry,
 * as a union of named problem objects. Surfaced through
 * {@link wrapHashedInputProducer}'s RETURN type rather than its parameter: a
 * conditional over a type parameter placed on the parameter is resolved before
 * that parameter is inferred, which reports every branch as broken. In the
 * return position everything is already inferred.
 */
type HashedInputProducerProblems<
  RT extends ResourceTypes,
  Meta extends HashedInputProducerMeta,
> =
  | ([Exclude<Meta["covered"], ResourceTypeName<RT>>] extends [never]
      ? never
      : {
          ERROR: "hashedInputProducer covers resource types that are not in this cache's registry";
          got: Exclude<Meta["covered"], ResourceTypeName<RT>>;
          expected: ResourceTypeName<RT>;
        })
  | ([Meta["idKeyedSpec"]] extends [SpecOf<RT>]
      ? never
      : {
          ERROR: "hashedInputProducer declares id-keyed supplementals outside this cache's registry";
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

type HashedReadOptions = WrappedReadOptions & {
  directives?: ConsumerDirectives;
};

/**
 * The object a hashed-input wrapper returns. `Extract` rather than `&` when
 * satisfying `SpecForId`'s id constraint: an intersection with a union does not
 * reduce, which silently widens the content back to the whole registry's union
 * on a partially-covering producer.
 */
type WrappedHashedInputProducer<
  RT extends ResourceTypes,
  Input,
  MintedId,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  get: (
    input: Input,
    options?: HashedReadOptions,
  ) => Promise<
    Entry<
      SpecForId<SpecOf<RT>, Extract<MintedId, SpecOf<RT>["id"]>>,
      Validators,
      Params
    >
  >;
  getMany: <const Inputs extends readonly Input[]>(
    inputs: Inputs,
    options?: HashedReadOptions,
  ) => Promise<{
    -readonly [K in keyof Inputs]:
      | Entry<
          SpecForId<SpecOf<RT>, Extract<MintedId, SpecOf<RT>["id"]>>,
          Validators,
          Params
        >
      | Error;
  }>;
  close: () => Promise<void>;
};

/** Preserve the branch result selected by each original input. */
type HashedBranchEntry<
  RT extends ResourceTypes,
  Meta extends HashedInputProducerMeta,
  Input,
> = {
  [K in Meta["covered"]]: Input extends Meta["inputs"][K]
    ? Entry<
        SpecForId<SpecOf<RT>, Extract<Meta["mintedIds"][K], SpecOf<RT>["id"]>>,
        Meta["validators"],
        Meta["params"]
      >
    : never;
}[Meta["covered"]];

type WrappedHashedBranches<
  RT extends ResourceTypes,
  Meta extends HashedInputProducerMeta,
> = {
  get: <Input extends Meta["inputs"][Meta["covered"]]>(
    input: Input,
    options?: HashedReadOptions,
  ) => Promise<HashedBranchEntry<RT, Meta, Input>>;
  getMany: <const Inputs extends readonly Meta["inputs"][Meta["covered"]][]>(
    inputs: Inputs,
    options?: HashedReadOptions,
  ) => Promise<{
    -readonly [K in keyof Inputs]:
      | HashedBranchEntry<RT, Meta, Inputs[K]>
      | Error;
  }>;
  close: () => Promise<void>;
};

/**
 * Thrown when a branch's `hashInput` minted an id that classifies to exactly
 * one resource type -- just not the branch's own.
 *
 * Its own error rather than a re-worded {@link UnclassifiableIdError}, because
 * it is a different fact with a different culprit. Classification did not fail
 * here: it succeeded and returned a type the branch does not own, which points
 * at that branch's `hashInput` rather than at the registry's `matches` guards.
 * Both facts a handler needs to tell those apart -- the type the branch expected
 * and the type the id actually classified to -- are therefore fields and not
 * merely message text, so "a producer is wired to the wrong branch" can be
 * routed separately from "this registry does not cover this id space".
 *
 * Only the multi-branch form raises it. The single-producer form declares no
 * resource type, so there is no name to check a mint against and an
 * unclassifiable mint is the only reachable mint failure (see
 * {@link checkMintedId}).
 */
export class MintedIdResourceTypeMismatchError extends CacheContractError {
  override readonly name = "MintedIdResourceTypeMismatchError";
  readonly cacheName: string;
  readonly id: string;
  /** The branch -- i.e. the resource-type name -- whose `hashInput` minted `id`. */
  readonly branch: string;
  /** The resource type `id` actually classified to. Never equals `branch`. */
  readonly classifiedResourceType: string;

  constructor(args: {
    cacheName: string;
    id: string;
    branch: string;
    classifiedResourceType: string;
  }) {
    super(
      `Cache "${args.cacheName}": \`hashInput\` for branch "${args.branch}" minted id ${JSON.stringify(args.id)}, which classifies to resource type "${args.classifiedResourceType}" instead of "${args.branch}"`,
    );
    this.cacheName = args.cacheName;
    this.id = args.id;
    this.branch = args.branch;
    this.classifiedResourceType = args.classifiedResourceType;
  }
}

/**
 * Checks that a branch's `hashInput` minted an id that classifies to that
 * branch's own resource type. Runs before the id is used for anything (in
 * particular, before any cache read). Vacuous for accept-everything
 * registries, whose guard accepts every id.
 *
 * Three distinguishable failures, one per way the check can go wrong: the mint
 * matched NO resource type ({@link UnclassifiableIdError}) or SEVERAL
 * ({@link AmbiguousResourceTypeError}) -- both rethrown from `classify` with the
 * offending branch named, since the fact is unchanged and only the message
 * improves -- or it matched exactly one that isn't the branch's
 * ({@link MintedIdResourceTypeMismatchError}).
 *
 * `branchName` is absent for the single-producer form, which declares no
 * resource type to check against; there, classifying the id at all is the whole
 * check (an unclassifiable mint still fails loud, just without a name, and the
 * mismatch case is unreachable).
 */
function checkMintedId(
  cache: { readonly name: string; classify: (id: string) => string },
  branchName: string | undefined,
  id: string,
): void {
  const forBranch =
    branchName === undefined ? "" : ` for branch "${branchName}"`;

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
        message: `Cache "${cache.name}": \`hashInput\`${forBranch} minted id ${JSON.stringify(id)}, which matches no resource type in the registry`,
        cause: e.cause,
      });
    }
    if (e instanceof AmbiguousResourceTypeError) {
      throw new AmbiguousResourceTypeError({
        cacheName: cache.name,
        id,
        matchedResourceTypes: e.matchedResourceTypes,
        message: `Cache "${cache.name}": \`hashInput\`${forBranch} minted id ${JSON.stringify(id)}, which matches more than one resource type in the registry (${e.matchedResourceTypes.join(", ")})`,
      });
    }
    throw e;
  }

  if (branchName !== undefined && classified !== branchName) {
    throw new MintedIdResourceTypeMismatchError({
      cacheName: cache.name,
      id,
      branch: branchName,
      classifiedResourceType: classified,
    });
  }
}

/**
 * Resolves either call form to the branch table the plumbing dispatches over.
 * The single-producer form has no resource-type name to check mints against, so
 * its one entry is nameless (see {@link checkMintedId}).
 */
function branchEntriesFor(
  hashedInputProducer: HashedInputProducer<HashedInputProducerMeta> | undefined,
  hashInput: ((input: never) => string | Promise<string>) | undefined,
  produce: ((input: never) => Promise<unknown>) | undefined,
): readonly (readonly [string | undefined, LooseBranch<never>])[] {
  if (hashedInputProducer !== undefined) {
    return hashedInputProducer[builtBranches].entries;
  }
  return [[undefined, { hashInput, produce } as unknown as LooseBranch<never>]];
}

/**
 * Derive resource IDs from original inputs and expose get, getMany, and close.
 * Declare exactly one capability: produce or produceMany. Direct callbacks
 * require hashInput. Typed descriptors carry their own branch hash functions
 * and must appear under their matching capability field.
 *
 * Each input's result must remain valid when requests are added, removed,
 * reordered, split, or deduplicated. Branch coverage, minted-ID checks, and
 * supplemental routing remain enforced. Queued and dispatched production keep
 * their inputs independently of caller cancellation and stale returns.
 *
 * Scheduling, partial results, persistence, and shutdown follow wrapProducer.
 * Call options also accept directives, which apply to every supplied input.
 *
 * See the module docs for when to use this vs. {@link wrapProducer}, and for the
 * branch/coverage/minted-id contracts. Any {@link WrapProducerOptions} field may
 * be set alongside.
 */
export function wrapHashedInputProducer<
  RT extends ResourceTypes,
  Meta extends HashedInputProducerMeta & { kind: "single" },
>(
  options: WrapProducerOptions<RT, Meta["validators"], Meta["params"]> & {
    produce: HashedInputProducer<Meta>;
    produceMany?: never;
    hashInput?: never;
    // A single-request producer never batches.
    producerBatching?: never;
  },
): [HashedInputProducerProblems<RT, Meta>] extends [never]
  ? WrappedHashedBranches<RT, Meta>
  : HashedInputProducerProblems<RT, Meta>;
export function wrapHashedInputProducer<
  RT extends ResourceTypes,
  Input,
  MintedId extends SpecOf<RT>["id"],
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  options: WrapProducerOptions<RT, Validators, Params> & {
    produceMany?: never;
    hashInput: (input: Input) => MintedId | Promise<MintedId>;
    // A single-request producer never batches.
    producerBatching?: never;
    produce: (
      input: ReadonlyDeep<Input>,
    ) => Promise<
      HashedInputProducerResult<
        Input,
        SpecForId<SpecOf<RT>, MintedId>,
        Validators,
        Params,
        SpecForId<SpecOf<RT>, MintedId>,
        SpecOf<RT>
      >
    >;
  },
): WrappedHashedInputProducer<RT, Input, MintedId, Validators, Params>;
export function wrapHashedInputProducer<
  RT extends ResourceTypes,
  Meta extends HashedInputProducerMeta & { kind: "bulk" },
>(
  options: WrapProducerOptions<RT, Meta["validators"], Meta["params"]> & {
    produceMany: HashedInputProducer<Meta>;
    produce?: never;
    hashInput?: never;
  },
): [HashedInputProducerProblems<RT, Meta>] extends [never]
  ? WrappedHashedBranches<RT, Meta>
  : HashedInputProducerProblems<RT, Meta>;
export function wrapHashedInputProducer<
  RT extends ResourceTypes,
  Input,
  MintedId extends SpecOf<RT>["id"],
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  options: WrapProducerOptions<RT, Validators, Params> & {
    produce?: never;
    hashInput: (input: Input) => MintedId | Promise<MintedId>;
    produceMany: (
      inputs: readonly ReadonlyDeep<Input>[],
    ) => Promise<
      readonly (
        | HashedInputProducerResult<
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
): WrappedHashedInputProducer<RT, Input, MintedId, Validators, Params>;
export function wrapHashedInputProducer(
  options: WrapProducerOptions<ResourceTypes, AnyValidators, AnyParams> & {
    hashInput?: (input: never) => string | Promise<string>;
    produce?:
      | ((input: never) => Promise<unknown>)
      | HashedInputProducer<HashedInputProducerMeta>;
    produceMany?:
      | ((inputs: readonly never[]) => Promise<unknown>)
      | HashedInputProducer<HashedInputProducerMeta>;
  },
): unknown {
  const {
    cache,
    produce,
    produceMany,
    hashInput,
    producerBatching,
    ...producerOptions
  } = options;
  const bulk = produceMany !== undefined;
  const primitive = produce ?? produceMany!;

  const descriptor =
    typeof primitive === "object" &&
    primitive !== null &&
    builtBranches in primitive
      ? primitive
      : undefined;
  const branchEntries = branchEntriesFor(
    descriptor,
    hashInput,
    descriptor === undefined
      ? (primitive as (input: never) => Promise<unknown>)
      : undefined,
  );

  // Maps each request object that `run` passes to `wrapped.getMany` to the
  // input it was hashed from, so the internal producer can recover the input
  // from the request it receives. The client passes that same object to the
  // producer (see ReachesProducerAsIs), and its production task holds the
  // object until the task settles. So an entry lives exactly as long as some
  // caller or task can still need it, with no reference counting: a caller
  // that is cancelled or returns stale data drops only its own reference.
  // A request that rides another's task reaches the producer as the starting
  // request's object; its input is equal because its id is equal. The input
  // is boxed because an input may itself be `undefined`.
  const inputByRequest = new WeakMap<object, { input: never }>();
  const inputFor = (request: { readonly id: string }): never => {
    const entry = inputByRequest.get(request);
    if (entry === undefined) {
      throw new CacheContractError(
        `wrapHashedInputProducer: no input is registered for the request with cache id "${request.id}". ` +
          "The producer received a request object that this wrapper did not create, " +
          "which should be impossible (it would indicate that the request was copied on its way to the producer, or a bug).",
      );
    }
    return entry.input;
  };
  // Hashing that close() waits for: input hashing, and supplemental hashing
  // inside production.
  const hashingTasks = new PendingPromisesTracker();

  const hashSupplementals = makeSupplementalHasher<never>(
    "wrapHashedInputProducer",
    branchEntries,
    cache,
    hashingTasks,
  );
  // Bound concurrent input hashing (see HASH_CONCURRENCY); shared across calls.
  const hashLimit = pLimit(HASH_CONCURRENCY);

  // The internal producer for a branch recovers that branch's inputs from the
  // request objects it receives (see `inputByRequest`) and hands them to the
  // branch's `produce`.
  const internalSingle =
    (branch: LooseBranch<never>) => async (request: { readonly id: string }) =>
      hashSupplementals(await branch.produce(inputFor(request)));

  const internalBulk =
    (branch: LooseBranch<never>) =>
    async (requests: readonly { readonly id: string }[]) => {
      // The descriptor capability check proves this erased branch receives a batch.
      const producer = branch.produce as unknown as (
        inputs: readonly never[],
      ) => Promise<
        readonly (
          | HashedInputProducerResult<
              never,
              CacheSpec,
              AnyValidators,
              AnyParams
            >
          | Error
        )[]
      >;

      const results = await producer(requests.map(inputFor));
      if (!Array.isArray(results) || results.length !== requests.length) {
        throw new CacheContractError(
          "Producer result count must match request count",
        );
      }

      // A result whose supplementals fail to hash fails only its own slot,
      // including for a MintedIdResourceTypeMismatchError. The invocation can
      // hold other callers' requests, which automatic batching merged in.
      return Promise.all(
        results.map(async (result) =>
          result instanceof Error
            ? result
            : hashSupplementals(result).catch(asError),
        ),
      );
    };

  // With named branches the per-type record goes through `producerByIdType`
  // (or `bulkProducerByIdType`), which turns it into the single producer
  // function `wrapProducer` takes and which carries this wrapper's coverage, so
  // the branch keys still bound the delegated requests. The single-producer
  // form needs none of that: there is one producer for every id it mints, and
  // branchEntriesFor guarantees exactly one entry for it.
  //
  // SAFETY: the casts bridge the erased internal producers to the helper's
  // per-type record type, which is opaque while `RT` is an unresolved generic.
  // Runtime dispatch upholds the contract: each producer only ever receives ids
  // its own branch's `hashInput` minted, checked in `run` to classify to that
  // branch's type before any request.
  const wrapped = bulk
    ? wrapProducer({
        ...producerOptions,
        ...(producerBatching === undefined ? {} : { producerBatching }),
        cache,
        produceMany:
          descriptor === undefined
            ? internalBulk(branchEntries[0]![1])
            : bulkProducerByIdType(
                cache.resourceTypes,
                Object.fromEntries(
                  branchEntries.map(([name, branch]) => [
                    name,
                    internalBulk(branch),
                  ]),
                ) as BulkProducersFor<
                  ResourceTypes,
                  string,
                  AnyValidators,
                  AnyParams,
                  Error
                >,
              ),
      })
    : wrapProducer({
        ...producerOptions,
        cache,
        produce:
          descriptor === undefined
            ? internalSingle(branchEntries[0]![1])
            : producerByIdType(
                cache.resourceTypes,
                Object.fromEntries(
                  branchEntries.map(([name, branch]) => [
                    name,
                    internalSingle(branch),
                  ]),
                ) as ProducersFor<
                  ResourceTypes,
                  string,
                  AnyValidators,
                  AnyParams
                >,
              ),
      });

  const calls = new PendingPromisesTracker();
  const admissions = new PendingPromisesTracker();
  let closed = false;
  let closing: Promise<void> | undefined;

  const run = async (
    inputs: readonly never[],
    admitted: () => void,
    startedAt: number,
    callOptions?: HashedReadOptions,
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // Route each input to its branch, keeping the branch itself (not just its
    // name) so hashing doesn't have to look it up again, then hash with that
    // branch's `hashInput` (bounded by `hashLimit`; `hashInput` may be sync --
    // p-limit handles that).
    const routed = inputs.map((input) => ({
      input,
      branch: findBranch("wrapHashedInputProducer", branchEntries, input),
    }));
    const ids = await Promise.all(
      routed.map(({ input, branch: [, branch] }) =>
        hashingTasks.track(hashLimit(async () => branch.hashInput(input))),
      ),
    );
    signal?.throwIfAborted();

    ids.forEach((id, index) =>
      checkMintedId(cache, routed[index]!.branch[0], id),
    );

    // The call-level directives apply to every element. Each request is
    // complete (it has params and directives), so the client passes this
    // same object to the producer instead of a filled-in copy; the producer
    // finds the input by it (see `inputByRequest`).
    const requests = ids.map((id, index) => {
      const request = {
        id,
        params: {},
        directives: callOptions?.directives ?? {},
      };
      inputByRequest.set(request, { input: inputs[index]! });
      return request;
    });

    const wrappedOptions = {
      ...callOptions,
      [wrappedReadStartedAt]: startedAt,
    };
    const result = wrapped.getMany(requests, wrappedOptions);
    admitted();
    return await result;
  };

  const getMany = (
    inputs: readonly never[],
    callOptions?: HashedReadOptions,
  ) => {
    if (closed) {
      return Promise.reject(
        new CacheContractError("Producer wrapper is closed"),
      );
    }

    const admission = Promise.withResolvers<void>();
    void admissions.track(admission.promise);

    const startedAt = performance.now();
    const promise = Promise.resolve()
      .then(() =>
        run(inputs, () => admission.resolve(), startedAt, callOptions),
      )
      .finally(() => admission.resolve());
    void calls.track(promise);

    return promise;
  };

  return {
    get: async (input: never, callOptions?: HashedReadOptions) => {
      let stored: Promise<void> | undefined;
      const [result] = await getMany([input], {
        ...callOptions,
        onStore: (promise) => {
          stored = promise;
        },
      });

      if (result instanceof Error) throw result;
      if (stored !== undefined) callOptions?.onStore?.(stored);
      return result!;
    },
    getMany,
    close: () => {
      if (closing) return closing;

      closed = true;

      // Finish hashing and admission before closing the underlying producer client.
      closing = (async () => {
        await admissions.drain();
        await hashingTasks.drain();
        await wrapped.close();
        await hashingTasks.drain();
        await calls.drain();
      })();

      return closing;
    },
  };
}

/**
 * Builds the function that turns a {@link HashedInputProducerResult} into the
 * plain {@link RequestPairedProducerResult} the underlying producer machinery
 * expects, by hashing each supplemental resource's `input` -- with the
 * producing branch's own `hashInput` -- into its storage id.
 *
 * The casts reconstruct the canonical result shape from the hashed-input result
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
  hashing: PendingPromisesTracker,
) {
  // One limiter shared across every call of the returned resolver.
  const limit = pLimit(HASH_CONCURRENCY);
  return async (
    result: HashedInputProducerResult<
      Input,
      CacheSpec,
      AnyValidators,
      AnyParams
    >,
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
          // a producer minting a bad supplemental id fails that result's
          // slot loudly (named branch) instead of a silent store-time
          // rejection behind the wrappers' fire-and-forget store.
          const { input, ...rest } = resource;
          return hashing.track(
            limit(async () => {
              const [branchName, branch] = findBranch(
                wrapperName,
                branchEntries,
                input,
              );
              const id = await branch.hashInput(input as Input);
              checkMintedId(cache, branchName, id);
              return { ...rest, id };
            }),
          );
        }),
      ),
    } as unknown as RequestPairedProducerResult<
      CacheSpec,
      AnyValidators,
      AnyParams
    >;
  };
}
