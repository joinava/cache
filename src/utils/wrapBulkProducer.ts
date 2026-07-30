import { partition } from "es-toolkit";
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
  ConsumerRequest,
  Entry,
  EntryForId,
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
  zip2,
} from "./utils.js";
import {
  coveredTypes,
  isRequestingCacheBypass,
  NoProducerForResourceTypeError,
  type WrapProducerOptions,
} from "./wrapProducer.js";

/**
 * A bulk producer for ONE resource type: a {@link bulkProducerByIdType}
 * sub-producer. That helper splits the wrapper's batch by classified resource
 * type and calls each sub-producer once with its own type's slice, so a
 * sub-producer's batch never mixes types. (The wrapper itself takes a single
 * {@link CoveringBulkProducer}, which by default sees the WHOLE mixed batch --
 * that is the point of the single-function form.) Results are request-paired;
 * Error elements mark per-request failures.
 *
 * The result type is a flat array of (RequestPairedProducerResult |
 * ErrorType): each element is a discriminated union over the type's spec, so
 * each (id, content) pair must internally agree, but the type system does
 * not require the i'th result element to align with the i'th request's id at
 * the call site (which would require gnarly mapped-tuple typing). When
 * `wrapBulkProducer` returns its results to the caller, they ARE narrowed
 * per-request via the wrapper's own generic.
 */
export type BulkResourceTypeProducer<
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = (
  reqs: readonly ReadonlyDeep<
    ConsumerRequest<Params, IdOfResourceType<RT[K]>>
  >[],
) => Promise<
  (
    | RequestPairedProducerResult<
        SpecOf<RT>,
        Validators,
        Params,
        IdOfResourceType<RT[K]>
      >
    | ErrorType
  )[]
>;

/**
 * {@link bulkProducerByIdType}'s argument: one entry per covered resource
 * type, any non-empty subset of the registry. `Covered` is inferred from the
 * record's keys, exactly as in `producerByIdType`.
 */
export type BulkProducersFor<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = {
  readonly [K in Covered]: BulkResourceTypeProducer<
    RT,
    K,
    Validators,
    Params,
    ErrorType
  >;
};

/**
 * The bulk counterpart of `wrapProducer`'s `CoveringProducer` (see it for why
 * the covered-set property carries a runtime value, and why it is optional for
 * whole-registry coverage but REQUIRED when `Covered` is a strict subset): a
 * bulk producer function that may additionally declare which resource types it
 * covers. A plain function omits the property and covers the whole registry, so
 * it sees the caller's FULL mixed batch in one call and can optimize across
 * resource types (one upstream call spanning several types, cross-type dedup, a
 * join).
 */
export type CoveringBulkProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
> = ((
  reqs: readonly ReadonlyDeep<
    ConsumerRequest<Params, IdOfResourceType<RT[Covered]>>
  >[],
) => Promise<
  (
    | RequestPairedProducerResult<
        SpecOf<RT>,
        Validators,
        Params,
        IdOfResourceType<RT[Covered]>
      >
    | ErrorType
  )[]
>) &
  ([ResourceTypeName<RT>] extends [Covered]
    ? { readonly [coveredTypes]?: readonly Covered[] }
    : { readonly [coveredTypes]: readonly Covered[] });

/** The internal, id-erased dispatch shape; see `LooseProducer` in wrapProducer.ts. */
type LooseBulkProducer<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = (
  reqs: readonly ReadonlyDeep<ConsumerRequest<Params, SpecOf<RT>["id"]>>[],
) => Promise<
  (RequestPairedProducerResult<SpecOf<RT>, Validators, Params> | ErrorType)[]
>;

/**
 * Fundamentally, this function takes bulk producers that return values for
 * multiple requests (likely without the help of a cache), and returns a
 * function that's a drop-in replacement for them, except that it tries to
 * lookup and reuse prior results from a cache using `Cache.getMany`, before
 * calling the underlying user-provided producers only for those requests that
 * could not be resolved from the cache (or that need revalidation later).
 *
 * Like {@link wrapProducer} (see its docs for the shared contracts: the single
 * producer function and how `Covered` is inferred, the producer purity
 * contract, and bypass requests skipping the cache read), exactly ONE producer
 * function is passed.
 *
 * That is what restores this wrapper's defining bulk capability: a bare
 * function covers the whole registry and is handed the **full** set of
 * requests it must produce, mixed resource types and all, in ONE call -- so it
 * can optimize across them (a single upstream call covering several types,
 * cross-type dedup, a join). Per-type dispatch is available as opt-in sugar via
 * {@link bulkProducerByIdType}, which splits the batch by classified type,
 * calls each sub-producer once with its own slice, and reassembles the results
 * positionally.
 *
 * A single `reqs` array passed to the wrapped function may freely mix covered
 * types; ids of uncovered types are compile errors per element (and, via casts,
 * throw {@link NoProducerForResourceTypeError} before any cache read -- only
 * when coverage was actually narrowed; see that error's docs).
 *
 * Note that this can call the underlying producer up to twice per wrapped
 * call: once for requests that had no immediately-usable cached values
 * (including bypass requests, which skip the read), and once (in the
 * background) for requests that had usableWhileRevalidate results and need to
 * be revalidated in the background.
 *
 * Note that any supplemental resources returned by a producer will be
 * cached but not returned to the caller.
 *
 * The wrapped function is generic over the specific ids of incoming requests
 * so that each output slot's content type is narrowed to the covered spec
 * variants compatible with the corresponding input request's id.
 *
 * ## AbortSignal support
 *
 * The returned function accepts an optional `{ signal }` parameter. Signal
 * propagation follows the same model as {@link wrapProducer}:
 *
 * - The signal is forwarded to `cache.getMany()`. If the signal fires before
 *   the cache read completes, the function throws without contacting any
 *   producer for the non-bypass requests.
 *
 * - Once a producer must be called (for misses and bypass requests), no signal
 *   reaches the producer (because those calls may be shared with other callers
 *   via request collapsing) -- bulk producers take no `options` parameter at
 *   all, for the reason given in the `wrapProducer` JSDoc. The caller's wait is
 *   raced against the signal so they can bail out early, and the producers'
 *   results are always stored.
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
 * @param producer - The function actually responsible for returning the
 *   results that will be sent to the user and/or stored in the cache. It is
 *   passed an array of requests (id and params) along with the callers' cache
 *   directives, and must return one result (or `ErrorType`) per request, in the
 *   same order. Pass a bare function to cover the whole registry and receive
 *   the full mixed batch, or {@link bulkProducerByIdType}'s result to dispatch
 *   per resource type.
 */
export function wrapBulkProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT> = ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  producer: CoveringBulkProducer<RT, Covered, Validators, Params, ErrorType>,
): <
  const Reqs extends readonly PartialConsumerRequest<
    Params,
    IdOfResourceType<RT[Covered]>
  >[],
>(
  reqs: Reqs,
  options?: { signal?: AbortSignal },
) => Promise<{
  -readonly [K in keyof Reqs]:
    | EntryForId<SpecOf<RT>, Validators, Params, Extract<Reqs[K]["id"], SpecOf<RT>["id"]>>
    | ErrorType;
}> {
  const {
    collapseOverlappingRequestsTime = 3,
    onCacheReadFailure = "call-producer",
    logger = defaultLoggersByComponent["wrap-producer"],
  } = options ?? {};

  // SAFETY: see LooseProducer in wrapProducer.ts.
  const looseProducer = producer as unknown as LooseBulkProducer<
    RT,
    Validators,
    Params,
    ErrorType
  >;

  // The declared covered set is snapshotted here, before any request runs, so
  // a post-wrap mutation of the caller's array can't widen (or otherwise
  // change) coverage later. `undefined` means the producer declared nothing,
  // which (see CoveringBulkProducer) means it covers the whole registry: there
  // is no covered set to enumerate and nothing to check.
  const declaredCoveredTypes = producer[coveredTypes];
  const coveredResourceTypes: readonly string[] | undefined =
    declaredCoveredTypes === undefined ? undefined : [...declaredCoveredTypes];

  const logTrace = logger.bind(null, "wrap-producer", "trace");
  const logWarning = logger.bind(null, "wrap-producer", "warn");

  // The id is re-narrowed past its ReadonlyDeep wrapper, which cannot
  // *reduce* to the (string) id type while `RT` is an unresolved generic,
  // even though it's the id value itself at runtime.
  type LooseRequest = ReadonlyDeep<
    ConsumerRequest<Params, SpecOf<RT>["id"]>
  > & { readonly id: SpecOf<RT>["id"] };
  type LooseResult = RequestPairedProducerResult<SpecOf<RT>, Validators, Params>;
  type LooseEntry = Entry<
    SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
    Validators,
    Params
  >;

  const callProducerAndLog = async (
    reqs: readonly LooseRequest[],
  ): Promise<(LooseResult | ErrorType)[]> => {
    logTrace("contacting bulk producer", { reqs });
    const responses = await looseProducer(reqs);
    logTrace("got responses from bulk producer", { responses });
    return responses;
  };

  // One collapsed invocation per request batch. No signal reaches the producer
  // -- the invocation may be shared with callers who haven't aborted, so there
  // is no one caller's signal to hand it, which is why `CoveringBulkProducer`
  // takes no options parameter at all. The task always fires a (non-awaited)
  // cache.store() with the non-error results after the producer succeeds (so
  // its work isn't wasted even when every caller that triggered it has
  // aborted), and publishes the invocation's `produce` diagnostics message when
  // the producer settles. See wrapProducer's implementation for the full
  // collapsing rationale.
  //
  // COLLAPSE GRANULARITY. The key is the batch's full requests (ids, params,
  // directives) -- the parallel `resourceTypes` argument is derived from the
  // ids and is deliberately excluded. With one producer that means ONE
  // invocation per trigger group, where before there was one per (trigger
  // group x resource type). Bypass, miss, and revalidation groups still stay
  // separate -- not because `trigger` is in the key (it is not), but because
  // their request arrays differ, bypass carrying `maxAge: 0` directives.
  //
  // The cost is real: two callers whose `story` sub-batches are identical used
  // to share that invocation even when their `collection` parts differed, and
  // now one key spans the whole mixed batch, so they share nothing. This is
  // 1.6.0's behaviour, and it is recoverable later INSIDE
  // `bulkProducerByIdType` via the already-exported `collapsedTaskCreator` --
  // deliberately not done here, since that would relocate the complexity one
  // layer down rather than remove it. (`wrapProducer` is unaffected: it
  // handles one request, so there is no merge and its keying is unchanged.)
  const collapsedCallProducerAndStore = collapsedInvocationTaskCreator(
    async (
      invocation: CollapsedInvocation,
      reqs: readonly LooseRequest[],
      // Index-aligned with `reqs`; carried through so the produce message can
      // attribute each element to its own type without re-classifying (the
      // batch may now span resource types).
      resourceTypes: readonly string[],
    ) => {
      const start = performance.now();

      const publishProduce = (outcome: "success" | "error") => {
        publishCacheProduce({
          cache: cache.name,
          trigger: invocation.trigger,
          requests: zip2(resourceTypes, reqs).map(([resourceType, req]) => ({
            resourceType,
            resourceId: req.id,
          })),
          collapsedCallerCount: invocation.attachedCallerCount(),
          outcome,
          durationMs: performance.now() - start,
        });
      };

      let requestPairedProducerResults: (LooseResult | ErrorType)[];
      try {
        requestPairedProducerResults = await callProducerAndLog(reqs);
        // A producer that returns fewer results than requests (or an
        // undefined element) violated its contract, and the positional
        // (result, request) pairing is no longer trustworthy -- a dropped
        // middle element would silently pair later results with the wrong
        // requests. So nothing is stored and the WHOLE invocation fails:
        // this throw rejects it, settling every waiting element's fetch as
        // `producer-error` via the group's rejection handler.
        //
        // The count reports FILLED slots rather than the array's `length`,
        // which is not the same thing: `bulkProducerByIdType` reassembles into
        // a preallocated array (deliberately leaving an under-returning
        // sub-producer's slots as holes for this check to catch), so its
        // `length` always equals `reqs.length` even when results are missing.
        const answered = reqs.filter(
          (_, i) => requestPairedProducerResults[i] !== undefined,
        ).length;
        if (answered !== reqs.length) {
          throw new Error(
            `wrapBulkProducer: producer returned results for only ${String(answered)} of ${String(reqs.length)} requests (every request must receive a result or an Error element)`,
          );
        }
      } catch (error) {
        publishProduce("error");
        throw error;
      }
      publishProduce("success");

      // Extract all resources to store (main resources + supplemental resources),
      // but NOT requests that failed.
      const resourcesToStore = zip2(requestPairedProducerResults, reqs).flatMap(
        ([result, req]) =>
          result instanceof Error
            ? []
            : requestPairedProducerResultToResources<
                SpecOf<RT>,
                Validators,
                Params
              >(result, req.id),
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
    // See the COLLAPSE GRANULARITY note above.
    ([reqs]) => stableStringify(reqs),
  );

  const normalizeVaryBound = (vary: Vary<Params>) =>
    normalizeVary(cache.normalizeParamName, cache.normalizeParamValue, vary);

  const wrappedBulkProducer = async function (
    reqs: readonly PartialConsumerRequest<Params, SpecOf<RT>["id"]>[],
    callOptions?: { signal?: AbortSignal },
  ): Promise<(LooseEntry | ErrorType)[]> {
    const signal = callOptions?.signal;

    if (reqs.length === 0) {
      return [];
    }

    // Normalize requests by replacing undefined params + directives w/ empty
    // objects, classify every id, and check coverage -- all before any cache
    // read or producer contact. Classification/coverage errors propagate
    // (contract violations, not dispositions -- no fetch messages).
    type RequestItem = {
      req: LooseRequest;
      resourceType: string;
      directivesImpliedBypass: boolean;
      /**
       * Set to true when this element's fetch message has been published, so
       * each logical request settles on the fetch channel exactly once (its
       * answer and an abort can race).
       */
      settled: boolean;
    };
    const items: RequestItem[] = reqs.map((req) => {
      const finalRequest = completeRequest(req) as LooseRequest;
      return {
        req: finalRequest,
        resourceType: cache.classify(finalRequest.id),
        directivesImpliedBypass: isRequestingCacheBypass(
          finalRequest.directives,
        ),
        settled: false,
      };
    });

    // Skipped entirely for a bare producer, which declares no covered set
    // because it covers the whole registry (see wrapProducer's docs).
    if (coveredResourceTypes !== undefined) {
      const uncovered = items.find(
        (item) => !coveredResourceTypes.includes(item.resourceType),
      );
      if (uncovered) {
        throw new NoProducerForResourceTypeError({
          cacheName: cache.name,
          resourceType: uncovered.resourceType,
          coveredResourceTypes,
          id: uncovered.req.id,
        });
      }
    }

    type FetchDisposition =
      | {
          disposition:
            | "served-from-cache"
            | "served-stale-while-revalidating"
            | "served-stale-after-error";
        }
      | {
          disposition: "served-from-producer" | "producer-error" | "aborted";
          directivesImpliedBypass: boolean;
        };
    const settleFetch = (
      item: RequestItem,
      collapsed: boolean,
      disposition: FetchDisposition,
    ) => {
      if (item.settled) {
        return;
      }
      item.settled = true;
      publishCacheFetch({
        cache: cache.name,
        resourceType: item.resourceType,
        resourceId: item.req.id,
        collapsed,
        ...disposition,
      });
    };

    // Every abort-caused rejection settles the still-unsettled elements as
    // `aborted` (elements whose answers arrived before the signal fired keep
    // their real dispositions).
    const throwAborted = (
      waiting: readonly { item: RequestItem; rode: boolean }[],
    ): never => {
      waiting.forEach(({ item, rode }) => {
        settleFetch(item, rode, {
          disposition: "aborted",
          directivesImpliedBypass: item.directivesImpliedBypass,
        });
      });
      signal?.throwIfAborted();
      // Unreachable: only called after observing `signal.aborted`.
      throw new Error(
        "unreachable: throwAborted called without an aborted signal",
      );
    };

    if (signal?.aborted) {
      throwAborted(items.map((item) => ({ item, rode: false })));
    }

    // Make a map from request items to their original indices, so that we can
    // reorder things at the end without tracking indices all along the way.
    // Slightly inefficient, but easier to follow.
    const itemsToOriginalIndices = new Map(items.map((it, i) => [it, i]));

    // Separate bypass requests (which skip the cache read entirely; see
    // wrapProducer's docs) from the rest.
    const [bypassItems, readItems] = partition(
      items,
      (item) => item.directivesImpliedBypass,
    );

    logTrace(`separated bypass and cache-eligible requests`, {
      totalRequests: reqs.length,
      bypassItems,
      readItems,
    });

    type AttachedGroup = {
      items: readonly RequestItem[];
      rode: boolean;
      handled: Promise<(LooseEntry | ErrorType)[]>;
    };

    // Attaches a set of request items to a collapsed producer invocation:
    // `handled` settles each element's fetch message when the invocation
    // settles (unless an abort settled it first) and yields the per-item
    // results. With a single producer there is at most ONE invocation per call
    // to this helper -- the resource-type partition is gone (see the COLLAPSE
    // GRANULARITY note above); it still returns a list so its callers can
    // concatenate their trigger classes, and so an empty set attaches nothing.
    const attachGroups = (
      groupItems: readonly RequestItem[],
      trigger: CollapsedInvocation["trigger"],
      usableIfErrorByItem?: ReadonlyMap<RequestItem, LooseEntry>,
    ): AttachedGroup[] => {
      if (groupItems.length === 0) {
        return [];
      }

      const attached = collapsedCallProducerAndStore(
        trigger,
        groupItems.map((item) => item.req),
        groupItems.map((item) => item.resourceType),
      );

      const handled: Promise<(LooseEntry | ErrorType)[]> =
        attached.promise.then(
          (producerResults) =>
            groupItems.map((item, i) => {
              // Non-null assertion is safe: the invocation task validates
              // result completeness before resolving (an under-return
              // rejects the whole invocation, handled below), and riders
              // share the initiator's exact request batch (it's the
              // collapse key).
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              const producerResult = producerResults[i]!;

              if (producerResult instanceof Error) {
                const fallback = usableIfErrorByItem?.get(item);
                if (fallback) {
                  logWarning(
                    "error calling producer; falling back to a cached value, as permitted",
                    { error: producerResult, entry: fallback },
                  );
                  settleFetch(item, attached.rode, {
                    disposition: "served-stale-after-error",
                  });
                  return fallback;
                }
                settleFetch(item, attached.rode, {
                  disposition: "producer-error",
                  directivesImpliedBypass: item.directivesImpliedBypass,
                });
                return producerResult;
              }

              settleFetch(item, attached.rode, {
                disposition: "served-from-producer",
                directivesImpliedBypass: item.directivesImpliedBypass,
              });
              return primaryNormalizedResultResourceFromRequestPairedProducerResult<
                SpecOf<RT>,
                Validators,
                Params,
                SpecOf<RT>["id"]
              >(normalizeVaryBound, producerResult, item.req.id);
            }),
          (error: unknown) => {
            // The bulk producer itself rejected (it's supposed to return
            // Error elements for per-request failures instead). There's no
            // way to handle this per the wrapped function's contract except
            // rethrowing (we don't know the thrown value is an `ErrorType`).
            groupItems.forEach((item) => {
              settleFetch(item, attached.rode, {
                disposition: "producer-error",
                directivesImpliedBypass: item.directivesImpliedBypass,
              });
            });
            throw error;
          },
        );

      return [{ items: groupItems, rode: attached.rode, handled }];
    };

    // Kick off the bypass requests' producer calls immediately (in parallel
    // with the cache read below): their directives guarantee producer
    // contact, so there's nothing to read first.
    const bypassGroups = attachGroups(bypassItems, "bypass");
    // Insurance against unhandled rejections if this call throws before
    // awaiting the groups (e.g., a cache-read failure below): observing the
    // rejection here doesn't consume it for the real await.
    bypassGroups.forEach((group) => void group.handled.catch(() => {}));

    // Read the cache for everything else.
    const cacheResults =
      readItems.length > 0
        ? await cache
            .getMany(
              readItems.map((item) => item.req),
              callOptions,
            )
            .catch((e: unknown) => {
              // If the error was the signal being aborted, propagate that (as
              // `aborted` settlements); don't assume a read failure. The
              // bypass elements are settled as aborted too: their answers
              // haven't arrived, and this call won't deliver them.
              if (signal?.aborted) {
                throwAborted([
                  ...readItems.map((item) => ({ item, rode: false })),
                  ...bypassGroups.flatMap((group) =>
                    group.items.map((item) => ({ item, rode: group.rode })),
                  ),
                ]);
              }

              switch (onCacheReadFailure) {
                case "throw":
                  // The call never reached a disposition: no fetch messages
                  // -- including for the bypass elements. Their in-flight
                  // invocation keeps running (and stores on success), but
                  // this call won't deliver its answers, so mark them
                  // settled WITHOUT publishing: a later
                  // `served-from-producer` would claim an answer the caller
                  // never received.
                  bypassGroups.forEach((group) => {
                    group.items.forEach((item) => {
                      item.settled = true;
                    });
                  });
                  throw e;
                case "call-producer":
                  // Pretend the cache returned no results so that we'll fall
                  // through to the producers.
                  return readItems.map(() => ({
                    validatable: [],
                  })) as CacheLookupResult<
                    SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
                    Validators,
                    Params
                  >[];
                default:
                  assertUnreachable(onCacheReadFailure);
              }
            })
        : [];

    // An abort that landed while the read was in flight (but didn't reject
    // it) settles everything as aborted before any miss reaches a producer.
    if (signal?.aborted) {
      throwAborted([
        ...readItems.map((item) => ({ item, rode: false })),
        ...bypassGroups.flatMap((group) =>
          group.items.map((item) => ({ item, rode: group.rode })),
        ),
      ]);
    }

    const itemsWithCacheResults = zip2(readItems, cacheResults);

    const results = new Map<RequestItem, LooseEntry | ErrorType>();

    // Cache-served dispositions are final the moment the read resolves; they
    // settle immediately (matching wrapProducer, where each such request
    // returns without ever touching a producer).
    const itemsWithUsableResults = itemsWithCacheResults
      .filter(([, res]) => res.usable)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .map(([item, res]) => [item, res.usable!] as const);

    for (const [item, usable] of itemsWithUsableResults) {
      settleFetch(item, false, { disposition: "served-from-cache" });
      results.set(item, usable);
    }

    const itemsWithUsableWhileRevalidateResults = itemsWithCacheResults
      .filter(([, res]) => res.usableWhileRevalidate)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .map(([item, res]) => [item, res.usableWhileRevalidate!] as const);

    for (const [item, stale] of itemsWithUsableWhileRevalidateResults) {
      settleFetch(item, false, {
        disposition: "served-stale-while-revalidating",
      });
      results.set(item, stale);
    }

    // Call the producers immediately for requests that can't be satisfied
    // directly from cache.
    const itemsNeedingProducerNow = itemsWithCacheResults.filter(
      ([, res]) => !(res.usable ?? res.usableWhileRevalidate),
    );

    const usableIfErrorByItem = new Map(
      itemsNeedingProducerNow.flatMap(([item, res]) =>
        res.usableIfError ? [[item, res.usableIfError] as const] : [],
      ),
    );

    const missGroups = attachGroups(
      itemsNeedingProducerNow.map(([item]) => item),
      "miss",
      usableIfErrorByItem,
    );

    // Start background refreshes but don't await them; swallow any errors
    // rather than crashing. No signal here since this is fire-and-forget
    // background work. (These items' fetch messages already settled above, so
    // the shared group machinery publishes nothing for them.)
    if (itemsWithUsableWhileRevalidateResults.length > 0) {
      attachGroups(
        itemsWithUsableWhileRevalidateResults.map(([item]) => item),
        "revalidation",
      ).forEach((group) => {
        group.handled.catch(() => {
          logWarning(
            "error asynchronously requesting refreshed content from bulk producer",
          );
        });
      });
    }

    // Await every foreground producer group, racing the caller's wait against
    // its signal (each group's fetch messages settle from the group itself,
    // so an element whose answer arrived before an abort keeps its real
    // disposition).
    const foregroundGroups = [...missGroups, ...bypassGroups];
    let groupResults: (LooseEntry | ErrorType)[][];
    try {
      groupResults = await raceWithSignal(
        Promise.all(foregroundGroups.map(async (group) => group.handled)),
        signal,
      );
    } catch (e) {
      if (signal?.aborted) {
        throwAborted(
          foregroundGroups.flatMap((group) =>
            group.items.map((item) => ({ item, rode: group.rode })),
          ),
        );
      }
      throw e;
    }

    zip2(foregroundGroups, groupResults).forEach(([group, groupResult]) => {
      zip2(group.items, groupResult).forEach(([item, result]) => {
        results.set(item, result);
      });
    });

    // oxlint-disable-next-line unicorn/no-new-array -- intentional sparse preallocation; filled by index below
    const orderedResults: (LooseEntry | ErrorType)[] = new Array(items.length);
    for (const [item, result] of results) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      orderedResults[itemsToOriginalIndices.get(item)!] = result;
    }

    return orderedResults;
  };

  // SAFETY: the runtime function is id-erased internally (see LooseProducer
  // in wrapProducer.ts), but every path upholds the per-id contract the
  // signature promises: cache reads narrow by id, and each producer's
  // request-paired results are stamped with their own requests' ids.
  return wrappedBulkProducer as unknown as <
    const Reqs extends readonly PartialConsumerRequest<
      Params,
      IdOfResourceType<RT[Covered]>
    >[],
  >(
    reqs: Reqs,
    options?: { signal?: AbortSignal },
  ) => Promise<{
    -readonly [K in keyof Reqs]:
      | EntryForId<SpecOf<RT>, Validators, Params, Extract<Reqs[K]["id"], SpecOf<RT>["id"]>>
      | ErrorType;
  }>;
}

/**
 * The bulk counterpart of {@link producerByIdType}: sugar over
 * {@link wrapBulkProducer}'s single-producer primitive that turns a record with
 * one bulk producer per covered resource type into ONE function, and declares
 * its covered set in {@link coveredTypes} so the wrapper can both infer
 * `Covered` from it and enforce it at runtime.
 *
 * Use it when each resource type has its own origin, or to cover a strict
 * subset of the registry. Skip it -- pass a bare function -- when the producer
 * wants the full mixed batch, which is the capability the single-function form
 * exists for.
 *
 * Behaviour on each invocation:
 *
 * - The incoming batch is split by `cache.classify(req.id)`, remembering every
 *   request's ORIGINAL index, and each sub-producer is invoked once,
 *   concurrently, with its own slice.
 * - Results are reassembled **positionally**: slice position `j` maps back to
 *   that request's original index. Positional is forced, not chosen: a batch
 *   can legitimately contain the same id twice with different `params`, so the
 *   id is not a routing key.
 * - A sub-producer's **rejection** is caught and written into that type's slots
 *   as `Error` elements, so per-request error isolation survives the merge --
 *   it lives in the sugar rather than in the wrapper.
 * - A sub-producer that **under-returns** is NOT repaired or padded: those
 *   slots are left absent, so the wrapper's own under-return check (which
 *   rejects the whole invocation rather than risk misaligned pairing) fires
 *   exactly as it would for a bare producer. Silently substituting an `Error`
 *   would convert a contract violation into a per-request failure and hide the
 *   bug.
 * - A sub-producer that **over-returns** has no slot for the extras, so they
 *   are dropped -- matching the wrapper's own choice not to police
 *   over-return.
 *
 * Note that requests routed through this helper are classified TWICE (once here
 * to split the batch, once in the wrapper for dispatch/telemetry). That is the
 * price of the sugar being opt-in; guards are meant to be cheap.
 *
 * Throws at construction on an empty record.
 *
 * @param cache - The cache the producer will be wrapped against. Used to infer
 *   `RT` and to classify each request's id.
 * @param producers - One {@link BulkResourceTypeProducer} per covered resource
 *   type; `Covered` is inferred from the keys.
 */
export function bulkProducerByIdType<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  producers: BulkProducersFor<RT, Covered, Validators, Params, ErrorType>,
): CoveringBulkProducer<RT, Covered, Validators, Params, ErrorType> {
  // SAFETY: see LooseProducer in wrapProducer.ts. A value is only read out of
  // this record after `cache.classify` succeeds and the key is confirmed to be
  // the record's own, so each sub-producer's slice holds exactly the ids it
  // declared. The record's own entries are snapshotted here, before any request
  // runs, so a post-helper mutation of the caller's record can't widen (or
  // otherwise change) coverage later.
  const looseProducers = { ...producers } as unknown as Readonly<
    Record<string, LooseBulkProducer<RT, Validators, Params, ErrorType>>
  >;
  const coveredResourceTypes = Object.keys(looseProducers);

  if (coveredResourceTypes.length === 0) {
    throw new Error(
      "bulkProducerByIdType: `producers` must be a record with one entry per " +
        "covered resource type and cannot be empty. (A producer that covers " +
        "the whole registry needs no helper: pass the function itself to " +
        "wrapBulkProducer.)",
    );
  }

  // The id is re-narrowed past its ReadonlyDeep wrapper, which cannot *reduce*
  // to the (string) id type while `RT` is an unresolved generic, even though
  // it's the id value itself at runtime.
  type LooseRequest = ReadonlyDeep<
    ConsumerRequest<Params, SpecOf<RT>["id"]>
  > & { readonly id: SpecOf<RT>["id"] };
  type LooseResult = RequestPairedProducerResult<
    SpecOf<RT>,
    Validators,
    Params
  >;

  const dispatchingProducer = async (reqs: readonly LooseRequest[]) => {
    const classified = reqs.map((req, index) => ({
      index,
      req,
      resourceType: cache.classify(req.id),
    }));

    // Sparse by design: only the slots a sub-producer actually returned get
    // filled, so an under-return leaves holes for the wrapper to catch.
    // oxlint-disable-next-line unicorn/no-new-array -- intentional sparse preallocation; filled by index below
    const results: (LooseResult | Error)[] = new Array(reqs.length);

    await Promise.all(
      [...Map.groupBy(classified, (it) => it.resourceType).entries()].map(
        async ([resourceType, entries]) => {
          const subProducer = Object.hasOwn(looseProducers, resourceType)
            ? looseProducers[resourceType]
            : undefined;
          // Unreachable through the wrappers, which reject uncovered types
          // before this function is ever called; reachable if the returned
          // producer is driven directly. Fail the whole invocation loudly
          // rather than leaving those slots empty.
          if (subProducer === undefined) {
            throw new NoProducerForResourceTypeError({
              cacheName: cache.name,
              resourceType,
              coveredResourceTypes,
              // Non-null assertion is safe: Map.groupBy never makes an empty
              // group.
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              id: entries[0]!.req.id,
            });
          }

          const subResults = await subProducer(
            entries.map((it) => it.req),
          ).catch((error: unknown) => {
            // Per-request error isolation survives the merge: this type's
            // slots settle as Error elements instead of failing the whole
            // invocation. A non-Error rejection is wrapped rather than stored
            // raw, since a non-Error in a result slot would be read as a
            // successful producer result; the original is kept as `cause`.
            const asError =
              error instanceof Error
                ? error
                : new Error(
                    `bulkProducerByIdType: the "${resourceType}" producer rejected with a non-Error value`,
                    { cause: error },
                  );
            return entries.map(() => asError);
          });

          entries.forEach((entry, j) => {
            const result = subResults[j];
            if (result !== undefined) {
              results[entry.index] = result;
            }
          });
        },
      ),
    );

    return results;
  };

  // SAFETY: the dispatching function is id-erased internally (see
  // LooseProducer in wrapProducer.ts), and the covered names are the record's
  // own keys, so the declared set and the reachable sub-producers cannot
  // disagree.
  return Object.assign(dispatchingProducer, {
    [coveredTypes]: coveredResourceTypes,
  }) as unknown as CoveringBulkProducer<
    RT,
    Covered,
    Validators,
    Params,
    ErrorType
  >;
}
