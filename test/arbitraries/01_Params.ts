import fc from "fast-check";
import type { AnyParamValue, AnyParams } from "../../src/types/01_Params.js";

/**
 * Fast-check arbitrary for generating AnyParamValue objects.
 * Generates JSON values (excluding null).
 */
export const AnyParamValueArb: fc.Arbitrary<AnyParamValue> = fc
  .jsonValue()
  .filter((value) => value !== null);

/**
 * Fast-check arbitrary for generating AnyParams objects.
 * Generates dictionaries with string keys and JSON values (excluding null).
 */
export const AnyParamsArb: fc.Arbitrary<AnyParams> = fc.dictionary(
  fc.string(),
  AnyParamValueArb,
);
