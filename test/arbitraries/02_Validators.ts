import fc from "fast-check";
import type { JSON } from "type-party";
import type { AnyValidators } from "../../src/types/02_Validators.js";

/**
 * Fast-check arbitrary for generating AnyValidators objects.
 * Generates dictionaries with string keys and JSON values.
 */
export const AnyValidatorsArb: fc.Arbitrary<AnyValidators> = fc.dictionary(
  fc.string(),
  // Fix slight mismatch between fc's JSON type and our JSON type.
  fc.jsonValue().map((v) => v as JSON),
);
