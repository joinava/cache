import type { CacheSpec, ContentForId } from "./00_CacheSpec.js";
import type { AnyParams } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";
import type { ReadonlyConsumerRequest } from "./03_ConsumerRequest.js";
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
 * directly is awkward -- TypeScript can't narrow the function's free type
 * parameter based on runtime checks on `req.id` -- so a producer that must
 * handle several resource types is better written as a per-resource-type record
 * handed to `producerByIdType` / `bulkProducerByIdType`, whose sub-producers
 * each see one branch's ids.
 *
 * This type describes that shape for callers who want to name it; the wrappers
 * themselves take a `CoveringProducer` and dispatch through their own erased
 * internal shape, so nothing in the package consumes this type.
 *
 * Takes no `AbortSignal`. Every producer invocation goes through the wrappers'
 * collapsed-invocation task, which is shared between logical callers, so there
 * is no single signal it could forward without letting one caller cancel
 * another's work. Callers' aborts are honored one level up, where each caller's
 * *wait* is raced against its own signal.
 *
 * Implementations of this type MUST NOT be `instanceof Error`, as instanceof
 * Error is used elsewhere to detect if the result could not be returned.
 */
export type RequestPairedProducer<
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = <Id extends Spec["id"]>(
  req: ReadonlyConsumerRequest<Params, Id>,
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
