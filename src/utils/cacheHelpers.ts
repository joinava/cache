import { groupBy, sortBy } from "es-toolkit";
import type { ReadonlyDeep } from "type-fest";
import type {
  AnyParams,
  AnyValidators,
  CacheSpec,
  ConsumerDirectives,
  Entry,
  Vary,
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

/**
 * What a *completed* lookup contributes to its read message: the `found`
 * value paired with the variant it identifies, if any.
 *
 * Exported because `Cache`'s lookup evaluation returns one and spreads it into
 * the message -- the same reason `CacheFetchDisposition` is exported for
 * the wrappers. Pairing the two fields in one value is what keeps "which
 * `found` values carry a `vary`" stated once instead of re-derived at each of
 * the four publish sites.
 */
export type CacheReadOutcome =
  | {
      found: "usable" | "usable-while-revalidate" | "usable-if-error";
      /**
       * The SELECTED entry's (normalized) vary -- identifying the
       * `(resourceId, vary)` variant this lookup matched, which is the same
       * key `store-entry` reports for the write that put the value there (see
       * `CacheStoreEntryMessage.vary` in diagnostics.ts). Reads and stores can therefore
       * be joined per variant rather than per id, which is the only way to
       * get correct per-variant counts out of a varying producer.
       *
       * When more than one entry qualified, this is the one the lookup
       * actually chose (the freshest), matching the entry handed back in the
       * lookup result.
       */
      vary: Vary<AnyParams>;
    }
  | {
      found: "none";
      /**
       * No entry was selected, so there is no variant to identify. Absent
       * rather than `{}`, which identifies a real variant (see the diagnostics
       * module overview).
       */
      vary?: undefined;
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
