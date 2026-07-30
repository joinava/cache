import { partition } from "es-toolkit";
import stableStringify from "safe-stable-stringify";
import type { PublicInterface } from "type-party";
import type Cache from "../Cache.js";
import { rethrowUnroutableWithCacheName } from "./producer-errors.js";
import {
  cacheProduceChannel,
  publishCacheFetch,
  publishCacheProduce,
  type CacheFetchDisposition,
} from "../diagnostics.js";
import {
  type IdOfResourceType,
  type ResourceTypeName,
  type ResourceTypes,
  type SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  EntryForId,
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
import type { BulkResourceTypeProducer } from "./bulkProducerByIdType.js";
import {
  assertResourceTypeCovered,
  coveredTypeSet,
  isRequestingCacheBypass,
  PRODUCER_ERROR_FALLBACK_WARNING,
  throwUnreachableAbort,
  type CoveredTypesCarrier,
  type LooseEntryFor,
  type LooseLookupResultFor,
  type LooseRequestFor,
  type LooseResultFor,
  type WrapProducerOptions,
} from "./wrapProducer.js";

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
> = BulkResourceTypeProducer<RT, Covered, Validators, Params, ErrorType> &
  CoveredTypesCarrier<RT, Covered>;

/** The internal, id-erased dispatch shape; see `LooseProducer` in wrapProducer.ts. */
export type LooseBulkProducer<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = (
  reqs: readonly LooseRequestFor<RT, Params>[],
) => Promise<(LooseResultFor<RT, Validators, Params> | ErrorType)[]>;

/**
 * What {@link wrapBulkProducer} returns. Named because it is spelled both in the
 * signature and in the closing cast, far enough apart to drift, and the cast is
 * the only thing that would notice them disagreeing.
 */
type WrappedBulkProducerFn<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = <
  const Reqs extends readonly PartialConsumerRequest<
    Params,
    IdOfResourceType<RT[Covered]>
  >[],
>(
  reqs: Reqs,
  options?: { signal?: AbortSignal },
) => Promise<{
  -readonly [K in keyof Reqs]:
    | EntryForId<
        SpecOf<RT>,
        Validators,
        Params,
        Extract<Reqs[K]["id"], SpecOf<RT>["id"]>
      >
    | ErrorType;
}>;

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
 * That is what gives this wrapper its defining bulk capability: a bare
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
 * throw `NoProducerForResourceTypeError` before any cache read -- only when
 * coverage was actually narrowed; see that error's docs in wrapProducer.ts).
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
  options: WrapProducerOptions | undefined,
  producer: CoveringBulkProducer<RT, Covered, Validators, Params, ErrorType>,
): WrappedBulkProducerFn<RT, Covered, Validators, Params, ErrorType> {
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

  const covered = coveredTypeSet(producer);

  const logTrace = logger.bind(null, "wrap-producer", "trace");
  const logWarning = logger.bind(null, "wrap-producer", "warn");

  type LooseRequest = LooseRequestFor<RT, Params>;
  type LooseResult = LooseResultFor<RT, Validators, Params>;
  type LooseEntry = LooseEntryFor<RT, Validators, Params>;
  type LooseLookupResult = LooseLookupResultFor<RT, Validators, Params>;

  const callProducerAndLog = async (
    reqs: readonly LooseRequest[],
  ): Promise<(LooseResult | ErrorType)[]> => {
    logTrace("contacting bulk producer", { reqs });
    // A by-id-type producer routes ids itself and has no cache to name in its
    // errors; this is where the cache's name is put back on (see
    // rethrowUnroutableWithCacheName). Every other rejection passes through.
    //
    // try/catch rather than a `.catch()` on the returned promise, for the reason
    // given in `wrapProducer`: a producer that fails SYNCHRONOUSLY never reaches
    // a handler attached to its return value.
    let responses: (LooseResult | ErrorType)[];
    try {
      responses = await looseProducer(reqs);
    } catch (error: unknown) {
      rethrowUnroutableWithCacheName(cache.name, error);
    }
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
  // ids and is deliberately excluded. That means ONE invocation per trigger
  // group. Bypass, miss, and revalidation groups still stay separate -- not
  // because `trigger` is in the key (it is not), but because their request
  // arrays differ, bypass carrying `maxAge: 0` directives.
  //
  // The granularity is whole-batch, so two callers sharing a `story` sub-batch
  // but differing on their `collection` parts share nothing. Finer, per-type
  // collapsing is recoverable inside `bulkProducerByIdType` via the
  // already-exported `collapsedTaskCreator`; it lives here at batch
  // granularity because splitting it would relocate the complexity one layer
  // down rather than remove it.
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
        // O(batch-size), so it is especially worth not building when nobody is
        // listening (`publish` would discard it, but the argument is evaluated
        // regardless -- which is why every publish site tests for subscribers,
        // not just this one).
        if (!cacheProduceChannel.hasSubscribers) {
          return;
        }
        publishCacheProduce({
          cache: cache.name,
          trigger: invocation.trigger,
          requests: reqs.map((req, i) => ({
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index-aligned with `reqs`
            resourceType: resourceTypes[i]!,
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
        // Tests FILLED slots rather than the array's `length`, which is not the
        // same thing: `bulkProducerByIdType` reassembles into a preallocated
        // array (deliberately leaving an under-returning sub-producer's slots
        // as holes for this check to catch), so its `length` always equals
        // `reqs.length` even when results are missing. `every` short-circuits
        // on the first hole, and the count for the message is only worth
        // walking the batch for once we know it will be reported.
        const isAnswered = (_: unknown, i: number) =>
          requestPairedProducerResults[i] !== undefined;
        if (!reqs.every(isAnswered)) {
          const answered = reqs.filter(isAnswered).length;
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
      /**
       * This element's position in the caller's `reqs`, carried so results can
       * be written straight into their output slot.
       */
      index: number;
      req: LooseRequest;
      resourceType: string;
      directivesImpliedBypass: boolean;
      /** This element's own if-error fallback, once the cache read has run. */
      usableIfError?: LooseEntry;
      /**
       * Set to true when this element's fetch message has been published, so
       * each logical request settles on the fetch channel exactly once (its
       * answer and an abort can race).
       */
      settled: boolean;
    };
    const items: RequestItem[] = reqs.map((req, index) => {
      const finalRequest = completeRequest(req) as LooseRequest;
      return {
        index,
        req: finalRequest,
        resourceType: cache.classify(finalRequest.id),
        directivesImpliedBypass: isRequestingCacheBypass(
          finalRequest.directives,
        ),
        settled: false,
      };
    });

    // Skipped entirely for a bare producer, which declares no covered set
    // because it covers the whole registry (see wrapProducer's docs) -- hence
    // the hoisted test, so the common case doesn't walk the batch to make N
    // calls that each return immediately.
    if (covered !== undefined) {
      items.forEach((item) => {
        assertResourceTypeCovered(
          cache.name,
          covered,
          item.resourceType,
          item.req.id,
        );
      });
    }

    const settleFetch = (
      item: RequestItem,
      collapsed: boolean,
      disposition: CacheFetchDisposition,
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
      throwUnreachableAbort(signal);
    };

    if (signal?.aborted) {
      throwAborted(items.map((item) => ({ item, rode: false })));
    }

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
    // results. One invocation per call at batch collapse granularity (see the
    // COLLAPSE GRANULARITY note above); it returns a list so its callers can
    // concatenate their trigger classes, and so an empty set attaches nothing.
    const attachGroups = (
      groupItems: readonly RequestItem[],
      trigger: CollapsedInvocation["trigger"],
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
                const fallback = item.usableIfError;
                if (fallback) {
                  logWarning(PRODUCER_ERROR_FALLBACK_WARNING, {
                    error: producerResult,
                    entry: fallback,
                  });
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

    // Everything this call could still deliver: the cache-read cohort, plus the
    // bypass elements whose in-flight invocation this call will no longer wait
    // for.
    const throwAbortedForAllPending = (): never =>
      throwAborted([
        ...readItems.map((item) => ({ item, rode: false })),
        ...bypassGroups.flatMap((group) =>
          group.items.map((item) => ({ item, rode: group.rode })),
        ),
      ]);

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
                throwAbortedForAllPending();
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
                  return readItems.map(
                    () => ({ validatable: [] }) satisfies LooseLookupResult,
                  ) as LooseLookupResult[];
                default:
                  assertUnreachable(onCacheReadFailure);
              }
            })
        : [];

    // An abort that landed while the read was in flight (but didn't reject
    // it) settles everything as aborted before any miss reaches a producer.
    if (signal?.aborted) {
      throwAbortedForAllPending();
    }

    const itemsWithCacheResults = zip2(readItems, cacheResults);

    // Results are written straight into their caller-order slot via
    // `item.index`, so there is no identity map to keep consistent. Sparse by
    // design until every item has settled.
    // oxlint-disable-next-line unicorn/no-new-array -- intentional sparse preallocation; filled by index below
    const orderedResults: (LooseEntry | ErrorType)[] = new Array(items.length);

    // Cache-served dispositions are final the moment the read resolves, so they
    // settle immediately (matching wrapProducer, where each such request
    // returns without ever touching a producer). Returns the items it settled,
    // which is what the revalidation group below needs.
    const settleFromCache = (
      field: "usable" | "usableWhileRevalidate",
      disposition: "served-from-cache" | "served-stale-while-revalidating",
    ): RequestItem[] =>
      itemsWithCacheResults.flatMap(([item, res]) => {
        const entry = res[field];
        if (!entry) {
          return [];
        }
        settleFetch(item, false, { disposition });
        orderedResults[item.index] = entry;
        return [item];
      });

    settleFromCache("usable", "served-from-cache");
    const revalidateItems = settleFromCache(
      "usableWhileRevalidate",
      "served-stale-while-revalidating",
    );

    // Call the producers immediately for requests that can't be satisfied
    // directly from cache.
    const itemsNeedingProducerNow = itemsWithCacheResults.filter(
      ([, res]) => !(res.usable ?? res.usableWhileRevalidate),
    );

    // Each element's own if-error fallback rides on the item, so the group
    // machinery reads it without a parallel map.
    itemsNeedingProducerNow.forEach(([item, res]) => {
      if (res.usableIfError) {
        item.usableIfError = res.usableIfError;
      }
    });

    const missGroups = attachGroups(
      itemsNeedingProducerNow.map(([item]) => item),
      "miss",
    );

    // Start background refreshes but don't await them; swallow any errors
    // rather than crashing. No signal here since this is fire-and-forget
    // background work. (These items' fetch messages already settled above, so
    // the shared group machinery publishes nothing for them.)
    if (revalidateItems.length > 0) {
      attachGroups(revalidateItems, "revalidation").forEach((group) => {
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
        orderedResults[item.index] = result;
      });
    });

    return orderedResults;
  };

  // SAFETY: the runtime function is id-erased internally (see LooseProducer
  // in wrapProducer.ts), but every path upholds the per-id contract the
  // signature promises: cache reads narrow by id, and each producer's
  // request-paired results are stamped with their own requests' ids.
  return wrappedBulkProducer as unknown as WrappedBulkProducerFn<
    RT,
    Covered,
    Validators,
    Params,
    ErrorType
  >;
}
