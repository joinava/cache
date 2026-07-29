import type { ReadonlyDeep } from "type-fest";
import type { CacheSpec, ContentForId } from "./00_CacheSpec.js";
import type { AnyParams } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";
import type { ConsumerRequest } from "./03_ConsumerRequest.js";
import type {
  ProducerResultResource,
  ProducerResultResourceObject,
} from "./04_ProducerResult.js";
import type { IsSingleType } from "./utils.js";

/**
 * A producer paired with a consumer request: invoked with the full request,
 * the producer is expected to return a {@link RequestPairedProducerResult}
 * for that request's `id`.
 *
 * The shape of `RequestPairedProducer` depends on whether the cache's `Spec`
 * is a *single id type* or a *multi-id type* (a union of {@link CacheSpec}s):
 *
 * - **Single-id-type mode** (one `CacheSpec` variant — the most common case):
 *   the producer is a plain non-generic function. The (id, content)
 *   correlation is trivially preserved because there's only one possible
 *   content type.
 *
 * - **Multi-id-type mode** (a union of `CacheSpec`s): the producer is generic
 *   over the request's specific id, so its return type is required to match
 *   the spec variant that id selects. Implementing such a producer directly
 *   is awkward (TypeScript can't narrow the function's free type parameter
 *   based on runtime checks on `req.id`) -- which is why the wrappers take a
 *   record of single-type producers and dispatch by classified resource type
 *   instead; this multi-variant form survives as the internal erased shape
 *   those records bridge to.
 *
 * Implementations of this type MUST NOT be `instanceof Error`, as instanceof
 * Error is used elsewhere to detect if the result could not be returned.
 */
export type RequestPairedProducer<
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> =
  IsSingleType<Spec> extends true
    ? SingleIdTypeRequestPairedProducer<Spec, Validators, Params>
    : MultiIdTypeRequestPairedProducer<Spec, Validators, Params>;

/**
 * The single-id-type form of {@link RequestPairedProducer}: a non-generic
 * function whose return need only be valid for the spec's one variant.
 */
export type SingleIdTypeRequestPairedProducer<
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = (
  req: ReadonlyDeep<ConsumerRequest<Params, Spec["id"]>>,
  options?: { signal?: AbortSignal },
) => Promise<RequestPairedProducerResult<Spec, Validators, Params>>;

/**
 * The multi-id-type form of {@link RequestPairedProducer}: generic over the
 * request's specific id, so the return type's content is required to match
 * the spec variant that id selects.
 *
 * This is the form that internal code (`wrapProducer`,
 * `requestPairedProducerResultToResources`, etc.) operates against. In
 * single-id-type mode the loose user-facing form is coerced to this one
 * inside `wrapProducer`; that coercion is sound because all ids in single-
 * id-type mode share the same content type, so any valid loose result is
 * also a valid result for an arbitrary requested id.
 */
export type MultiIdTypeRequestPairedProducer<
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = <Id extends Spec["id"]>(
  req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
  options?: { signal?: AbortSignal },
) => Promise<RequestPairedProducerResult<Spec, Validators, Params, Id>>;

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
