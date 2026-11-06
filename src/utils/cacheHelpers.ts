import { groupBy, sortBy } from "es-toolkit";
import type { ReadonlyDeep } from "type-fest";
import type { CacheLookupResult } from "../Cache.js";
import type { CacheReadOutcome } from "../diagnostics.js";
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
}): {
  result: CacheLookupResult<Spec, Validators, Params>;
  outcome: CacheReadOutcome;
} {
  const usable = bestEntry(candidates.usable);
  if (usable !== undefined)
    return {
      result: { usable, validatable: [] },
      outcome: { found: "usable", vary: usable.vary },
    };
  const validatable = [...candidates.validatable];
  const usableWhileRevalidate = bestEntry(candidates.usableWhileRevalidate);
  if (usableWhileRevalidate !== undefined)
    return {
      result: { usableWhileRevalidate, validatable },
      outcome: {
        found: "usable-while-revalidate",
        vary: usableWhileRevalidate.vary,
      },
    };
  const usableIfError = bestEntry(candidates.usableIfError);
  if (usableIfError !== undefined)
    return {
      result: { usableIfError, validatable },
      outcome: { found: "usable-if-error", vary: usableIfError.vary },
    };
  return {
    result: { usableIfError: undefined, validatable },
    outcome: { found: "none" },
  };
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
    ...selectCacheLookup({
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
  }).result;
}
