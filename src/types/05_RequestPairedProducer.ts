import type { ReadonlyDeep } from "type-fest";
import type { CacheSpec, ContentForId } from "./00_CacheSpec.js";
import type { AnyParams } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";
import type { ConsumerRequest } from "./03_ConsumerRequest.js";
import type {
  ProducerResultResource,
  ProducerResultResourceObject,
} from "./04_ProducerResult.js";

/**
 * A producer paired with a consumer request: invoked with the full request,
 * the producer is expected to return a {@link RequestPairedProducerResult}
 * for that request's `id`.
 *
 * Generic over the request's specific id, so the return type's content is
 * required to match the spec variant that id selects. Implementing this shape
 * directly is awkward (TypeScript can't narrow the function's free type
 * parameter based on runtime checks on `req.id`) -- which is why the wrappers
 * take a record of per-resource-type producers (`ResourceTypeProducer` /
 * `BulkResourceTypeProducer`) and dispatch by classified resource type
 * instead. This form survives as the internal erased shape those records
 * bridge to, and is what internal code (`wrapProducer`,
 * `requestPairedProducerResultToResources`, etc.) operates against.
 *
 * Through 1.6.0 this name was a conditional type that resolved to a
 * non-generic `SingleIdTypeRequestPairedProducer` when `Spec` had one variant
 * and a `MultiIdTypeRequestPairedProducer` when it was a union. Now that
 * dispatch is owned by the per-type producer records, that distinction had no
 * consumer -- nothing in the implementation referenced any of the three forms
 * -- so both halves and the conditional were deleted; this is the former
 * multi-id form under the plain name.
 *
 * Takes no `AbortSignal`: through 1.6.0 this and the other producer types
 * declared an `options?: { signal?: AbortSignal }` parameter, but every
 * producer invocation in 2.0 goes through the wrappers' collapsed-invocation
 * task, which is shared between logical callers and so has no single signal it
 * could forward without letting one caller cancel another's work. (1.6.0's one
 * non-collapsed producer call was the `isCacheable` pass-through, deleted in
 * §6.3.) Callers' aborts are honored one level up, where each caller's *wait*
 * is raced against its own signal. The parameter was therefore unreachable
 * surface -- a producer written against it got cancellation code that could
 * never run -- so it was removed.
 *
 * Implementations of this type MUST NOT be `instanceof Error`, as instanceof
 * Error is used elsewhere to detect if the result could not be returned.
 */
export type RequestPairedProducer<
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = <Id extends Spec["id"]>(
  req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
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
