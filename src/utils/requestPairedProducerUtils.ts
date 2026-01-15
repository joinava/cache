import { omit } from "es-toolkit";
import type { ReadonlyDeep } from "type-fest";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ConsumerRequest,
  NormalizedVary,
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

export function requestPairedProducerResultToResources<
  Content,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string,
>(
  result: RequestPairedProducerResult<Content, Validators, Params, Id>,
  reqId: Id,
) {
  const { supplementalResources, ...rest } = result;
  return [{ id: reqId, ...rest }, ...(supplementalResources ?? [])];
}

export function primaryNormalizedResultResourceFromRequestPairedProducerResult<
  Content,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string,
>(
  normalizeVaryBound: (vary: Vary<Params>) => NormalizedVary<Params>,
  result: RequestPairedProducerResult<Content, Validators, Params, Id>,
  reqId: Id,
) {
  return normalizeProducerResultResource(normalizeVaryBound, {
    id: reqId,
    ...omit(result, ["supplementalResources"]),
  });
}
