import type { CacheSpec } from "./00_CacheSpec.js";

/**
 * @fileoverview The resource-type registry: the runtime concept of *what kind
 * of resource an id refers to*.
 *
 * A cache admits at most one producer per disjoint id-partition ("resource
 * type"): two producers with overlapping id spaces would be two sources of
 * truth for the same key. "Admits" states which setups are *coherent*, not
 * which ones this package can refuse to build: nothing stops you from wrapping
 * the same cache twice and handing each wrapper a different producer for the
 * same resource type, and no error will be raised if you do -- you have simply
 * built two origins for one key space, and which one a given entry came from
 * is then a race. What *is* mechanically enforced is the weaker, purely
 * id-level half of the constraint: every id the cache sees must match exactly
 * one registry entry (see the classification contract below), so a *partition*
 * violation always fails loud. Keeping one producer per partition is the
 * caller's invariant.
 *
 * Resource types are therefore 1:1 with names and with {@link CacheSpec}
 * branches, so the registry of named, classifiable resource types lives on the
 * `Cache`, and everything else -- producer dispatch, coverage inference,
 * telemetry attribution -- is derived from it.
 *
 * ## Classification contract
 *
 * `matches` guards must partition the id space: for every id the cache will
 * ever see (requests, primary results, supplemental results, deletes),
 * **exactly one** registry entry must match. Classification evaluates every
 * guard; zero matches throws `UnclassifiableIdError`, two or more throws
 * `AmbiguousResourceTypeError` (fail loud over first-match-wins, so an
 * overlap is caught the first time it occurs rather than silently resolved
 * by object-key order). Guards should be cheap (prefix checks preferred);
 * ids must therefore carry their type in-band: **an id must be classifiable
 * by inspection.**
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
 */

declare const contentType: unique symbol;

/**
 * One named kind of resource a cache can hold: a total classifier for its id
 * sub-space, plus a phantom carrier for the content type (no runtime value).
 * Construct with `resourceType<Content>()({ matches })` so `Content` can be
 * supplied explicitly while `Id` is inferred from the guard.
 */
export type ResourceTypeSpec<
  Id extends string = string,
  out Content = unknown,
> = {
  readonly matches: (id: string) => id is Id;
  readonly [contentType]?: Content; // phantom
};

/** Curried so Content is explicit and Id is inferred from `matches`. */
export function resourceType<Content>(): <Id extends string>(def: {
  matches: (id: string) => id is Id;
}) => ResourceTypeSpec<Id, Content> {
  return (def) => def;
}

/** A cache's registry: resource-type name → spec. */
export type ResourceTypes = { readonly [name: string]: ResourceTypeSpec };

export type ResourceTypeName<RT extends ResourceTypes> = keyof RT & string;

// (The `extends string` on the infer is semantically redundant -- the
// position it matches is already string-bounded -- but it lets TS compute a
// `string` constraint for the deferred form `IdOfResourceType<RT[K]>` under a
// generic `RT`, which the derived Cache/wrapper signatures rely on.)
export type IdOfResourceType<T extends ResourceTypeSpec> =
  T extends ResourceTypeSpec<infer Id extends string, unknown> ? Id : never;

export type ContentOfResourceType<T extends ResourceTypeSpec> =
  T extends ResourceTypeSpec<string, infer Content> ? Content : never;

/**
 * THE derivation that removes the parallel-declaration drift: the cache's
 * `Spec` union is computed from the registry rather than declared beside it.
 */
export type SpecOf<RT extends ResourceTypes> = {
  [K in ResourceTypeName<RT>]: CacheSpec<
    IdOfResourceType<RT[K]>,
    ContentOfResourceType<RT[K]>
  >;
}[ResourceTypeName<RT>];

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

/** A registry's enumerable `[name, spec]` pairs; see {@link registryEntries}. */
export type RegistryEntries<RT extends ResourceTypes> = readonly (readonly [
  ResourceTypeName<RT>,
  RT[ResourceTypeName<RT>],
])[];

/**
 * The registry's entries, typed. Computed ONCE per holder (a cache, a
 * by-id-type producer) rather than per classified id.
 */
export function registryEntries<RT extends ResourceTypes>(
  resourceTypes: RT,
): RegistryEntries<RT> {
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
  entries: RegistryEntries<RT>,
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
