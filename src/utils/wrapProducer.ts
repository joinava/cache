import stableStringify from "safe-stable-stringify";
import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import type { CacheLookupResult } from "../Cache.js";
import { publishCacheFetch, publishCacheProduce } from "../diagnostics.js";
import type { SpecForId } from "../types/00_CacheSpec.js";
import type {
  IdOfResourceType,
  ResourceTypeName,
  ResourceTypes,
  SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ConsumerRequest,
  Entry,
  EntryForId,
  Logger,
  RequestPairedProducerResult,
  Vary,
} from "../types/index.js";
import {
  collapsedInvocationTaskCreator,
  type CollapsedInvocation,
} from "./collapsedTaskCreator.js";
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
} from "./utils.js";

/**
 * Thrown by the producer wrappers (not by Cache) when a request's id
 * classifies to a resource type outside the wrapper's inferred coverage.
 * Reachable only via casts or loosely-typed ids -- the wrapped function's
 * request type bans covered-set violations at compile time. Thrown BEFORE
 * any cache read: serving a hit for an uncovered type would smuggle the
 * serve-if-present contract back in through a cast.
 */
export class NoProducerForResourceTypeError extends Error {
  override readonly name = "NoProducerForResourceTypeError";
  readonly cacheName: string;
  readonly resourceType: string;
  readonly coveredResourceTypes: readonly string[];
  readonly id: string;

  constructor(args: {
    cacheName: string;
    resourceType: string;
    coveredResourceTypes: readonly string[];
    id: string;
  }) {
    super(
      `Cache "${args.cacheName}": id ${JSON.stringify(args.id)} classifies to resource type "${args.resourceType}", which is outside this wrapper's coverage (${args.coveredResourceTypes.join(", ")})`,
    );
    this.cacheName = args.cacheName;
    this.resourceType = args.resourceType;
    this.coveredResourceTypes = args.coveredResourceTypes;
    this.id = args.id;
  }
}

export type WrapProducerOptions<Params extends AnyParams> = {
  /**
   * Controls whether the function returned by `wrapProducer`/`wrapBulkProducer`
   * will fall back to calling the produer if its attempt to read from the cache
   * results in an error, or whether it will throw. Normally, falling back to
   * calling the producer is desirable (so that brief unavailability of the
   * cache doesn't effect the application), and this is the default. However,
   * this must be considered carefully: calling through to the producer on every
   * request can _dramatically_ increase the load it's under -- e.g., if the
   * cache hit rate was even 95% (which is very low for many applications), then
   * calling the producer unconditionally will increase the load its under by
   * 20x! I.e., instead of 1 in 20 requests hitting the producer, all 20 will.
   * If the producer is/uses a shared resource, and it doesn't have good load
   * shedding or autoscaling mechanisms, and the requests to it that are going
   * through this cache aren't its most important work, then sending all the
   * requests to the producer could lead to cascading failures and/or prevent it
   * from serving more important requests. In that case, having the function
   * returned by `wrappedProducer` throw might be more desirable.
   */
  onCacheReadFailure?: "throw" | "call-producer";
  /**
   * If multiple, identical requests (i.e., calls to the function returned by
   * `wrapProducer`/`wrapBulkProducer`) are made that overlap in time (i.e., one
   * has started, but not yet finished, at the time another starts), and
   * multiple of these requests would be forwarded to the wrapped producer
   * [because there's no cached value to satisfy them], these requests can be
   * "deduplicated", so that only one request (which'll still be a bulk request
   * in the case of wrapBulkProducer) is made to the underlying producer, and
   * its response is used for all the overlapping requests. This setting
   * controls the maximum number of seconds that are allowed to have elapsed
   * between the current request and the first of the overlapping requests, if
   * this deduplication is to occur. I.e., if a request occurred greater than
   * `collapseOverlappingRequestsTime` seconds after the earliest, identical,
   * overlapping request, it will not be merged with the prior one, and instead
   * a new request will go to the producer
   */
  collapseOverlappingRequestsTime?: number;
  /**
   * A custom logger to use (optional).
   */
  logger?: Logger;
};

/**
 * The producer for one resource type: sees only its own branch's ids.
 *
 * Note: {@link RequestPairedProducerResult} already allows
 * `supplementalResources` from ANY spec variant, so (e.g.) a `site_day`
 * producer can still attach `business_slice` supplementals.
 */
export type ResourceTypeProducer<
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = (
  req: ReadonlyDeep<ConsumerRequest<Params, IdOfResourceType<RT[K]>>>,
  options?: { signal?: AbortSignal },
) => Promise<
  RequestPairedProducerResult<
    SpecOf<RT>,
    Validators,
    Params,
    IdOfResourceType<RT[K]>
  >
>;

/**
 * The producers this wrapper covers: one entry per covered resource type, any
 * non-empty subset of the registry. `Covered` is inferred from the record's
 * keys. Non-coverage is expressed by omission, so a wrapper never has to make
 * claims about types that other wrappers may produce.
 */
export type ProducersFor<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  readonly [K in Covered]: ResourceTypeProducer<RT, K, Validators, Params>;
};

export type { PartialConsumerRequest };

/**
 * The internal, id-erased shape all wrapper plumbing dispatches through.
 * SAFETY: a value is only read out of the producers record after (a) the
 * construction-time keys check, (b) `cache.classify(req.id)` succeeding, and
 * (c) the coverage check confirming the classified type is a record key --
 * so the request's id is in exactly the id sub-space the producer declared.
 */
type LooseProducer<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = (
  req: ReadonlyDeep<ConsumerRequest<Params, SpecOf<RT>["id"]>>,
  options?: { signal?: AbortSignal },
) => Promise<RequestPairedProducerResult<SpecOf<RT>, Validators, Params>>;

/**
 * Fundamentally, this function takes producers that return values (likely
 * without the help of a cache), and returns a function that's a drop-in
 * replacement for them, except that it tries to lookup and reuse prior
 * results from a cache, before calling the underlying user-provided producer.
 *
 * Producers are declared as a record with one entry per covered resource
 * type -- any non-empty subset of the cache's registry. The record's keys are
 * inferred as the wrapper's coverage (`Covered`), which bounds the returned
 * function's request type: it accepts exactly the covered types' ids, and
 * requests for uncovered types are compile errors. A type with no producer in
 * any wrapper is legal and normal: its entries are written as other
 * producers' supplemental resources (or direct `store()` calls) and read via
 * `Cache.get` -- the serve-if-present contract. Partial coverage is also what
 * makes capability-scoped and split wrappers honest: a second `wrapProducer`
 * call can cover a different subset of the same cache, and adding a registry
 * type grants no existing wrapper-holder fetch authority over it.
 *
 * There is no bare-function form: a bare function can't carry a coverage key
 * (it structurally matches the record type as `{}`, inferring
 * `Covered = never` and yielding an uncallable wrapper). Even sole-type
 * caches write `{ <type-name>: producer }`. `wrapProducer` throws at
 * construction time if `producers` has no own enumerable keys.
 *
 * Dispatch: the wrapper calls `cache.classify(req.id)` once per request and
 * invokes that type's producer. The classify result is also what stamps
 * `resourceType` on the `fetch`/`produce` diagnostics messages, so dispatch
 * and telemetry cannot disagree. If the classified type is not in this
 * wrapper's coverage -- reachable only via a cast or loosely-typed id --
 * the wrapper throws {@link NoProducerForResourceTypeError} before reading
 * the cache.
 *
 * ## Producer purity contract
 *
 * A producer passed to any wrapper must be a side-effect-free read of its
 * resource type's origin: every invocation may be collapsed (shared with
 * other concurrent logical callers) and its result stored, so producer calls
 * are never 1:1 with callers. Requests "made for their side effects" should
 * not route through a wrapper at all; a consumer that must reach the origin
 * sends bypass directives (`maxAge: 0`); a producer whose response must not
 * be stored returns `storeFor: 0` directives.
 *
 * ## Bypass requests skip the cache read
 *
 * When the consumer's directives could never be satisfied by cached data
 * (`maxAge: 0`), the wrapper does not call `Cache.get` at all: `maxAge: 0`
 * structurally guarantees producer contact (closing the age-≤0/clock-skew
 * hole where a same-millisecond or future-dated entry has age ≤ 0 and would
 * satisfy `maxAge: 0` from cache), and bypass requests don't pollute the
 * `read` channel. Bypass requests still collapse (only with
 * identical-directive peers -- the collapse key includes directives) and
 * their results are still stored.
 *
 * Note that any supplemental resources returned by a producer will be
 * cached but not returned to the caller.
 *
 * The wrapped function is generic over the specific id of an incoming request
 * so that the result's content type is narrowed to the covered spec variants
 * compatible with that id.
 *
 * ## AbortSignal support
 *
 * The returned function accepts an optional `{ signal }` parameter. The
 * signal is forwarded to `cache.get()`, so the store read can be aborted. If
 * the signal fires before the cache read completes, the function throws
 * without ever contacting the producer. Once the cache read resolves and the
 * producer must be called, the signal is **not** forwarded to the producer --
 * because that call may be sharing the same underlying producer call with
 * other callers who have not aborted. However, the caller's wait for the
 * producer result is **raced** against the signal, so the caller can bail out
 * immediately without waiting for the producer to finish.
 *
 * Critically, bailing out does NOT prevent the producer's result from being
 * stored: the collapsed invocation always fires a (non-awaited)
 * `cache.store()` after the producer resolves, so the work is never wasted.
 * The trade-off is that the producer itself cannot observe the signal to
 * cancel its own in-progress work (e.g., an outgoing HTTP request).
 * Supporting that would require either (a) aborting the shared task only
 * when *all* callers have aborted, which adds significant complexity, or (b)
 * giving up request collapsing for callers that pass a signal, which would
 * defeat its purpose.
 *
 * @param cache - An instance of the cache class. This is where values returned
 *   by the producers (see below) will actually be stored.
 *
 * @param options - See `WrapProducerOptions` for details.
 *
 * @param producers - The functions actually responsible for returning the
 *   results that will be sent to the user and/or stored in the cache, one per
 *   covered resource type. Each acts as the origin or "producer" for its
 *   resource type. Each is passed the request (id and params) along with the
 *   caller's cache directives, which may be needed in case the producer is
 *   itself backed by a cache, and it needs to decide whether to contact its
 *   origin.
 */
export default function wrapProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  producers: ProducersFor<RT, Covered, Validators, Params>,
): <Id extends IdOfResourceType<RT[Covered]>>(
  req: PartialConsumerRequest<Params, Id>,
  options?: { signal?: AbortSignal },
) => Promise<EntryForId<SpecOf<RT>, Validators, Params, Id>> {
  const {
    collapseOverlappingRequestsTime = 3,
    onCacheReadFailure = "call-producer",
    logger = defaultLoggersByComponent["wrap-producer"],
  } = options ?? {};

  // SAFETY: see LooseProducer. The keys are also captured here, before any
  // request runs, so a mutated record can't widen coverage later.
  const looseProducers = producers as unknown as Readonly<
    Record<string, LooseProducer<RT, Validators, Params>>
  >;
  const coveredResourceTypes = Object.keys(looseProducers);

  if (coveredResourceTypes.length === 0) {
    throw new Error(
      "wrapProducer: `producers` must be a record with one entry per covered " +
        "resource type and cannot be empty. (Passing a bare producer function " +
        "is not supported; wrap it as `{ <resource-type-name>: producer }`.)",
    );
  }

  const logTrace = logger.bind(null, "wrap-producer", "trace");
  const logWarning = logger.bind(null, "wrap-producer", "warn");

  // The id is re-narrowed past its ReadonlyDeep wrapper, which cannot
  // *reduce* to the (string) id type while `RT` is an unresolved generic,
  // even though it's the id value itself at runtime.
  type LooseRequest = ReadonlyDeep<
    ConsumerRequest<Params, SpecOf<RT>["id"]>
  > & { readonly id: SpecOf<RT>["id"] };
  type LooseEntry = Entry<
    SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
    Validators,
    Params
  >;

  const callProducerAndLog = async (
    resourceType: string,
    req: LooseRequest,
  ) => {
    logTrace("contacting producer", req);
    // Non-null assertion is safe: dispatch only happens after the coverage
    // check confirms `resourceType` is one of the record's own keys.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const producer = looseProducers[resourceType]!;
    const resp = await producer(req);
    logTrace("got response from producer", resp);
    return resp;
  };

  // Suppose the caller is requesting a resource, and we're already in the
  // process of requesting that resource from the producer (or storing the
  // response), and our pending request had the same id and the same params.
  // This can happen in practice, e.g.: a user signs in; that triggers 10 items
  // to load to show on home screen; but each of those 10 depend on some
  // cache-managed resource, so 10 requests hit the cache for that resource
  // essentially at once; one will start first, and the other 9 will be in the
  // situation of asking the cache to request data for which the same request is
  // already pending.
  //
  // In a situation like the above, what are we to do? Technically, it is
  // _posssible_ for the resource at the origin to change after the 10th request
  // came in to the cache, but before the origin's response to the cache's first
  // outbound request arrived. Therefore, there's an argument that the cache
  // technically should issue a new request to the origin for each of the 10
  // requests described in our hypothetical above.
  //
  // In practice, though, such behavior would risk bombarding the origin and
  // surprising users (who, by virtue of using a cache, might only be expecting
  // one request to the origin) for very little gain, as it's highly unlikely
  // that the resource will change at the origin just in the window of time that
  // the origin's response to an identical request is in transit.
  //
  // In other words, its not usually our job to add layers of caching that the
  // caller didn't ask for [which is what not hitting the origin 10 times would
  // be], but this case is special because the fact that the response hasn't
  // finished saving to the store yet means that, even if the user _does_ want
  // caching here (and they probably do), there's no directive they can use to
  // request it.
  //
  // So, here, we decide to keep track of the in-flight requests to the origin
  // (and their pending saves to the store), and, if there is an identical
  // request pending that was issued less than `collapseOverlappingRequestsTime`
  // seconds ago, we wait for and use the response of the already-pending
  // request, rather than issuing a new one. We make
  // `collapseOverlappingRequestsTime` configurable to placate any user worried
  // about the miniscule risk of inconsistency from this caching.
  //
  // We do this using the collapsedInvocationTaskCreator utility (the
  // metadata-carrying sibling of the public collapsedTaskCreator). That
  // utility does track the pending tasks in memory, so this optimzation will
  // be hindered a bit if the cache frontend is horizontally-scaled across
  // more than one server, but that's fine. We _could_ put this data in the
  // backing store, but that seems like it could create more race conditions?
  // And since batching identical requests at all is an optimization, putting
  // this in the store would probably be overkill.
  //
  // Finally, note is that we only collapse requests that target the same id
  // _with the same parameters_. If we didn't require the params to match, we
  // could get back a response to the first/pending request, only to find out
  // that it includes a `varyKeys` value that makes it unsuitable to serve the
  // second request (that we were trying to avoid making). So we'd have to add
  // fallback logic to handle actually issuing the second request in that case,
  // and that would be too much extra complexity to be worth it. We're in a
  // similar situation with directives, which must also match -- which is also
  // what keeps bypass (`maxAge: 0`) invocations from ever being shared with
  // plain-miss callers.
  //
  // This function never forwards the signal to the producer, because the
  // task may be shared with other callers who haven't aborted. It always
  // fires a (non-awaited) cache.store() after the producer resolves. This is
  // critical for the abort-signal design: since collapsed producer calls
  // don't receive a signal and can't be cancelled by individual callers, we
  // rely on the fact that the producer's work always flows into the cache --
  // ensuring it isn't wasted even when the caller that triggered it has
  // aborted.
  //
  // It also publishes the invocation's `produce` diagnostics message when the
  // producer settles (one message per actual invocation; collapsed callers
  // share one).
  const collapsedCallProducerAndStore = collapsedInvocationTaskCreator(
    async (
      invocation: CollapsedInvocation,
      req: LooseRequest,
      resourceType: string,
    ) => {
      const start = performance.now();
      let requestPairedResult: RequestPairedProducerResult<
        SpecOf<RT>,
        Validators,
        Params
      >;

      const publishProduce = (outcome: "success" | "error") => {
        publishCacheProduce({
          cache: cache.name,
          trigger: invocation.trigger,
          requests: [{ resourceType, resourceId: req.id }],
          collapsedCallerCount: invocation.attachedCallerCount(),
          outcome,
          durationMs: performance.now() - start,
        });
      };

      try {
        requestPairedResult = await callProducerAndLog(resourceType, req);
      } catch (error) {
        publishProduce("error");
        throw error;
      }
      publishProduce("success");

      logTrace(`attempting to store response.`);
      cache
        .store(requestPairedProducerResultToResources(requestPairedResult, req.id))
        .then(() => {
          logTrace(`successfully stored producer's response`);
        })
        .catch((e) => {
          logTrace(`error storing producer's response`, e);
        });

      return requestPairedResult;
    },
    collapseOverlappingRequestsTime * 1000,
    // The key covers the full request (id, params, directives) but not the
    // resourceType arg, which is derived from the id and so adds nothing.
    ([req]) => stableStringify(req),
  );

  const normalizeVaryBound = (vary: Vary<Params>) =>
    normalizeVary(cache.normalizeParamName, cache.normalizeParamValue, vary);

  const wrappedProducer = async function (
    req: PartialConsumerRequest<Params, SpecOf<RT>["id"]>,
    callOptions?: { signal?: AbortSignal },
  ): Promise<LooseEntry> {
    const signal = callOptions?.signal;

    const finalRequest = completeRequest(req) as LooseRequest;
    const { id, params, directives } = finalRequest;

    // Classify once per request: the result dispatches to the producer AND
    // stamps `resourceType` on the fetch/produce messages, so dispatch and
    // telemetry cannot disagree. Classification errors propagate (they're
    // contract violations, not dispositions -- no fetch message).
    const resourceType = cache.classify(id);

    // A classified type outside this wrapper's coverage throws BEFORE any
    // cache read (see NoProducerForResourceTypeError's docs).
    if (!Object.hasOwn(looseProducers, resourceType)) {
      throw new NoProducerForResourceTypeError({
        cacheName: cache.name,
        resourceType,
        coveredResourceTypes,
        id,
      });
    }

    type FetchDisposition =
      | { disposition: "served-from-cache" | "served-stale-while-revalidating" | "served-stale-after-error" }
      | {
          disposition: "served-from-producer" | "producer-error" | "aborted";
          directivesImpliedBypass: boolean;
        };
    const publishFetch = (
      collapsed: boolean,
      disposition: FetchDisposition,
    ) => {
      publishCacheFetch({
        cache: cache.name,
        resourceType,
        resourceId: id,
        collapsed,
        ...disposition,
      });
    };

    const directivesImpliedBypass = isRequestingCacheBypass(directives);

    // Every abort-caused rejection settles the logical request as `aborted`.
    const throwAborted = (collapsed: boolean): never => {
      publishFetch(collapsed, {
        disposition: "aborted",
        directivesImpliedBypass,
      });
      signal?.throwIfAborted();
      // Unreachable: only called after observing `signal.aborted`.
      throw new Error(
        "unreachable: throwAborted called without an aborted signal",
      );
    };

    if (signal?.aborted) {
      throwAborted(false);
    }

    // Awaits an in-flight producer invocation on behalf of this caller:
    // races the caller's wait against its signal, settles the fetch message,
    // and applies the caller's own usableIfError fallback on producer error.
    const settleOnProducer = async (
      attached: { promise: Promise<RequestPairedProducerResult<SpecOf<RT>, Validators, Params>>; rode: boolean },
      usableIfError: LooseEntry | undefined,
    ): Promise<LooseEntry> => {
      let result: LooseEntry;
      try {
        result = await raceWithSignal(
          attached.promise.then((it) =>
            primaryNormalizedResultResourceFromRequestPairedProducerResult<
              SpecOf<RT>,
              Validators,
              Params,
              SpecOf<RT>["id"]
            >(normalizeVaryBound, it, id),
          ),
          signal,
        );
      } catch (error) {
        // If the error was the signal being aborted, propagate that; don't
        // treat it as a producer failure (or fall back to a cached
        // usable-if-error value).
        if (signal?.aborted) {
          throwAborted(attached.rode);
        }

        if (usableIfError) {
          logWarning(
            "error calling producer; falling back to a cached value, as permitted",
            { error, entry: usableIfError },
          );
          publishFetch(attached.rode, {
            disposition: "served-stale-after-error",
          });
          return usableIfError;
        }

        publishFetch(attached.rode, {
          disposition: "producer-error",
          directivesImpliedBypass,
        });
        throw error;
      }

      publishFetch(attached.rode, {
        disposition: "served-from-producer",
        directivesImpliedBypass,
      });
      return result;
    };

    // Bypass requests skip the cache read entirely (see the function docs):
    // no `read` message, guaranteed producer contact, result still stored,
    // still collapsed with identical-directive peers.
    if (directivesImpliedBypass) {
      logTrace(
        `request has cache-bypassing directives; skipping the cache read`,
        { id, params },
      );
      return settleOnProducer(
        collapsedCallProducerAndStore("bypass", finalRequest, resourceType),
        undefined,
      );
    }

    logTrace(`asking the cache for a response`, { id, params });

    const cacheRes = await cache
      .get<SpecOf<RT>["id"]>(finalRequest, callOptions)
      .catch((e: unknown) => {
        // If the errror was the signal being aborted, propagate that (as an
        // `aborted` settlement); don't assume a read failure.
        if (signal?.aborted) {
          throwAborted(false);
        }

        switch (onCacheReadFailure) {
          case "throw":
            // The request never reached a disposition: no fetch message.
            throw e;
          case "call-producer":
            // Pretend the cache returned no results so that we'll fall through to
            // the producer
            return { validatable: [] } satisfies CacheLookupResult<
              SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
              Validators,
              Params
            > as CacheLookupResult<
              SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
              Validators,
              Params
            >;
          default:
            assertUnreachable(onCacheReadFailure);
        }
      });

    const { usable, usableIfError, usableWhileRevalidate } = cacheRes;

    // We have ready-to-go content from the cache, w/ no refresh required.
    if (usable) {
      publishFetch(false, { disposition: "served-from-cache" });
      return usable;
    }

    if (signal?.aborted) {
      throwAborted(false);
    }

    // If we're here, we either don't have usable content at all, or we have
    // content that's only usable in the event of an origin error, or if we make
    // a background request to revalidate it. In any case, we're gonna need to
    // contact the origin for the result.
    //
    // TODO: Support validation requests and invalidation. How to do this is
    // actually tricker than it seems. There are questions like does the
    // validation response create a new Entry [potentially leaving the old entry
    // still there to match on other requests], or should it update an existing
    // one? [Does this mean entries need some notion of an id? Who generates
    // that?] What if the existing entry has since been deleted or aged out of
    // the store? Can the response update more than one entry? Can it update
    // things about it beyond reseting age to zero (e.g., changing the producer
    // directives)? Etc. For some HTTP context, see
    // https://tools.ietf.org/html/rfc7234#section-4.3.4 For invalidation, the
    // idea would be to somehow let request A passing through the producer
    // trigger the invalidation of other cached results [a la a POST
    // invalidating a GET in HTTP], but how? Call a user-provided invalidate
    // function and pass it the just-made request, the promise for its response,
    // and the entry store, and can delete entries made invalid by the request
    // that just passed through?
    //
    // The collapsed call doesn't receive the signal directly (since the
    // underlying task may be shared with other callers who haven't aborted).
    // However, we race the caller's observation of the result against the
    // signal so they can bail out immediately. The underlying producer task
    // keeps running and its result is stored via the collapsed invocation.
    //
    // The trigger labels the invocation's INITIATING cause; if this call
    // instead rides an invocation already in flight, that invocation's
    // original trigger stands.
    const attached = collapsedCallProducerAndStore(
      usableWhileRevalidate ? "revalidation" : "miss",
      finalRequest,
      resourceType,
    );

    if (usableWhileRevalidate) {
      // swallow error rather than crash.
      attached.promise.catch(() => {
        logWarning(
          "error asynchronously requesting refreshed content from producer",
          { id, params, directives },
        );
      });
      publishFetch(false, { disposition: "served-stale-while-revalidating" });
      return usableWhileRevalidate;
    }

    return settleOnProducer(attached, usableIfError);
  };

  // SAFETY: the runtime function is id-erased internally (see LooseProducer),
  // but every path upholds the per-id contract the signature promises: the
  // cache read narrows by id, and the producer's request-paired result is
  // stamped with the request's own id.
  return wrappedProducer as unknown as <Id extends IdOfResourceType<RT[Covered]>>(
    req: PartialConsumerRequest<Params, Id>,
    options?: { signal?: AbortSignal },
  ) => Promise<EntryForId<SpecOf<RT>, Validators, Params, Id>>;
}

export function isRequestingCacheBypass(
  dirs: ReadonlyDeep<ConsumerDirectives>,
) {
  return dirs.maxAge === 0;
}
