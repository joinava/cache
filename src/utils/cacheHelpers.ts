import { groupBy, sortBy } from "es-toolkit";
import type { ReadonlyDeep } from "type-fest";
import type {
  AnyParams,
  AnyValidators,
  CacheSpec,
  ConsumerDirectives,
  Entry,
} from "../types/index.js";
import {
  birthDate,
  classify,
  EntryClassification,
  isValidatable,
} from "./normalizedProducerResultResourceHelpers.js";

/**
 * The result of a cache lookup. MatchingSpecs is the subset of CacheSpec
 * variants whose id is compatible with the request's id (`Id`).
 */
export type CacheLookupResult<
  MatchingSpecs extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  usable?: Entry<MatchingSpecs, Validators, Params> | undefined;
  usableWhileRevalidate?: Entry<MatchingSpecs, Validators, Params> | undefined;
  usableIfError?: Entry<MatchingSpecs, Validators, Params> | undefined;
  validatable: Entry<MatchingSpecs, Validators, Params>[];
};

/** Select the newest suitable entry; equal birth dates select the later candidate. */
function bestEntry<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(entries: readonly Entry<Spec, Validators, Params>[]) {
  // "When more than one suitable response is stored, a cache MUST use
  // the most recent response (as determined by the Date header field)."
  // https://tools.ietf.org/html/rfc7234#section-4
  return sortBy(entries, [(entry) => birthDate(entry)]).at(-1);
}

function selectCacheLookup<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(candidates: {
  usable: readonly Entry<Spec, Validators, Params>[];
  usableWhileRevalidate: readonly Entry<Spec, Validators, Params>[];
  usableIfError: readonly Entry<Spec, Validators, Params>[];
  validatable: readonly Entry<Spec, Validators, Params>[];
}): CacheLookupResult<Spec, Validators, Params> {
  // `readOutcomeOf` in diagnostics.ts checks the slots in this same order to
  // name the selected entry. Keep the two orders the same.
  const usable = bestEntry(candidates.usable);
  if (usable !== undefined) return { usable, validatable: [] };
  const validatable = [...candidates.validatable];
  const usableWhileRevalidate = bestEntry(candidates.usableWhileRevalidate);
  if (usableWhileRevalidate !== undefined)
    return { usableWhileRevalidate, validatable };
  const usableIfError = bestEntry(candidates.usableIfError);
  if (usableIfError !== undefined) return { usableIfError, validatable };
  return { usableIfError: undefined, validatable };
}

/** Canonical freshness classification and selection for stored or pending entries. */
export function classifyCacheEntries<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  entries: readonly Entry<Spec, Validators, Params>[],
  directives: ReadonlyDeep<ConsumerDirectives>,
  now: Date,
) {
  const classifiedEntries = groupBy(entries, (entry) =>
    classify(entry, directives, now),
  );
  return {
    result: selectCacheLookup({
      usable: classifiedEntries[EntryClassification.Usable] ?? [],
      usableWhileRevalidate:
        classifiedEntries[EntryClassification.UsableWhileRevalidate] ?? [],
      usableIfError: classifiedEntries[EntryClassification.UsableIfError] ?? [],
      validatable: entries.filter(isValidatable),
    }),
    classifiedEntries,
  };
}

/** Merge independently classified candidates using the same selection as Cache.get. */
export function mergeCacheLookups<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  lookups: readonly CacheLookupResult<Spec, Validators, Params>[],
): CacheLookupResult<Spec, Validators, Params> {
  return selectCacheLookup({
    usable: lookups
      .map((lookup) => lookup.usable)
      .filter((entry) => entry !== undefined),
    usableWhileRevalidate: lookups
      .map((lookup) => lookup.usableWhileRevalidate)
      .filter((entry) => entry !== undefined),
    usableIfError: lookups
      .map((lookup) => lookup.usableIfError)
      .filter((entry) => entry !== undefined),
    validatable: lookups.flatMap((lookup) => lookup.validatable),
  });
}
