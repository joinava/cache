/**
 * @fileoverview The runtime half of the resource-type registry: constructing
 * registry entries, and classifying an id against them.
 *
 * The registry's *types* -- `ResourceTypes`, `SpecOf` and the rest of the
 * derivations -- live in `types/00_ResourceTypes.ts`, which holds only types, as
 * that directory's contract says. This file holds the values: the two entry
 * constructors (`resourceType`, `idStartsWith`) and classification itself
 * (`registryEntries`, `classifyIdAgainst`), plus the two types that exist purely
 * as their result shapes.
 *
 * ## Classification contract
 *
 * `matches` guards must partition the id space: for every id the cache will
 * ever see (requests, primary results, supplemental results, deletes),
 * **exactly one** registry entry must match. {@link classifyIdAgainst}
 * evaluates every guard; zero matches and two-or-more matches are both contract
 * violations, reported to the caller rather than resolved (fail loud over
 * first-match-wins, so an overlap is caught the first time it occurs rather
 * than silently settled by object-key order). Guards should be cheap (prefix
 * checks preferred); ids must therefore carry their type in-band: **an id must
 * be classifiable by inspection.**
 *
 * A guard that THROWS counts as a non-match, not a veto: guards routinely
 * reject foreign ids by failing to parse them. The throw is kept as the
 * no-match `cause` so a parse failure can't vanish behind "matched nothing".
 *
 * Authoring pattern (registry first, everything derived):
 *
 * ```ts
 * const storiesResourceTypes = {
 *   story: resourceType<Story>()({ matches: idStartsWith("story:") }),
 *   collection: resourceType<Story[]>()({ matches: idStartsWith("collection:") }),
 * } satisfies ResourceTypes;
 *
 * type StoriesSpec = SpecOf<typeof storiesResourceTypes>;
 * // = CacheSpec<`story:${string}`, Story> | CacheSpec<`collection:${string}`, Story[]>
 * ```
 *
 * @module
 */
import type {
  ResourceTypeName,
  ResourceTypes,
  ResourceTypeSpec,
} from "./types/00_ResourceTypes.js";

/** Curried so Content is explicit and Id is inferred from `matches`. */
export function resourceType<Content>(): <Id extends string>(def: {
  matches: (id: string) => id is Id;
}) => ResourceTypeSpec<Id, Content> {
  return (def) => def;
}

/**
 * Classifier helper: builds a guard matching ids whose runtime value starts
 * with a prefix. This is the idiomatic way to write a registry entry's
 * `matches` guard for template-literal-keyed resource types (e.g.,
 * `` `story:${string}` ``).
 */
export function idStartsWith<Prefix extends string>(
  prefix: Prefix,
): (id: string) => id is `${Prefix}${string}` {
  return (id): id is `${Prefix}${string}` => id.startsWith(prefix);
}

/**
 * A registry's enumerable `[name, spec]` pairs; see {@link registryEntries}.
 */
export type ResourceTypesEntries<RT extends ResourceTypes> =
  readonly (readonly [ResourceTypeName<RT>, RT[ResourceTypeName<RT>]])[];

/**
 * The registry's entries, typed. Computed ONCE per holder (a cache, a
 * by-id-type producer) rather than per classified id.
 */
export function registryEntries<RT extends ResourceTypes>(
  resourceTypes: RT,
): ResourceTypesEntries<RT> {
  // SAFETY: Object.entries widens a generic mapped type's values to `unknown`
  // (its keys to `string`); the registry's own enumerable entries are exactly
  // the `[name, spec]` pairs this asserts.
  return Object.entries(resourceTypes) as [
    ResourceTypeName<RT>,
    RT[ResourceTypeName<RT>],
  ][];
}

/**
 * The outcome of classifying an id against a registry (see the classification
 * contract above): exactly one match, or one of the two contract violations.
 *
 * Returned rather than thrown because the registry has no identity to put in an
 * error message. Each holder renders its own: `Cache` throws its cache-named
 * `UnclassifiableIdError`/`AmbiguousResourceTypeError`, while the by-id-type
 * producer helpers -- built from a registry, with no cache to name -- throw an
 * `UnroutableIdError` that the wrappers re-throw with their cache's name.
 */
export type IdClassification<RT extends ResourceTypes> =
  | { readonly matched: "one"; readonly name: ResourceTypeName<RT> }
  | {
      readonly matched: "none";
      /**
       * The failure(s) of any guards that THREW on this id rather than
       * returning false (an `AggregateError` when more than one threw),
       * `undefined` when none did. A throw is a "no" -- guards routinely
       * reject foreign ids by failing to parse them -- but keeping the cause
       * is what stops a parse failure from vanishing behind "matched nothing".
       */
      readonly cause: unknown;
    }
  | {
      readonly matched: "many";
      readonly names: readonly ResourceTypeName<RT>[];
    };

/**
 * Total classification of an id against a registry: evaluates EVERY entry's
 * `matches` guard, so an overlap is detected the first time an id hits it
 * rather than silently resolved by object-key order.
 *
 * Exported because a multi-resource-type producer written by hand -- rather
 * than built with `producerByIdType` -- needs exactly this to route, and needs
 * it without a `Cache` in scope.
 */
export function classifyIdAgainst<RT extends ResourceTypes>(
  entries: ResourceTypesEntries<RT>,
  id: string,
): IdClassification<RT> {
  // One pass, allocating nothing on the (overwhelmingly common) single-match
  // path: `extraMatches` is only built once a SECOND type matches, and
  // `guardErrors` only once a guard throws. Every guard is still evaluated
  // before any decision, which is what makes overlap detection total.
  let firstMatch: ResourceTypeName<RT> | undefined;
  let extraMatches: ResourceTypeName<RT>[] | undefined;
  let guardErrors: unknown[] | undefined;

  for (const [name, spec] of entries) {
    let matched: boolean;
    try {
      matched = spec.matches(id);
    } catch (error) {
      (guardErrors ??= []).push(error);
      continue;
    }
    if (matched) {
      if (firstMatch === undefined) {
        firstMatch = name;
      } else {
        (extraMatches ??= []).push(name);
      }
    }
  }

  if (firstMatch === undefined) {
    return {
      matched: "none",
      cause:
        guardErrors === undefined
          ? undefined
          : guardErrors.length === 1
            ? guardErrors[0]
            : new AggregateError(
                guardErrors,
                "one or more registry guards threw while classifying",
              ),
    };
  }

  return extraMatches === undefined
    ? { matched: "one", name: firstMatch }
    : { matched: "many", names: [firstMatch, ...extraMatches] };
}
