import type { AnyParams } from "./01_Params.js";

/**
 * A consumer's request. Not surprising.
 *
 * For convenience, some code may make `params` and `directives` optional, and
 * handle filling in these values itself.
 *
 * We use partial for the params because, even if the Params type indicates that
 * some parameter is required, the semantics of params explicitly preclude
 * required params. See {@link AnyParams}.
 */
export type ConsumerRequest<
  Params extends AnyParams,
  Id extends string = string,
> = {
  id: Id;
  params: Partial<Params>;
  directives: ConsumerDirectives;
};

/**
 * The consumer's staleness policy. This object allows the consumer to express:
 *
 * 1. Their own definition of when content becomes "stale" (via `freshUntilAge`)
 * 2. Their tolerance for stale content under various revalidation scenarios
 *
 * The three threshold fields (`withoutRevalidation`, `whileRevalidate`,
 * `ifError`) are all required. To defer to the producer's staleness policy
 * entirely, omit `maxStale` from `ConsumerDirectives`.
 *
 * Field descriptions:
 *
 * - `freshUntilAge` (optional): The consumer's override of the producer's
 *   freshness determination. If provided, the effective freshness lifetime is
 *   `Math.min(consumerFreshUntilAge, producerFreshUntilAge)`. This allows
 *   consumers to consider content "stale" earlier than the producer specified.
 *   If omitted, the producer's `freshUntilAge` is used.
 *
 * - `withoutRevalidation`: The maximum staleness (in seconds past the effective
 *   freshness lifetime) of a response the consumer will accept without the
 *   cache needing to (even attempt to) revalidate it.
 *
 * - `whileRevalidate` (required): The maximum staleness (in seconds) of a
 *   response the consumer will accept if the cache attempts to revalidate it
 *   asynchronously in the background. Must be >= `withoutRevalidation`.
 *
 * - `ifError` (required): The maximum staleness (in seconds) of a response the
 *   consumer will accept if the cache is unable to reach the origin to
 *   revalidate. Must be >= `whileRevalidate`.
 *
 * (If it's not the case that withoutRevalidation <= whileRevalidate <= ifError,
 * each number in violation of the inequality will be treated as though its
 * value were the same as the number before it.)
 *
 * Example: To get "client-driven SWR" where content is served immediately if
 * <300s old, served-while-revalidating if 300-360s old, and served-if-error if
 * 360-600s old:
 *
 * ```ts
 * maxStale: {
 *   freshUntilAge: 300,        // "I consider it stale after 300s"
 *   withoutRevalidation: 0,    // "Don't serve stale without revalidation"
 *   whileRevalidate: 60,       // "Serve up to 60s stale if revalidating"
 *   ifError: 300,              // "Serve up to 300s stale if origin unreachable"
 * }
 * ```
 */
export type ConsumerMaxStale = {
  freshUntilAge?: number | undefined;
  withoutRevalidation: number;
  whileRevalidate: number;
  ifError: number;
};

/**
 * Supported consumer directives. All are optional.
 *
 * - maxAge: The maximum age (in seconds) of a cached response that the consumer
 *   will accept. If provided, the cache will _never_ return a value older than
 *   this. If omitted, there's no age limit on responses; however, the defaults
 *   for `maxStale` (see below), mean that the default behavior is for stored
 *   responses to be returned from the cache if and only if they're fresh
 *   (according to the producer).
 *
 *   Note that this `maxAge` is different from `maxStale.freshUntilAge`: maxAge
 *   is a hard cutoff regardless of freshness, while freshUntilAge affects when
 *   content is considered "stale" for the purpose of applying the staleness
 *   policy.
 *
 * - maxStale: The consumer's staleness policy. See {@link ConsumerMaxStale} for
 *   detailed documentation. If this directive is missing entirely, the cache,
 *   when evaluating whether a given stored response satisfies the consumer's
 *   request, acts in one of two ways:
 *
 *     - if the _producer_ did not provide `maxStale` on its response, the cache
 *       as if the consumer indicated that it will only accept fresh requests
 *       (according to the producer's definition of fresh). I.e., it uses a
 *       default of `{ withoutRevalidation: 0, whileRevalidate: 0, ifError: 0 }`
 *       for `ConsumerDirectives.maxStale`.
 *
 *     - if the producer _did_ provide `maxStale` on its response, the cache
 *       still defaults to assuming that the consumer only wants fresh
 *       responses, but it applies the producer's preferences around
 *       stale-while-revalidate and stale-if-error. I.e., it defaults the
 *       `ConsumerDirectives.maxStale` to:
 *
 *       {
 *         withoutRevalidation: 0,
 *         whileRevalidate: producerDirs.whileRevalidate,
 *         ifError: producerDirs.ifError
 *       }
 *
 *   These (slightly-complex) defaults were chosen to match HTTP's behavior when
 *   a request `max-stale` directive is missing).
 *
 * - TODO: bring back consumer storeFor and apply it when sending resources to
 *   the store. Its meaning would be: "the maximum number of seconds that the
 *   cache may store data from the consumer's request and the resulting
 *   response. If not provided, the cache may store information indefinitely."
 *   The reason to have this is to match the consumer no-store directive in
 *   HTTP, as a privacy "nice-to-have".
 *
 * Note: when resolving directives, the cache will only return responses that
 * satisfy all directives. So, for example, if a stale response is within the
 * consumer's `maxStale` thresholds, but older than its provided `maxAge`, that
 * response is not considered suitable. Likewise, all producer directives must
 * also be satisfied.
 */
export type ConsumerDirectives = {
  maxAge?: number;
  maxStale?: ConsumerMaxStale;
};
