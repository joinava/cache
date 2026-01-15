import type { AnyParams } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";

/**
 * ProducerResult represents the shape of messages returned by a service
 * for saving in the cache. It includes content (the actual cached value)
 * along with various pieces of metadata that control caching behavior.
 *
 * T: the type of the content
 * U: the type of its potential validators
 * V: the type of request parameters (see HTTP cache model docs).
 */
export type ProducerResult<
  T,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string = string,
> = ProducerResultResource<T, Validators, Params, Id> & {
  supplementalResources?: ProducerResultResource<T, Validators, Params, Id>[];
};

/**
 * A ProducerResultResource is the producer's representation, at some point in
 * time, of a single, cacheable resource. It includes the id of that resource,
 * its content, and the various caching related metadata/directives.
 *
 * ProducerResultResources, once normalized
 * {@see {@link NormalizedProducerResultResource}}, are the key data that
 * returned from the Cache and read/written to the Store.
 */
export type ProducerResultResource<
  T,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string = string,
> = {
  id: Id;
  vary?: Vary<Params>;

  content: T;

  // Age of content at the moment its sent by this producer -- in seconds!
  // Will be non-zero when this producer is itself a cache [since it's been
  // holding the content for some period of time], or it could be non-zero to
  // reflect that some time passed while it was being retreived [network latency].
  // Defaults to 0 if not provided.
  initialAge?: number;

  // The moment that this ProducerResultResource was created. Per comment above,
  // this may be different from when the resource's current state was fetched
  // from the origin, if initialAge is non-zero.
  date?: Date;

  // producer cache control directives.
  directives: ProducerDirectives;

  // validation infos. Will be interpreted as an empty object if not provided.
  validators?: Partial<Validators>;
};

// The vary object holds a set of param (name, value) pairs that the producer
// used to create the result. These form a secondary cache key for the resource,
// with `id`. A null value indicates that the parameter must be missing to
// generate this result; a missing key (or, because TS can't easily prevent it,
// an undefined value, indicates that the result doesn't vary on the parameter.
export type Vary<Params extends AnyParams> = {
  [K in keyof Params]?: Exclude<Params[K], undefined> | null;
};

/**
 * The producer's staleness policy. This object allows the producer to express
 * its tolerance for serving stale content under various revalidation scenarios.
 *
 * Unlike the consumer's maxStale, this does NOT include a `freshUntilAge` field
 * because the producer must already specify freshness via the separate
 * `freshUntilAge` directive.
 *
 * Field descriptions:
 *
 * - `withoutRevalidation`: The maximum staleness (in seconds past the freshness
 *   lifetime) of a response the producer allows to be served without the cache
 *   needing to (even attempt to) revalidate it.
 *
 * - `whileRevalidate`: The maximum staleness (in seconds) of a response the
 *   producer allows to be served if the cache attempts to revalidate it
 *   asynchronously in the background. Must be >= `withoutRevalidation`.
 *
 * - `ifError`: The maximum staleness (in seconds) of a response the producer
 *   allows to be served if the cache is unable to reach the origin to
 *   revalidate. Must be >= `whileRevalidate`.
 *
 * (If it's not the case that withoutRevalidation <= whileRevalidate <= ifError,
 * each number in violation of the inequality will be treated as though its
 * value were the same as the number before it.)
 *
 * Examples:
 *
 * - `{ withoutRevalidation: 0, whileRevalidate: 0, ifError: 0 }` creates
 *   semantics similar to HTTP's `must-revalidate` directive.
 *
 * - `{ withoutRevalidation: 0, whileRevalidate: 60, ifError: 300 }` is similar
 *   to HTTP's `stale-while-revalidate=60, stale-if-error=300` (but limits the
 *   consumer's ability to request stale requests without revalidation).
 *
 * - Combining `{ withoutRevalidation: 0, whileRevalidate: 0, ifError: 0 }` with
 *   `freshUntilAge: 0` creates semantics very similar to HTTP's `no-cache`
 *   producer directive.
 */
export type ProducerMaxStale = {
  withoutRevalidation: number;
  whileRevalidate: number;
  ifError: number;
};

/**
 * Supported producer directives. More to be added.
 *
 * - freshUntilAge: The number of seconds for which the produced value is fresh.
 *   By default, stale (i.e., not fresh) responses will not be returned by the
 *   cache, but consumer or producer use of the `maxStale` directive can
 *   override this. This is equivalent to the producer `max-age` directive in
 *   HTTP; it's just renamed to reflect the fact that (like in HTTP) it has a
 *   fundamentally different meaning than consumer `maxAge`.
 *
 * - maxStale: The producer's staleness policy. See {@link ProducerMaxStale}. If
 *   the producer omits the `maxStale` directive, it isn't putting any
 *   constraints on the cache's ability to serve stale responses, so the
 *   consumer's willingness to accept stale values will control. Therefore, a
 *   producer omitting `maxStale` is very similar to it providing a `maxStale`
 *   with every threshold set to `Infinity` (but it's not quite identical, b/c,
 *   if a consumer doesn't indicate anything about its willingness to accept
 *   stale responses, the cache behaves slightly differently depending on
 *   whether the producer provided an explicit `maxStale`).
 *
 * - storeFor: the maximum number of seconds _after the content was generated_
 *   that it may be stored in a cache. Note: this is slightly different from
 *   saying "the maximum amount of time that a cache may store the result it
 *   just received". Specifically, if there's a chain of caches, these two ideas
 *   come apart, because cache x may have just received the content, even though
 *   it was produced from an upstream origin a while back. Therefore, from the
 *   perspective of a given cache in the chain, the amount of time it can store
 *   the result is `Math.max(0, directives.storeFor - initialAge)`. [For the
 *   definition of initialAge, {@see ProducerResult}.]
 *
 * Note: when resolving directives, the cache will behave to satisfy all
 * directives. So, for example, if the producer indicates that a response is
 * storable for A seconds, whereas the consumer would allow it to be stored for
 * B seconds, the cache may store it for `Math.min(A, B)` seconds.
 */
export type ProducerDirectives = {
  freshUntilAge: number; // seconds
  maxStale?: ProducerMaxStale;
  storeFor?: number;
};
