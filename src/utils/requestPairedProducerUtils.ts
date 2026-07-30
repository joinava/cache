import type { ReadonlyDeep } from "type-fest";
import type { CacheSpec, SpecForId } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ConsumerRequest,
  NormalizedVary,
  ProducerResultResource,
  RequestPairedProducerResult,
  Vary,
} from "../types/index.js";
import type { MakeKeysOptional } from "../types/utils.js";
import { normalizeProducerResultResource } from "./normalization.js";

export type PartialConsumerRequest<
  Params extends AnyParams,
  Id extends string,
> = ReadonlyDeep<
  MakeKeysOptional<ConsumerRequest<Params, Id>, "directives" | "params">
>;

/**
 * Replace undefined params + directives w/ empty objects
 */
export function completeRequest<Params extends AnyParams, Id extends string>(
  req: PartialConsumerRequest<Params, Id>,
): ReadonlyDeep<ConsumerRequest<Params, Id>> {
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
 * The strongest available user-facing (id, content) correlation backstop comes
 * from the per-type producer records the by-id-type helpers take
 * (`ResourceTypeProducer` / `BulkResourceTypeProducer`): there each
 * sub-producer's `req.id` is pinned to its own registry branch, so its result
 * can only pair that branch's content with that branch's ids. A single
 * whole-registry producer function gets a weaker guarantee -- its result type is
 * the union over its covered ids, so the compiler does not require the content
 * it returns to match the specific id it was handed (nothing checks content
 * shape at runtime either -- reach for the by-id-type helper when that
 * correlation matters). Either way this helper's job is just to build the
 * runtime store input: it never synthesizes id or content, only spreads what
 * the producer returned alongside the request's own id. TS can't see through
 * the conditional/distributive types involved here, so the construction needs
 * an unsafe cast; the cast is sound in that same sense.
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
  >(
    normalizeVaryBound,
    {
      ...primaryResource,
      id: reqId,
    } as unknown as ProducerResultResource<
      SpecForId<Spec, Id>,
      Validators,
      Params
    >,
  );
}
