import fc from "fast-check";
import type { ReadonlyDeep } from "type-fest";
import type { AnyParams } from "../../src/types/01_Params.js";
import type { AnyValidators } from "../../src/types/02_Validators.js";
import type {
  NormalizedParams,
  NormalizedProducerDirectives,
  NormalizedProducerMaxStale,
  NormalizedProducerResult,
  NormalizedProducerResultResource,
  NormalizedVary,
} from "../../src/types/06_Normalization.js";
import {
  normalizeParams,
  normalizeProducerDirectives,
  normalizeProducerMaxStale,
  normalizeVary,
} from "../../src/utils/normalization.js";
import {
  AllProducerDirectivesArb,
  MaxStaleArb,
  ProducerDirectivesArb,
  VaryArb,
} from "./04_ProducerResult.js";

/**
 * Fast-check arbitrary for generating NormalizedProducerMaxStale objects.
 * Generates objects where thresholds are monotonically increasing.
 */
export const NormalizedProducerMaxStaleArb: fc.Arbitrary<NormalizedProducerMaxStale> =
  MaxStaleArb.map((it) => normalizeProducerMaxStale(it));

/**
 * Fast-check arbitrary for generating NormalizedProducerDirectives objects.
 * Generates producer directives with normalized maxStale.
 */
export const NormalizedProducerDirectivesArb: fc.Arbitrary<NormalizedProducerDirectives> =
  ProducerDirectivesArb.map((it) => normalizeProducerDirectives(it));

export const AllNormalizedProducerDirectivesArb = AllProducerDirectivesArb.map(
  (it) => normalizeProducerDirectives(it),
) satisfies fc.Arbitrary<NormalizedProducerDirectives> as fc.Arbitrary<
  Required<NormalizedProducerDirectives>
>;

/**
 * Fast-check arbitrary for generating NormalizedParams objects.
 * Generates tagged params with no undefined values.
 */
export const NormalizedParamsArb = <Params extends AnyParams = AnyParams>(
  paramsArb: fc.Arbitrary<Params>,
): fc.Arbitrary<NormalizedParams<Params>> =>
  paramsArb.map((params) =>
    normalizeParams<Params>(
      (it) => it as unknown as keyof Params,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_k: any, v: any) => v,
      params as ReadonlyDeep<Partial<Params>>,
    ),
  );

/**
 * Fast-check arbitrary for generating NormalizedVary objects.
 * Generates tagged vary objects with normalized param values.
 */
export const NormalizedVaryArb = <Params extends AnyParams = AnyParams>(
  paramsArb: fc.Arbitrary<Params>,
): fc.Arbitrary<NormalizedVary<Params>> =>
  VaryArb(paramsArb).map((vary) =>
    normalizeVary(
      (it) => it as unknown as keyof Params,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_k: any, v: any) => v,
      vary,
    ),
  );

/**
 * Fast-check arbitrary for generating NormalizedProducerResultResource objects.
 * Generates normalized resource objects with required fields and normalized values.
 */
export const NormalizedProducerResultResourceArb = <
  T = unknown,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  Id extends string = string,
>(
  contentArb: fc.Arbitrary<T>,
  validatorsArb: fc.Arbitrary<Validators>,
  paramsArb: fc.Arbitrary<Params>,
  idArb: fc.Arbitrary<Id>,
): fc.Arbitrary<NormalizedProducerResultResource<T, Validators, Params, Id>> =>
  fc.record({
    id: idArb,
    vary: NormalizedVaryArb(paramsArb),
    content: contentArb,
    initialAge: fc.nat(),
    date: fc.date(),
    directives: NormalizedProducerDirectivesArb,
    validators: validatorsArb,
  });

/**
 * Fast-check arbitrary for generating Entry objects.
 * Entry is a synonym for NormalizedProducerResultResource.
 */
export const EntryArb = NormalizedProducerResultResourceArb;

/**
 * Fast-check arbitrary for generating NormalizedProducerResult objects.
 * Generates normalized result objects with resource and optional supplementalResources.
 */
export const NormalizedProducerResultArb = <
  T = unknown,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  Id extends string = string,
>(
  contentArb: fc.Arbitrary<T>,
  validatorsArb: fc.Arbitrary<Validators>,
  paramsArb: fc.Arbitrary<Params>,
  idArb: fc.Arbitrary<Id>,
): fc.Arbitrary<NormalizedProducerResult<T, Validators, Params, Id>> => {
  const resourceArb = NormalizedProducerResultResourceArb(
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
