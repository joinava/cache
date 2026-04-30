/**
 * @fileoverview The "shape" of values stored in / retrieved from a cache.
 *
 * Throughout this package, the cached values' content type, and the resource
 * `id` type, must be specified together (rather than as independent generic
 * parameters), because the relationship between them carries real information:
 *
 * - The simplest case is when both are independent of one another, e.g., a
 *   cache where every key (`id`) returns a `User`.
 *
 * - But a single cache might also be expected to store/return values _of
 *   different content types depending on the id_. For example, imagine a cache
 *   used to back a "stories" application: it might be expected to handle:
 *
 *     - id `"story:${string}"`, returning a `Story`, and
 *     - id `"collection:${string}"`, returning a `Story[]` (a collection).
 *
 *   This pattern is useful, e.g., when a producer that fetches a collection
 *   wants to additionally cache each individual story (using
 *   {@link ProducerResult.supplementalResources}), so that point lookups for
 *   each story by id can also be served by the same cache.
 *
 * To support both cases, this package is parameterized over a `CacheSpec`,
 * which is just an object that pairs an `id` type with the corresponding
 * `content` type. A simple cache uses a single CacheSpec, while one with
 * heterogeneous values uses a _union_ of CacheSpecs.
 *
 * The package's discriminated-union typings then use the `id` of each spec
 * variant as the discriminant, so that, e.g., when you call `cache.get` with
 * an id like `"story:abc"`, TypeScript can narrow the result's content type
 * to `Story` (and likewise reject storing a `Story[]` under that id).
 */

/**
 * Describes a cache key shape: an `id` type and the `content` type that's
 * stored/returned for that id.
 *
 * In the common case, you pass a single `CacheSpec` as the `Spec` type
 * parameter to {@link Cache} (or instantiate it via the default type parameter
 * `CacheSpec`, which represents an unconstrained cache). To support multiple
 * id-to-content mappings within a single cache, pass a union:
 *
 * ```ts
 * type StoriesCache = CacheSpec<`story:${string}`, Story>;
 * type CollectionsCache = CacheSpec<`collection:${string}`, Story[]>;
 * type MyCacheSpec = StoriesCache | CollectionsCache;
 *
 * const cache = new Cache<MyCacheSpec>(...);
 *
 * // The line below is well-typed: id matches the StoriesCache variant, and
 * // content is required to be a `Story`.
 * await cache.store([{ id: "story:abc", content: aStory, ... }]);
 *
 * // get() narrows the content type by the requested id:
 * const res = await cache.get({ id: "story:abc", ... });
 * // res.usable?.content is `Story | undefined`, NOT `Story | Story[]`.
 * ```
 */
export type CacheSpec<out Id extends string = string, out Content = unknown> = {
  readonly id: Id;
  readonly content: Content;
};

/**
 * Given a (potentially union) `Spec` and a requested id, yields the subset of
 * `Spec` variants whose `id` is compatible with `RequestedId`.
 *
 * `RequestedId` is constrained to extend `Spec["id"]`, which means every
 * constituent of `RequestedId` already lives inside *some* variant's id; the
 * job of `SpecForId` is just to keep, for each constituent, the variant whose
 * id is a supertype of it. Both `Spec` and `RequestedId` are naked type
 * parameters on the LHS of `extends`, so the conditional distributes over
 * each of them, which makes union `RequestedId`s (e.g., a request typed as
 * `Spec["id"]` itself, the full union of variant ids) Just Work: each
 * constituent picks out the matching variant, and the union of all per-
 * constituent results is the answer.
 *
 * If a caller passes an id that doesn't extend `Spec["id"]`, TypeScript
 * reports the constraint violation right at the `SpecForId` instantiation
 * site, instead of silently producing `never` deep inside a downstream type.
 */
export type SpecForId<
  Spec extends CacheSpec,
  RequestedId extends Spec["id"],
> = Spec extends unknown
  ? RequestedId extends Spec["id"]
    ? Spec
    : never
  : never;

/**
 * Convenience helper: the content type associated with a given requested id,
 * given a (potentially union) `Spec`. Equivalent to `SpecForId<...>['content']`.
 */
export type ContentForId<
  Spec extends CacheSpec,
  RequestedId extends Spec["id"],
> = SpecForId<Spec, RequestedId>["content"];
