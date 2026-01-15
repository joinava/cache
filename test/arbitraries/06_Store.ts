import fc from "fast-check";
import type { AnyParams } from "../../src/types/01_Params.js";
import type { AnyValidators } from "../../src/types/02_Validators.js";
import type { StoreEntryInput } from "../../src/types/06_Store.js";
import { EntryArb } from "./06_Normalization.js";

/**
 * Fast-check arbitrary for generating StoreEntryInput objects.
 * Generates input objects with readonly entry and maxStoreForSeconds.
 */
export const StoreEntryInputArb = <
  T = unknown,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  Id extends string = string,
>(
  contentArb: fc.Arbitrary<T>,
  validatorsArb: fc.Arbitrary<Validators>,
  paramsArb: fc.Arbitrary<Params>,
  idArb: fc.Arbitrary<Id>,
): fc.Arbitrary<StoreEntryInput<T, Validators, Params, Id>> =>
  fc.record({
    entry: EntryArb(contentArb, validatorsArb, paramsArb, idArb),
    maxStoreForSeconds: fc.nat(),
  });
