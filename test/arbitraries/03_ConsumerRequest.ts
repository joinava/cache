import fc from "fast-check";
import type { AnyParams } from "../../src/types/01_Params.js";
import type {
  ConsumerDirectives,
  ConsumerRequest,
} from "../../src/types/03_ConsumerRequest.js";
import { normalizeConsumerMaxStale } from "../../src/utils/normalization.js";

/**
 * NB: our types don't yet distinguish between pre- and post-normalization
 * ConsumerDirectives, so this will always generate post-normalized directives
 * where the maxStale thresholds are increasing and maxAge is non-negative.
 */
const consumerDirectivesArbMap = {
  maxAge: fc.nat(),
  maxStale: fc
    .record({
      freshUntilAge: fc.option(fc.nat(), { nil: undefined }),
      withoutRevalidation: fc.nat(),
      whileRevalidate: fc.nat(),
      ifError: fc.nat(),
    })
    .map((raw) => normalizeConsumerMaxStale(raw)),
};

/**
 * Fast-check arbitrary for generating ConsumerDirectives objects.
 * All directives are optional.
 */
export const ConsumerDirectivesArb: fc.Arbitrary<ConsumerDirectives> =
  fc.record(consumerDirectivesArbMap, { requiredKeys: [] });

/**
 * Fast-check arbitrary for generating ConsumerDirectives with all directives included.
 */
export const AllConsumerDirectivesArb = fc.record(consumerDirectivesArbMap);

/**
 * Fast-check arbitrary for generating ConsumerRequest objects.
 * Generates requests with id, partial params, and directives.
 */
export const ConsumerRequestArb = <
  Params extends AnyParams = AnyParams,
  Id extends string = string,
>(
  paramsArb: fc.Arbitrary<Params>,
  idArb: fc.Arbitrary<Id>,
): fc.Arbitrary<ConsumerRequest<Params, Id>> => {
  return fc.record({
    id: idArb,
    params: paramsArb,
    directives: ConsumerDirectivesArb,
  });
};
