import type { ReadonlyDeep } from "type-fest";

import { instantiateTaggedType } from "type-party/runtime/tagged-types.js";
import {
  type NormalizedConsumerMaxStale,
  type NormalizedParams,
  type NormalizedProducerMaxStale,
  type NormalizedProducerResult,
  type NormalizedProducerResultResource,
  type NormalizedVary,
  type NormalizeParamName,
  type NormalizeParamValue,
} from "../types/06_Normalization.js";
import {
  type AnyParams,
  type AnyParamValue,
  type AnyValidators,
  type ConsumerMaxStale,
  type NormalizedProducerDirectives,
  type ProducerDirectives,
  type ProducerMaxStale,
  type ProducerResult,
  type ProducerResultResource,
  type Vary,
} from "../types/index.js";

export function normalizeProducerResult<
  Content,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  normalizeVary: (vary: Vary<Params>) => NormalizedVary<Params>,
  it: ProducerResult<Content, Validators, Params>,
  fallbackProducedAt?: Date,
): NormalizedProducerResult<Content, Validators, Params> {
  const { supplementalResources, ...rest } = it;
  return {
    ...normalizeProducerResultResource(normalizeVary, rest, fallbackProducedAt),
    supplementalResources: supplementalResources?.map((it) =>
      normalizeProducerResultResource(normalizeVary, it, fallbackProducedAt),
    ),
  };
}

export function normalizeProducerResultResource<
  Content,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string = string,
>(
  normalizeVary: (vary: Vary<Params>) => NormalizedVary<Params>,
  resourceResult: ProducerResultResource<Content, Validators, Params, Id>,
  fallbackProducedAt?: Date,
): NormalizedProducerResultResource<Content, Validators, Params, Id> {
  return {
    ...resourceResult,
    initialAge: Math.max(resourceResult.initialAge ?? 0, 0),
    vary: normalizeVary(resourceResult.vary ?? {}),
    directives: normalizeProducerDirectives(resourceResult.directives),
    validators: resourceResult.validators ?? {},
    date: resourceResult.date ?? fallbackProducedAt ?? new Date(),
  };
}

export function normalizeProducerDirectives(directives: ProducerDirectives) {
  const { maxStale, freshUntilAge, ...otherDirectives } = directives;

  return instantiateTaggedType<NormalizedProducerDirectives>({
    ...otherDirectives,
    freshUntilAge: Math.max(freshUntilAge, 0),
    ...(maxStale != null
      ? { maxStale: normalizeProducerMaxStale(maxStale) }
      : {}),
  });
}

export function normalizeParams<Params extends AnyParams>(
  normalizeParamName: NormalizeParamName<Params>,
  normalizeParamValue: NormalizeParamValue<Params>,
  params: ReadonlyDeep<Partial<Params>>,
): NormalizedParams<Params> {
  const entries = Object.entries(params as object) as [
    keyof Params & string,
    Params[keyof Params] | undefined,
  ][];

  const normalizedEntries = entries
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => {
      const finalName = normalizeParamName(k);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const finalVal = normalizeParamValue(finalName, v!);
      return [finalName, finalVal] as const;
    });

  return Object.fromEntries(normalizedEntries) satisfies {
    [k: string]: Params[keyof Params] & AnyParamValue;
  } as unknown as NormalizedParams<Params>;
}

/**
 * This is identical to `normalizeParams`, except that param values in `vary`
 * can be explicitly null, to indicate that the producer relied on the param
 * being missing.
 */
export function normalizeVary<Params extends AnyParams>(
  normalizeParamName: NormalizeParamName<Params>,
  normalizeParamValue: NormalizeParamValue<Params>,
  vary: Vary<Params>,
): NormalizedVary<Params> {
  const entries = Object.entries(vary) satisfies [string, unknown][] as [
    keyof Params & string,
    Params[keyof Params] | undefined,
  ][];

  const normalizedEntries = entries
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => {
      const finalName = normalizeParamName(k);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const finalVal = v === null ? v : normalizeParamValue(finalName, v!);
      return [finalName, finalVal] as const;
    });

  return Object.fromEntries(normalizedEntries) satisfies {
    [k: string]: (Params[keyof Params] & AnyParamValue) | null;
  } as unknown as NormalizedVary<Params>;
}

/**
 * Normalizes a producer's maxStale directive object into its canonical form.
 * Ensures that the staleness thresholds are monotonically increasing:
 * `withoutRevalidation <= whileRevalidate <= ifError`.
 *
 * @param maxStale The producer's maxStale directive object
 * @returns Normalized maxStale with monotonically increasing thresholds
 */
export function normalizeProducerMaxStale(
  maxStale: ReadonlyDeep<ProducerMaxStale>,
) {
  const withoutRevalidation = Math.max(0, maxStale.withoutRevalidation);
  const whileRevalidate = Math.max(
    withoutRevalidation,
    maxStale.whileRevalidate,
  );
  const ifError = Math.max(whileRevalidate, maxStale.ifError);

  return instantiateTaggedType<NormalizedProducerMaxStale>({
    withoutRevalidation,
    whileRevalidate,
    ifError,
  });
}

/**
 * Normalizes a consumer's maxStale directive object into its canonical form.
 * Ensures that the staleness thresholds are monotonically increasing:
 * `withoutRevalidation <= whileRevalidate <= ifError`.
 *
 * @param maxStale The consumer's maxStale directive object
 * @returns Normalized maxStale with monotonically increasing thresholds
 */
export function normalizeConsumerMaxStale(
  maxStale: ReadonlyDeep<ConsumerMaxStale>,
): NormalizedConsumerMaxStale {
  const withoutRevalidation = Math.max(0, maxStale.withoutRevalidation);
  const whileRevalidate = Math.max(
    withoutRevalidation,
    maxStale.whileRevalidate,
  );
  const ifError = Math.max(whileRevalidate, maxStale.ifError);

  return instantiateTaggedType<NormalizedConsumerMaxStale>({
    freshUntilAge:
      maxStale.freshUntilAge != null
        ? Math.max(0, maxStale.freshUntilAge)
        : undefined,
    withoutRevalidation,
    whileRevalidate,
    ifError,
  });
}
