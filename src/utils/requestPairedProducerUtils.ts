import type { ReadonlyDeep } from "type-fest";
import type { CacheSpec, SpecForId } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ReadonlyConsumerRequest,
  NormalizedVary,
  ProducerResultResource,
  RequestPairedProducerResult,
  Vary,
  PartialReadonlyConsumerRequest,
} from "../types/index.js";
import { normalizeProducerResultResource } from "./normalization.js";

/**
 * Replace undefined params + directives w/ empty objects
 */
export function completeRequest<Params extends AnyParams, Id extends string>(
  req: PartialReadonlyConsumerRequest<Params, Id>,
): ReadonlyConsumerRequest<Params, Id> {
  const {
    id,
    params = {} satisfies Partial<Params> as ReadonlyDeep<Partial<Params>>,
    directives = {} satisfies ConsumerDirectives as ReadonlyDeep<ConsumerDirectives>,
  } = req;
  return { id, params, directives };
}

/**
 * Splits a `RequestPairedProducerResult` into a flat list of resources to be
 * stored: the primary resource (with the request's id stamped on) followed by
 * any supplemental resources.
 *
 * The returned array contains entries for all spec variants in `Spec`, since
 * supplemental resources may correspond to any variant -- not just the one
 * matching the request's id.
 *
 * The strongest available (id, content) correlation check comes from the
 * per-type producer records the by-id-type helpers take: each sub-producer's
 * `req.id` is pinned to its own registry branch, so its result can only pair
 * that branch's content with that branch's ids. A single whole-registry producer
 * function gets a weaker guarantee -- its result type is the union over its
 * covered ids, so the compiler does not require the content it returns to match
 * the specific id it was handed, and nothing checks content shape at runtime
 * either. Reach for the by-id-type helper when that correlation matters.
 *
 * This helper's own job is just to build the runtime store input: it never
 * synthesizes id or content, only spreads what the producer returned alongside
 * the request's own id. TS can't see through the conditional/distributive types
 * involved, so the construction needs an unsafe cast.
 */
export function requestPairedProducerResultToResources<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends Spec["id"] = Spec["id"],
>(
  result: RequestPairedProducerResult<Spec, Validators, Params, Id>,
  reqId: Id,
): ProducerResultResource<Spec, Validators, Params>[] {
  const { supplementalResources, ...rest } = result;
  return [
    {
      ...rest,
      id: reqId,
    } as unknown as ProducerResultResource<Spec, Validators, Params>,
    ...((supplementalResources ?? []) as ProducerResultResource<
      Spec,
      Validators,
      Params
    >[]),
  ];
}

/**
 * Builds a normalized `ProducerResultResource` for the primary resource of a
 * `RequestPairedProducerResult` (i.e., excluding supplemental resources). The
 * id is taken from the request, and the result's content is narrowed to the
 * spec variants compatible with that id.
 *
 * Like {@link requestPairedProducerResultToResources}, this takes `Id extends
 * Spec["id"]` so the construction can be expressed against the
 * spec-narrowed `ProducerResultResource<SpecForId<Spec, Id>, ...>`. The
 * actual cast is unsafe (TS can't follow the conditional types), but is
 * sound because the runtime data is just spread/forwarded from the
 * producer's already-correlated output.
 */
export function primaryNormalizedResultResourceFromRequestPairedProducerResult<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends Spec["id"],
>(
  normalizeVaryBound: (vary: Vary<Params>) => NormalizedVary<Params>,
  result: RequestPairedProducerResult<Spec, Validators, Params, Id>,
  reqId: Id,
) {
  const { supplementalResources: _, ...primaryResource } = result;

  return normalizeProducerResultResource<
    SpecForId<Spec, Id>,
    Validators,
    Params
  >(normalizeVaryBound, {
    ...primaryResource,
    id: reqId,
  } as unknown as ProducerResultResource<
    SpecForId<Spec, Id>,
    Validators,
    Params
  >);
}
