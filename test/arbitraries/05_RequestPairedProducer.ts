import fc from "fast-check";
import type { AnyParams } from "../../src/types/01_Params.js";
import type { AnyValidators } from "../../src/types/02_Validators.js";
import type { RequestPairedProducerResult } from "../../src/types/05_RequestPairedProducer.js";
import { ProducerResultArb } from "./04_ProducerResult.js";

/**
 * Fast-check arbitrary for generating RequestPairedProducerResult objects.
 * Generates result objects that omit the id from ProducerResult and make it optional.
 */
export const RequestPairedProducerResultArb = <
  T = unknown,
  U extends AnyValidators = AnyValidators,
  V extends AnyParams = AnyParams,
  Id extends string = string,
>(
  contentArb: fc.Arbitrary<T>,
  validatorsArb: fc.Arbitrary<U>,
  paramsArb: fc.Arbitrary<V>,
  idArb: fc.Arbitrary<Id>,
): fc.Arbitrary<RequestPairedProducerResult<T, U, V, Id>> =>
  fc
    .tuple(
      ProducerResultArb(contentArb, validatorsArb, paramsArb, idArb),
      fc.option(idArb),
    )
    .map(([result, id]) => ({
      ...result,
      ...(id !== null ? { id } : {}),
    }));
