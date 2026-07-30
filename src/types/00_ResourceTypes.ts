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
