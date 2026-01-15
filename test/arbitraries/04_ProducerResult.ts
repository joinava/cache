import fc from "fast-check";
import type { AnyParams } from "../../src/types/01_Params.js";
import type { AnyValidators } from "../../src/types/02_Validators.js";
import type {
  ProducerDirectives,
  ProducerMaxStale,
  ProducerResult,
  ProducerResultResource,
  Vary,
} from "../../src/types/04_ProducerResult.js";
import { AnyNumberArb } from "./utils.js";

/**
 * Arbitrary for ProducerMaxStale object. Generates values where thresholds
 * may not yet be normalized (i.e., may not be monotonically increasing).
 */
export const MaxStaleArb: fc.Arbitrary<ProducerMaxStale> = fc.record({
  withoutRevalidation: AnyNumberArb,
  whileRevalidate: AnyNumberArb,
  ifError: AnyNumberArb,
});

// This maps all producer directives to an arbitrary appropriate to generate an
// _unnormalized_ directive value (e.g., freshUntilAge could be given as a
// negative number).
const producerDirectivesArbMap = {
  freshUntilAge: AnyNumberArb,
  maxStale: MaxStaleArb,
  storeFor: AnyNumberArb,
};

/**
 * Fast-check arbitrary for generating ProducerDirectives objects.
 * Non-normalized, so maxStale and freshUntilAge values can be any numbers.
 */
export const ProducerDirectivesArb: fc.Arbitrary<ProducerDirectives> =
  fc.record(producerDirectivesArbMap, { requiredKeys: ["freshUntilAge"] });

export const AllProducerDirectivesArb = fc.record(producerDirectivesArbMap);

/**
 * Fast-check arbitrary for generating Vary objects.
 * Generates objects with optional param values that can be the param value or null.
 */
export const VaryArb = <Params extends AnyParams = AnyParams>(
  paramsArb: fc.Arbitrary<Params>,
): fc.Arbitrary<Vary<Params>> =>
  paramsArb.chain(
    (params) =>
      fc.record(
        Object.fromEntries(
          Object.entries(params).map(([key, value]) => [
            key,
            fc
              .oneof(fc.constant(value), fc.constant(null))
              .filter((it) => it !== undefined),
          ]),
        ),
        { requiredKeys: [] },
      ),
    // Not quite correct, but good enough given the complexities around
    // exactOptionalPropertyTypes.
  ) as fc.Arbitrary<Vary<Params>>;

/**
 * Fast-check arbitrary for generating ProducerResultResource objects.
 * Generates resource objects with id, optional vary, content, optional initialAge,
 * optional date, directives, and optional validators.
 */
export const ProducerResultResourceArb = <
  T = unknown,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  Id extends string = string,
>(
  contentArb: fc.Arbitrary<T>,
  validatorsArb: fc.Arbitrary<Validators>,
  paramsArb: fc.Arbitrary<Params>,
  idArb: fc.Arbitrary<Id>,
): fc.Arbitrary<ProducerResultResource<T, Validators, Params, Id>> =>
  fc.record(
    {
      id: idArb,
      vary: VaryArb(paramsArb),
      content: contentArb,
      initialAge: AnyNumberArb,
      date: fc.date(),
      directives: ProducerDirectivesArb,
      validators: validatorsArb,
    },
    { requiredKeys: ["id", "content", "directives"] },
  );

/**
 * Fast-check arbitrary for generating ProducerResult objects.
 * Generates result objects with resource and optional supplementalResources.
 */
export const ProducerResultArb = <
  T = unknown,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  Id extends string = string,
>(
  contentArb: fc.Arbitrary<T>,
  validatorsArb: fc.Arbitrary<Validators>,
  paramsArb: fc.Arbitrary<Params>,
  idArb: fc.Arbitrary<Id>,
): fc.Arbitrary<ProducerResult<T, Validators, Params, Id>> => {
  const resourceArb = ProducerResultResourceArb(
    contentArb,
    validatorsArb,
    paramsArb,
    idArb,
  );

  return fc
    .tuple(resourceArb, fc.option(fc.array(resourceArb)))
    .map(([resource, supplementalResources]) => ({
      ...resource,
      ...(supplementalResources ? { supplementalResources } : {}),
    }));
};
