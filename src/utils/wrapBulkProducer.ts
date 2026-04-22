import { partition } from "es-toolkit";
import stableStringify from "safe-stable-stringify";
import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";
import type Cache from "../Cache.js";
import type { CacheLookupResult } from "../Cache.js";
import { publishCacheResult } from "../diagnostics.js";
import type {
  AnyParams,
  AnyValidators,
  Entry,
  RequestPairedProducerResult,
  Vary,
} from "../types/index.js";
import collapsedTaskCreator from "./collapsedTaskCreator.js";
import { normalizeVary } from "./normalization.js";
import {
  completeRequest,
  primaryNormalizedResultResourceFromRequestPairedProducerResult,
  requestPairedProducerResultToResources,
  type PartialConsumerRequest,
} from "./requestPairedProducerUtils.js";
import {
  assertUnreachable,
  defaultLoggersByComponent,
  raceWithSignal,
  zip2,
} from "./utils.js";
import {
  isRequestingCacheBypass,
  type WrapProducerOptions,
} from "./wrapProducer.js";

/**
 * A bulk producer function that takes an array of consumer requests and returns
 * a promise for an array of request-paired producer results.
 */
export type BulkProducer<
  Content,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  Id extends string = string,
  ErrorType extends Error = Error,
> = (
  reqs: readonly PartialConsumerRequest<Params, Id>[],
  options?: { signal?: AbortSignal },
) => Promise<
  (RequestPairedProducerResult<Content, Validators, Params, Id> | ErrorType)[]
>;

/**
 * Fundamentally, this function takes a function that returns values for
 * multiple requests (likely without the help of a cache), and returns another
 * function that's a drop-in replacement for the first, except that it tries to
 * lookup and reuse prior results from a cache using `Cache.getMany`, before
 * calling the underlying user-provided function only for those requests that
 * could not be resolved from the cache (or that need revalidation later).
 *
 * Note that this can call the underlying producer up to three times: once for
 * requests that had no immediately-usable cached values, once for requests that
 * are always uncacheable, and once (in the background) for requests that had
 * usableWhileRevalidate results and need to be revalidated in the background.
 *
 * Note that any supplemental resources returned by the producer will be
 * cached but not returned to the caller.
 *
 * ## AbortSignal support
 *
 * The returned function accepts an optional `{ signal }` parameter. Signal
 * propagation follows the same model as {@link wrapProducer}:
 *
 * - **Uncacheable requests**: the signal is forwarded directly to the producer.
 *
 * - **Cacheable requests**: the signal is forwarded to `cache.getMany()`. If
 *   the signal fires before the cache read completes, the function throws
 *   without contacting the producer. Once the cache read resolves and the
 *   producer must be called for cache misses, the signal is **not** forwarded
 *   to the producer (because those calls go through the
 *   `collapsedTaskCreator`), but the caller's wait is raced against the signal
 *   so they can bail out early. The producer's result is always stored. See the
 *   `wrapProducer` JSDoc for the full rationale.
 *
 * - **Background refresh** (stale-while-revalidate): these calls are
 *   fire-and-forget and never receive a signal, since the caller has already
 *   been given a (stale) result.
 *
 * @param cache - An instance of the cache class. This is where values returned
 *   by the producer (see below) will actually be stored.
 *
 * @param options - See `WrapProducerOptions` for details.
 *
 * @param producer - The function that's actually responsible for returning the
 *   results that will be sent to the user and/or stored in the cache. It acts
 *   as the origin or "producer" for the cache. This function is passed an array
 *   of requests (id and params) along with the caller's cache directives, which
 *   may be needed in case this producer function is itself backed by a cache,
 *   and it needs to decide whether to contact its origin.
 */
export function wrapBulkProducer<
  Id extends string,
  Content,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<Content, Validators, Params, Id>>,
  options: WrapProducerOptions<Params> | undefined,
  producer: BulkProducer<Content, Validators, Params, Id, ErrorType>,
) {
  const {
    cacheName,
    isCacheable = () => true,
    collapseOverlappingRequestsTime = 3,
    onCacheReadFailure = "call-producer",
    logger = defaultLoggersByComponent["wrap-producer"],
  } = options ?? {};

  const logTrace = logger.bind(null, "wrap-producer", "trace");
  const logWarning = logger.bind(null, "wrap-producer", "warn");

  const callProducerAndLog = async (
    reqs: readonly PartialConsumerRequest<Params, Id>[],
    opts?: { signal?: AbortSignal },
  ) => {
    logTrace("contacting bulk producer", { reqs });
    const responses = opts ? await producer(reqs, opts) : await producer(reqs);
    logTrace("got responses from bulk producer", { responses });
    return responses;
  };

  // This function never forwards the signal to the producer (so it'll run to
  // completion) and then always fires a (non-awaited) cache.store() after the
  // producer succeeds. This is critical for the abort-signal design: since
  // collapsed producer calls can't be cancelled by individual callers [as that
  // could abort other callers too], we let them finish but then make sure that
  // the producer's result always flows into the cache, so its work isn't wasted
  // even when the caller that triggered it has aborted. See the
  // wrapBulkProducer JSDoc for details.
  const collapsedCallProducerAndStore = collapsedTaskCreator(
    async (reqs: readonly PartialConsumerRequest<Params, Id>[]) => {
      const requestPairedProducerResults = await callProducerAndLog(reqs);

      // Extract all resources to store (main resources + supplemental resources),
      // but NOT requests that failed.
      const resourcesToStore = zip2(requestPairedProducerResults, reqs).flatMap(
        ([result, req]) =>
          result instanceof Error
            ? []
            : requestPairedProducerResultToResources(
                result,
                req.id satisfies ReadonlyDeep<Id> as Id,
              ),
      );

      logTrace(`attempting to store resources from bulk producer response`, {
        resourcesToStore,
      });

      if (resourcesToStore.length === 0) {
        logTrace(`no resources to store; skipping store`);
      } else {
        cache
          .store(resourcesToStore)
          .then(() => {
            logTrace(`successfully stored bulk producer's response`);
          })
          .catch((e) => {
            logTrace(`error storing bulk producer's response`, e);
          });
      }

      return requestPairedProducerResults;
    },
    collapseOverlappingRequestsTime * 1000,
    stableStringify,
  );

  const normalizeVaryBound = (vary: Vary<Params>) =>
    normalizeVary(cache.normalizeParamName, cache.normalizeParamValue, vary);

  const wrappedBulkProducer = async function (
    reqs: readonly PartialConsumerRequest<Params, Id>[],
    options?: { signal?: AbortSignal },
  ): Promise<(Entry<Content, Validators, Params, Id> | ErrorType)[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    if (reqs.length === 0) {
      return [];
    }

    // Normalize requests by replacing undefined params + directives w/ empty objects
    const finalRequests = reqs.map((req) => completeRequest(req));

    // Make a map from finalRequests to their original indices, so that we can
    // reorder things at the end without tracking indices all along the way.
    // Slightly inefficient, but easier to follow.
    const finalRequestsToOriginalIndices = new Map(
      finalRequests.map((it, i) => [it, i] as const),
    );

    // Separate cacheable and non-cacheable requests
    const [cacheableRequests, nonCacheableRequests] = partition(
      finalRequests,
      (req) => isCacheable(req.id, req.params),
    );

    logTrace(`separated cacheable and non-cacheable requests`, {
      totalRequests: reqs.length,
      cacheableRequests,
      nonCacheableRequests,
    });

    // Send non-cacheable requests to producer while going to the cache in
    // parallel for the others. NB: we don't await the nonCacheableResultsPromise
    // or do Promise.all() here because we don't want it to block the code below.
    // Pass signal directly to uncacheable producer calls (not shared/collapsed).
    const [uncacheableProducerResultsPromise, cacheResultsPromise] = [
      nonCacheableRequests.length > 0
        ? callProducerAndLog(nonCacheableRequests, options)
        : Promise.resolve([]),
      cacheableRequests.length > 0
        ? cache.getMany(cacheableRequests, options).catch((e: unknown) => {
            if (e instanceof DOMException && e.name === "AbortError") {
              throw e;
            }

            switch (onCacheReadFailure) {
              case "throw":
                throw e;
              case "call-producer":
                // Pretend the cache returned no results so that we'll fall through to
                // the producer
                return cacheableRequests.map(() => ({ validatable: [] }));
              default:
                assertUnreachable(onCacheReadFailure);
            }
          })
        : Promise.resolve([]),
    ];

    // Handle cacheable requests.
    const cacheResults = await cacheResultsPromise;

    signal?.throwIfAborted();

    const requestsWithCacheResults = zip2(cacheableRequests, cacheResults);
    const requestsWithUsableResults = requestsWithCacheResults
      .filter(([_, res]) => res.usable)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .map(([req, res]) => [req, res.usable!] as const);

    // Skip metrics when caching is effectively disabled for this request and
    // reporting misses would be misleading.
    // Report cache hits
    for (const [req] of requestsWithUsableResults) {
      publishCacheResult({ cacheName, outcome: "hit", cacheKey: req.id });
    }

    const requestsWithUsableWhileRevalidateResults = requestsWithCacheResults
      .filter(([_, res]) => res.usableWhileRevalidate)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .map(([req, res]) => [req, res.usableWhileRevalidate!] as const);

    // Report stale-while-revalidate results
    for (const [req] of requestsWithUsableWhileRevalidateResults) {
      publishCacheResult({
        cacheName,
        outcome: "stale_while_revalidate",
        cacheKey: req.id,
      });
    }

    // Call the producer immediately for requests that can't be satisfied
    // directly from cache.
    const hasImmediatelyReturnableResult = (
      res: CacheLookupResult<Content, Validators, Params, Id>,
    ) => Boolean(res.usable || res.usableWhileRevalidate);

    const requestsNeedingProducerNow = requestsWithCacheResults.filter(
      ([_, res]) => !hasImmediatelyReturnableResult(res),
    );

    // Report cache misses
    for (const [req] of requestsNeedingProducerNow) {
      publishCacheResult({
        cacheName,
        outcome: isRequestingCacheBypass(req.directives ?? {})
          ? "bypass"
          : "miss",
        cacheKey: req.id,
      });
    }

    // Report uncacheable requests
    for (const req of nonCacheableRequests) {
      publishCacheResult({
        cacheName,
        outcome: "uncacheable",
        cacheKey: req.id,
      });
    }

    // NB: This _should_ never reject; instead, it should return errors just for
    // those that it couldn't resolve (which might be every request). If it does
    // throw, there's no way for us to handle it according to the contract of
    // this function except by rethrowing (as we don't know that the thrown
    // value will be an `ErrorType`)
    //
    // The collapsed call doesn't receive the signal directly (the underlying
    // task may be shared with other callers), but we race the caller's wait
    // against the signal so they can bail out. The producer keeps running and
    // stores its result via callProducerAndStore.
    const producerResults =
      requestsNeedingProducerNow.length > 0
        ? await raceWithSignal(
            collapsedCallProducerAndStore(
              requestsNeedingProducerNow.map(([req]) => req),
            ),
            signal,
          )
        : [];

    // Start background refresh but don't await on it;
    // swallow any errors rather than crashing. No signal here since this is
    // fire-and-forget background work.
    if (requestsWithUsableWhileRevalidateResults.length > 0) {
      collapsedCallProducerAndStore(
        requestsWithUsableWhileRevalidateResults.map(([req]) => req),
      ).catch(() => {
        logWarning(
          "error asynchronously requesting refreshed content from bulk producer",
        );
      });
    }

    const requestsWithResults = [
      ...requestsWithUsableResults,
      ...requestsWithUsableWhileRevalidateResults,
      ...producerResults.map((producerResult, i) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const [req, cacheResult] = requestsNeedingProducerNow[i]!;

        return producerResult instanceof Error
          ? ([req, cacheResult.usableIfError ?? producerResult] as const)
          : ([
              req,
              primaryNormalizedResultResourceFromRequestPairedProducerResult(
                normalizeVaryBound,
                producerResult,
                req.id satisfies ReadonlyDeep<Id> as Id,
              ),
            ] as const);
      }),
      ...zip2(
        nonCacheableRequests,
        await uncacheableProducerResultsPromise.then((res) =>
          res.map((producerResult, i) =>
            producerResult instanceof Error
              ? producerResult
              : primaryNormalizedResultResourceFromRequestPairedProducerResult(
                  normalizeVaryBound,
                  producerResult,
                  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                  nonCacheableRequests[i]!.id satisfies ReadonlyDeep<Id> as Id,
                ),
          ),
        ),
      ),
    ];

    const results: (ErrorType | Entry<Content, Validators, Params, Id>)[] =
      new Array(finalRequests.length);

    for (const [req, res] of requestsWithResults) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      results[finalRequestsToOriginalIndices.get(req)!] = res;
    }

    return results;
  };

  // Expose the cache on the returned function
  // (for convenience, e.g., in closing it).
  wrappedBulkProducer.cache = cache;

  return wrappedBulkProducer;
}
