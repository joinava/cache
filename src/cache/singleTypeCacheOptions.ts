import type { InvariantOf } from "type-fest";
import { resourceType } from "../resourceTypeClassification.js";
import type {
  AnyParams,
  AnyValidators,
  CacheSpec,
  ResourceTypes,
  ResourceTypeSpec,
  Store,
} from "../types/index.js";
import type { CacheOptions } from "./CacheOptions.js";

/**
 * The one-entry registry {@link singleTypeCacheOptions} builds. Keyed by an
 * index signature, because the name is a runtime value the caller asked not to
 * think about. The types carrying the cache's *data* contract stay precise --
 * `SpecOf` of this registry is exactly `CacheSpec<Id, Content>`.
 *
 * What the index signature costs is everything keyed by the type's NAME, since
 * `ResourceTypeName` of this registry is `string`: `classify()` returns `string`
 * rather than the literal, and a {@link producerByIdType} record's keys are no
 * longer checked against the registry (see `singleTypeCacheOptions`' docs).
 * Write the registry out by hand to get both back.
 */
export type SingleTypeRegistry<Id extends string, Content> = {
  readonly [name: string]: ResourceTypeSpec<Id, Content>;
};

/**
 * What {@link singleTypeCacheOptions} accepts. The three RT-dependent keys are
 * omitted from {@link CacheOptions} and re-declared here, so everything else is
 * derived and cannot drift as `CacheOptions` grows.
 *
 * `Id` is inferred from `validateId` and from nothing else. The store
 * deliberately does not mention `Id`: its own spec is captured in
 * `StoreSupportedTypes` and merely *checked* for coverage, exactly as for a
 * hand-written registry (see {@link CacheOptions}' `store`). That buys two
 * things at once -- a general-purpose store can back a sole-type cache, and the
 * store stops competing with the guard as an inference site for `Id`. While it
 * did compete, an untyped `new MemoryStore()` won and silently collapsed `Id`
 * back to `string`, discarding the guard's narrowing.
 *
 * The intersected carrier is what keeps a narrower `Id` honest. `validateId`
 * has to be optional in the base object to serve as an inference site at all;
 * the carrier makes it REQUIRED as soon as `Id` is narrower than `string`. An
 * explicit type argument is fixed before the carrier resolves, so naming a
 * narrow `Id` without a guard is rejected -- and an *inferred* narrow `Id`
 * could only have come from a guard in the first place. So a narrower id space
 * always has a runtime check behind it. (The tuple brackets make this a
 * whole-set comparison rather than a distributive, member-by-member one.)
 *
 * Note that coverage is NOT checked here: it cannot be. The check has to
 * compare `CacheSpec<Id, Content>` against the store's spec, and a conditional
 * spelled over `Id` is resolved while checking the `store` property -- before
 * `validateId` has contributed its inference, since a type predicate's
 * narrowing lands in a later pass. It therefore resolves against `Id`'s default
 * of `string` and rejects every store typed more narrowly than that. (Probed:
 * a store typed for exactly the guard's id space failed its own coverage
 * check.) Coverage is left to `new Cache`, where `Id` is already fixed.
 */
type SingleTypeCacheOptionsInput<
  Id extends string,
  Validators extends AnyValidators,
  Params extends AnyParams,
  StoreSupportedTypes extends CacheSpec,
> = Omit<
  CacheOptions<ResourceTypes, Validators, Params>,
  "store" | "name" | "resourceTypes"
> & {
  /**
   * REQUIRED. Only has to support *at least* this cache's sole resource type;
   * see {@link CacheOptions}' `store`.
   */
  store: Store<StoreSupportedTypes, Validators, InvariantOf<Params>>;
  /**
   * REQUIRED. Names this cache instance (and, by default, its sole resource
   * type) in every diagnostics message.
   */
  name: string;
  /** Defaults to the cache's own `name`. */
  resourceTypeName?: string;
  /**
   * A REAL runtime guard for the sole resource type's id space; the only thing
   * that can narrow `Id` below `string`, and required once it is narrower.
   */
  validateId?: (id: string) => id is Id;
} & ([string] extends [Id]
    ? unknown
    : { validateId: (id: string) => id is Id });

/**
 * The one way to call {@link singleTypeCacheOptions}.
 *
 * The returned `store` is re-declared without {@link CacheOptions}' coverage
 * guard on purpose. Leaving the guard on would have this function's own
 * (asserted) return type claim the guard's phantom property, so `new Cache`
 * would see the requirement already satisfied and wave an under-covering store
 * through. Handing back the plain store type instead leaves the real one for
 * the constructor to check.
 */
export type SingleTypeCacheOptionsBuilder<Content> = <
  Id extends string = string,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  StoreSupportedTypes extends CacheSpec = CacheSpec<Id, Content>,
>(
  options: SingleTypeCacheOptionsInput<
    Id,
    Validators,
    Params,
    StoreSupportedTypes
  >,
) => Omit<
  CacheOptions<
    SingleTypeRegistry<Id, Content>,
    Validators,
    Params,
    StoreSupportedTypes
  >,
  "store"
> & { store: Store<StoreSupportedTypes, Validators, InvariantOf<Params>> };

/**
 * Builds {@link CacheOptions} for a cache with exactly ONE resource type, so the
 * caller does not have to invent a name for that type or nest a one-entry
 * registry literal:
 *
 * ```ts
 * const cache = new Cache(singleTypeCacheOptions<Json>()({ store, name: "xyz-cache" }));
 * ```
 *
 * The resource type is named after the cache unless `resourceTypeName` says
 * otherwise. That name reaches diagnostics only -- it is never part of a store
 * key -- so naming it after the cache cannot invalidate entries, and it keeps
 * `resourceType` meaningful across caches instead of collapsing every
 * sole-type cache into one shared literal. Spread the result to add anything
 * else {@link CacheOptions} accepts.
 *
 * Curried for the same reason {@link resourceType} is: `Content` cannot be
 * inferred from anything, so it must be given explicitly, and TS has no partial
 * type-argument inference.
 *
 * As with a hand-written registry, the store only has to support *at least*
 * this cache's resource type, so a general-purpose store can back a sole-type
 * cache. Coverage is checked by `new Cache`; see {@link CacheOptions}' `store`.
 *
 * ## Narrowing the id space
 *
 * By default the sole type accepts every id, so the id space is `string`. Pass
 * `validateId` to narrow it. It is a REAL runtime guard, not a type assertion,
 * so a nonconforming id throws `UnclassifiableIdError` before the store is
 * touched:
 *
 * ```ts
 * const cache = new Cache(
 *   singleTypeCacheOptions<Schema>()({
 *     store: new MemoryStore(),
 *     name: "tickets",
 *     validateId: idStartsWith("ticket:"),
 *   }),
 * );
 * // cache.get({ id: "ticket:1", ... })  // ok
 * // cache.get({ id: "nope", ... })      // compile error
 * ```
 *
 * The guard is *required* as soon as `Id` is narrower than `string` (see
 * {@link SingleTypeCacheOptionsBuilder}), so a narrower id space always has a
 * runtime check behind it.
 *
 * ## What writing the registry by hand still buys
 *
 * This sugar's registry is keyed by an index signature, because the type's name
 * is a runtime value the caller asked not to think about. Two consequences,
 * both of which the hand-written form avoids:
 *
 * - `classify()` returns `string` rather than the type's literal name.
 * - `ResourceTypeName` of that registry is `string` too, so the compile-time
 *   check that a {@link producerByIdType} record's keys are real registry names
 *   cannot fire. A misspelled key is accepted at compile time and then throws
 *   `NoProducerForResourceTypeError` on every request. On a hand-written
 *   registry the same typo is a compile error.
 *
 * So prefer the hand-written one-entry registry when you use `producerByIdType`
 * or want the literal name; the sugar is for the common case of one resource
 * type and one bare producer function:
 *
 * ```ts
 * new Cache({
 *   store,
 *   name: "tickets",
 *   resourceTypes: {
 *     tickets: resourceType<Schema>()({ matches: idStartsWith("ticket:") }),
 *   },
 * });
 * ```
 */
export function singleTypeCacheOptions<
  Content,
>(): SingleTypeCacheOptionsBuilder<Content> {
  const build = ({
    resourceTypeName,
    validateId,
    ...rest
  }: {
    name: string;
    resourceTypeName?: string;
    validateId?: (id: string) => boolean;
  }) => ({
    ...rest,
    resourceTypes: {
      [resourceTypeName ?? rest.name]:
        validateId === undefined
          ? resourceType<Content>()({
              matches: (id): id is string => typeof id === "string",
            })
          : resourceType<Content>()({
              // SAFETY: re-stating the caller's own guard. It is erased to a
              // plain boolean predicate here because this implementation cannot
              // name the `Id` its call signatures infer; the narrowing restored
              // by the cast below is the one the caller declared.
              matches: validateId as (id: string) => id is string,
            }),
    },
  });

  // SAFETY: the registry's key is a runtime value, so TS types the object
  // literal by its computed-key signature and cannot see that the entry's guard
  // is the caller's `Id` guard. The runtime object is precisely one entry, under
  // the only key the returned options are ever read with, holding the guard the
  // caller supplied (or an accept-everything guard when they supplied none, in
  // which case `Id` really is `string`).
  return build as unknown as SingleTypeCacheOptionsBuilder<Content>;
}
