import fc from "fast-check";
import type { AnyValidators } from "../../src/types/02_Validators.js";

/**
 * Fast-check arbitrary for generating AnyValidators objects.
 * Generates dictionaries with string keys and JSON values.
 */
export const AnyValidatorsArb: fc.Arbitrary<AnyValidators> = fc.dictionary(
  fc.string(),
  fc.jsonValue(),
);
