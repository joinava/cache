/**
 * @fileoverview The producer contract: what a producer returns, the function
 * shapes that producers implement, and the `coveredTypes` declaration through
 * which a producer states which resource types it covers.
 *
 * @module
 */
import type { CacheSpec, ContentForId } from "./00_CacheSpec.js";
import type {
  IdOfResourceType,
  ResourceTypeName,
  ResourceTypes,
  SpecOf,
} from "./00_ResourceTypes.js";
import type { AnyParams } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";
import type { ReadonlyConsumerRequest } from "./03_ConsumerRequest.js";
import type {
  ProducerResultResource,
  ProducerResultResourceObject,
} from "./04_ProducerResult.js";

/**
 * A producer result that will be processed along with a corresponding request.
 * Because the request will have indicated the id, the producer can leave that
 * out (and `wrapProducer` will use the request's `id` to fill it in). However,
 * it must still set `vary`, if the result varied on any request params.
 *
 * The shape is a discriminated union over `Spec`: each variant pairs an `id`
 * (now made optional) with the matching `content`. So a producer for a cache
 * with `Spec = (story:..., Story) | (collection:..., Story[])` must return
 * either a Story-shaped or Collection-shaped result, but cannot return a
 * Story-content paired with a `collection:` id.
 *
 * Supplemental resources may correspond to any spec variant (so a fetch for a
 * collection can attach the individual stories as supplementals).
 *
 * Implementations of this type MUST NOT be `instanceof Error`, as instanceof
 * Error is used elsewhere to detect if the result could not be returned.
 */
export type RequestPairedProducerResult<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends Spec["id"] = Spec["id"],
> = Id extends unknown
  ? // For each valid id type, make a paired { id?, content } object,
    // but where supplementalResources can have ids from any spec variant.
    Omit<
      ProducerResultResourceObject<
        Id,
        ContentForId<Spec, Id>,
        Params,
        Validators
      >,
      "id"
    > & {
      id?: Id;
      supplementalResources?: ProducerResultResource<
        Spec,
        Validators,
        Params
      >[];
    }
  : never;

/**
 * A producer over some set of resource types: it sees exactly those types' ids
 * and returns results stamped with them. Used at both scales -- with a single
 * `K` it is a `producerByIdType` sub-producer (which sees only its own
 * branch's ids), and with a whole covered set it is the function half of
 * {@link CoveringProducer}, which is what the wrappers take.
 *
 * Each request remains valid when reordered, split, or shared with other calls.
 * Producers receive original parameters; normalization promises equivalent behavior.
 *
 * Note: {@link RequestPairedProducerResult} already allows
 * `supplementalResources` from ANY spec variant, so (e.g.) a `site_day`
 * producer can still attach `business_slice` supplementals.
 *
 * Takes no `AbortSignal`. Every producer invocation goes through the wrappers'
 * collapsed-invocation task, which is shared between logical callers, so there
 * is no single signal it could forward without letting one caller cancel
 * another's work. Callers' aborts are honored one level up, where each caller's
 * *wait* is raced against its own signal.
 */
export type ResourceTypeProducer<
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = (
  req: ReadonlyConsumerRequest<Params, IdOfResourceType<RT[K]>>,
) => Promise<
  RequestPairedProducerResult<
    SpecOf<RT>,
    Validators,
    Params,
    IdOfResourceType<RT[K]>
  >
>;

/**
 * A bulk producer for ONE resource type: a `bulkProducerByIdType`
 * sub-producer. That helper splits the wrapper's batch by classified resource
 * type and calls each sub-producer once with its own type's slice, so a
 * sub-producer's batch never mixes types. (The wrapper itself takes a single
 * {@link CoveringBulkProducer}, which by default sees the WHOLE mixed batch --
 * that is the point of the single-function form.) Results are request-paired;
 * Error elements mark per-request failures. Every request must remain valid
 * when added, removed, reordered, split, or deduplicated in another batch.
 *
 * The result type is a flat array of (RequestPairedProducerResult |
 * ErrorType): each element is a discriminated union over the type's spec, so
 * each (id, content) pair must internally agree, but the type system does
 * not require the i'th result element to align with the i'th request's id at
 * the call site (which would require gnarly mapped-tuple typing). When
 * `wrapProducer` returns its results to the caller, they ARE narrowed
 * per-request via `WrappedProducerClient`'s per-request generic.
 */
export type BulkResourceTypeProducer<
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = (
  reqs: readonly ReadonlyConsumerRequest<Params, IdOfResourceType<RT[K]>>[],
) => Promise<
  (
    | RequestPairedProducerResult<
        SpecOf<RT>,
        Validators,
        Params,
        IdOfResourceType<RT[K]>
      >
    | ErrorType
  )[]
>;

/**
 * The key under which a producer function declares WHICH resource types it
 * covers. A real runtime symbol carrying a real runtime value (see
 * {@link CoveringProducer}), not a type-only phantom: the wrappers read it
 * to enforce coverage, and it is exported so declaration emit can name it.
 */
export const coveredTypes: unique symbol = Symbol(
  "@zingage/cache.coveredTypes",
);

/**
 * The conditionally-required {@link coveredTypes} carrier: optional when
 * `Covered` is the whole registry, REQUIRED when it is a strict subset. Shared
 * by {@link CoveringProducer} and its bulk counterpart so the two cannot drift
 * -- relaxing one to always-optional would reopen the hole described on
 * `CoveringProducer` for that wrapper alone.
 *
 * The tuple brackets make this a whole-set comparison rather than a
 * distributive, member-by-member one.
 */
export type CoveredTypesCarrier<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
> = [ResourceTypeName<RT>] extends [Covered]
  ? { readonly [coveredTypes]?: readonly Covered[] }
  : { readonly [coveredTypes]: readonly Covered[] };

/**
 * A producer function that may additionally declare WHICH resource types it
 * covers. The property carries a real runtime value -- the covered type names
 * -- so it serves double duty: `Covered` is inferred from it at compile time,
 * and the wrapper reads it at runtime to enforce coverage before touching the
 * store. A value-less phantom would leave the wrapper with no runtime source for
 * the covered set, since there are no record keys to read.
 *
 * ## Why the property is conditionally required
 *
 * It is optional when `Covered` is the whole registry -- that is what lets a
 * bare function be passed with no ceremony, and no runtime check is needed
 * there because the compiler already made the function prove it accepts every
 * registry id. It is REQUIRED when `Covered` is a strict subset, which makes
 * "narrowed coverage implies runtime proof of that narrowing" an invariant the
 * type system enforces rather than a convention.
 *
 * That requirement is what keeps coverage from having two sources that can
 * disagree. You might expect an explicit `Covered` type argument
 * (`wrapProducer<RT, "story">(...)`) to be enough to narrow coverage; it is
 * rejected precisely because it would narrow the TYPES while leaving the runtime
 * covered set absent, which the wrapper reads as "the whole registry". The types
 * still ban uncovered ids at the call site, so the gap is only reachable by
 * defeating them (a cast or a loosely-typed id -- see
 * `NoProducerForResourceTypeError`), but that is exactly the case that
 * error exists to catch: instead of throwing, the wrapper would hand the id to a
 * producer written for a different resource type and then store its content
 * under the incoming id. Routing partial coverage through
 * `producerByIdType`, which always supplies the runtime value, makes the
 * declared set and the reachable producers one and the same by construction.
 *
 * `Covered` still infers from the property even though it also appears in the
 * condition (probed, along with the deferred case where `Covered` is an
 * unresolved generic -- how the hashed-input wrappers forward theirs).
 *
 * Narrowing each result's `Id` to `IdOfResourceType<RT[Covered]>` bounds the
 * PRIMARY result to covered types only. Supplementals are unaffected: they are
 * a separate field typed over the full `SpecOf<RT>`, so a covered producer can
 * still attach supplementals for any registry type.
 */
export type CoveringProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = ResourceTypeProducer<RT, Covered, Validators, Params> &
  CoveredTypesCarrier<RT, Covered>;

/**
 * The bulk counterpart of {@link CoveringProducer} (see it for the covered-set
 * rule): a bulk producer function that may additionally declare which resource types it
 * covers. A plain function omits the property and covers the whole registry, so
 * it sees the caller's FULL mixed batch in one call and can optimize across
 * resource types (one upstream call spanning several types, cross-type dedup, a
 * join).
 */
export type CoveringBulkProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
> = BulkResourceTypeProducer<RT, Covered, Validators, Params, ErrorType> &
  CoveredTypesCarrier<RT, Covered>;
