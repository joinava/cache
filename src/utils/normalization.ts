import type { ReadonlyDeep } from "type-fest";
import { instantiateTaggedType } from "type-party/runtime/tagged-types.js";
import { publishDroppedDirective } from "../diagnostics.js";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import {
  type Entry,
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
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  normalizeVary: (vary: Vary<Params>) => NormalizedVary<Params>,
  it: ProducerResult<Spec, Validators, Params>,
  fallbackProducedAt?: Date,
): NormalizedProducerResult<Spec, Validators, Params> {
  const { supplementalResources } = it;
  // The conditional/distributive `ProducerResult` and `Entry` types make TS
  // unable to verify the equivalence of the spread'd object with the target
  // type, even though the runtime shape is identical. We assert here.
  const primary = normalizeProducerResultResource(
    normalizeVary,
    it satisfies ProducerResultResource<Spec, Validators, Params>,
    fallbackProducedAt,
  );
  return {
    ...primary,
    supplementalResources: supplementalResources?.map((resource) =>
      normalizeProducerResultResource(
        normalizeVary,
        resource,
        fallbackProducedAt,
      ),
    ),
  };
}

export function normalizeProducerResultResource<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  normalizeVary: (vary: Vary<Params>) => NormalizedVary<Params>,
  resourceResult: ProducerResultResource<Spec, Validators, Params>,
  fallbackProducedAt?: Date,
): NormalizedProducerResultResource<Spec, Validators, Params> {
  // Treat the resource as a single (id, content) pair (it always is at runtime,
  // even when `Spec` is a union and the type is conditional). The resulting
  // object's id/content correlation is preserved because we don't synthesize
  // values; we just round-trip them.

  // `date` and `initialAge` jointly determine the entry's birth date
  // (birthDate = date - initialAge*1000), which downstream code relies on for
  // freshness math and, contractually, for Store.store()'s in-call dedup
  // (newest birth date wins). An Invalid Date or NaN initialAge would poison
  // that math with NaN, so -- like NaN freshUntilAge below -- reject it here
  // at the boundary; there's no sensible recovery. Infinite and negative
  // initialAge stay allowed (long-standing behavior): +Infinity means "born
  // infinitely long ago" (never fresh, deterministic in dedup), and negatives
  // are clamped to 0 below.
  const date = resourceResult.date ?? fallbackProducedAt ?? new Date();
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError("Invalid producer result: date is an Invalid Date");
  }
  const givenInitialAge = resourceResult.initialAge ?? 0;
  if (Number.isNaN(givenInitialAge)) {
    throw new TypeError(
      "Invalid producer result: initialAge cannot be NaN",
    );
  }

  return {
    id: resourceResult.id as Spec["id"],
    content: resourceResult.content as Spec["content"],
    initialAge: Math.max(givenInitialAge, 0),
    vary: normalizeVary(resourceResult.vary ?? {}),
    directives: normalizeProducerDirectives(resourceResult.directives),
    validators: resourceResult.validators ?? {},
    date,
  } as Entry<Spec, Validators, Params>;
}

export function normalizeProducerDirectives(directives: ProducerDirectives) {
  const { maxStale, freshUntilAge, storeFor } = directives;

  // `freshUntilAge` is required, so a NaN value here is a programmer error on
  // the producer side that we can't sensibly recover from -- there's no safe
  // default freshness lifetime to fall back to. Throw so the bug surfaces.
  if (Number.isNaN(freshUntilAge)) {
    throw new TypeError(
      "Invalid producer directive: freshUntilAge cannot be NaN",
    );
  }

  // `storeFor` is optional: drop it on NaN (with a diagnostic) so the cache
  // falls back to its usual "store for as long as the entry could be useful"
  // behavior. `Math.max(0, storeFor)` clamps `-Infinity` (and other negatives)
  // to 0.
  let normalizedStoreFor: number | undefined;
  if (storeFor !== undefined) {
    if (Number.isNaN(storeFor)) {
      publishDroppedDirective({ directive: "storeFor", reason: "contains-NaN" });
    } else {
      normalizedStoreFor = Math.max(0, storeFor);
    }
  }

  // `maxStale` is optional. If any of its three required thresholds is NaN,
  // the whole object is meaningless, so drop it entirely (with a diagnostic).
  // The cache already has well-defined behavior for "producer didn't specify
  // maxStale": the consumer's policy controls.
  let normalizedMaxStale: NormalizedProducerMaxStale | undefined;
  if (maxStale != null) {
    if (
      Number.isNaN(maxStale.withoutRevalidation) ||
      Number.isNaN(maxStale.whileRevalidate) ||
      Number.isNaN(maxStale.ifError)
    ) {
      publishDroppedDirective({ directive: "maxStale", reason: "contains-NaN" });
    } else {
      normalizedMaxStale = normalizeProducerMaxStale(maxStale);
    }
  }

  return instantiateTaggedType<NormalizedProducerDirectives>({
    freshUntilAge: Math.max(freshUntilAge, 0),
    ...(normalizedStoreFor !== undefined
      ? { storeFor: normalizedStoreFor }
      : {}),
    ...(normalizedMaxStale != null ? { maxStale: normalizedMaxStale } : {}),
  });
}

/**
 * Re-hydrates a {@link NormalizedProducerDirectives} object after a JSON
 * serialization roundtrip. `JSON.stringify` (and `safe-stable-stringify`)
 * converts `Infinity` to `null`, which would otherwise turn a producer's
 * `freshUntilAge: Infinity` (i.e. "never expires") into a `null` value that
 * arithmetic comparisons treat as `0`, making the entry immediately stale.
 *
 * Store implementations that serialize entries as JSON should call this
 * helper on the parsed `directives` object when reading entries back, so
 * that `Infinity` values for `freshUntilAge`, `storeFor`, and each field of
 * `maxStale` are restored correctly.
 *
 * The input type is intentionally permissive so this can be applied to the
 * raw output of `JSON.parse`, where the affected numeric fields will be
 * `null` rather than the `number` claimed by the type system.
 */
export function restoreInfinityInDirectives(
  directives: Readonly<{
    freshUntilAge: number | null;
    storeFor?: number | null;
    maxStale?: {
      withoutRevalidation: number | null;
      whileRevalidate: number | null;
      ifError: number | null;
    };
  }>,
): NormalizedProducerDirectives {
  const restore = (n: number | null) => (n === null ? Infinity : n);
  const { maxStale, freshUntilAge, storeFor } = directives;

  return instantiateTaggedType<NormalizedProducerDirectives>({
    freshUntilAge: restore(freshUntilAge),
    ...(storeFor === undefined ? {} : { storeFor: restore(storeFor) }),
    ...(maxStale != null
      ? {
          maxStale: instantiateTaggedType<NormalizedProducerMaxStale>({
            withoutRevalidation: restore(maxStale.withoutRevalidation),
            whileRevalidate: restore(maxStale.whileRevalidate),
            ifError: restore(maxStale.ifError),
          }),
        }
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
