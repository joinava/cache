/**
 * @fileoverview The client that both producer wrappers share:
 * `wrapSingleProducer` and `wrapBulkProducer`. It reads the cache, overlays
 * pending writes, shares and sends producer work through a
 * {@link ProducerScheduler}, stores produced resources, and publishes
 * diagnostics. A wrapper supplies only what differs: how to call its producer,
 * and the scheduler that sends the work.
 *
 * The runtime helpers that the client needs live here too, so that the runtime
 * import graph stays acyclic: `wrapProducer` imports the wrappers, which import
 * this module, whose edge back to `wrapProducer` is type-only.
 * `wrapProducer` re-exports the ones its importers use.
 *
 * @module
 */
import { sumBy } from "es-toolkit";
import stableStringify from "safe-stable-stringify";
import type { ReadonlyDeep } from "type-fest";

import {
  NoProducerForResourceTypeError,
  rethrowUnroutableWithCacheName,
} from "./producer-errors.js";
import {
  cacheProduceChannel,
  publishCacheFetch,
  publishCacheProduce,
  type CacheFetchDisposition,
  type CacheProduceMessage,
} from "../diagnostics.js";
import type {
  ResourceTypeName,
  ResourceTypes,
  SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  Entry,
  Logger,
  Vary,
  PartialReadonlyConsumerRequest,
  ReadonlyConsumerRequest,
  RequestPairedProducerResult,
} from "../types/index.js";
import type { DispatchInfo } from "../scheduling/batcher.js";
import { normalizeParams, normalizeVary } from "./normalization.js";
import { PendingResources } from "./pendingResources.js";
import { classifyCacheEntries, mergeCacheLookups } from "./cacheHelpers.js";
import {
  completeRequest,
  primaryNormalizedResultResourceFromRequestPairedProducerResult,
  requestPairedProducerResultToResources,
} from "./requestPairedProducerUtils.js";
import {
  asError,
  CacheContractError,
  defaultLoggersByComponent,
  raceWithSignal,
} from "./utils.js";
import type { SpecForId } from "../types/00_CacheSpec.js";
import { coveredTypes } from "../types/index.js";
import type { CacheLookupResult } from "./cacheHelpers.js";
import type {
  WrappedProducerClient,
  WrappedReadOptions,
  ProducerClientOptions,
} from "./wrapProducer.js";

/**
 * Lets an outer wrapper pass its own call start time in the read options, so
 * that a fetch message's `durationMs` covers the outer wrapper's work before
 * the read.
 */
export const wrappedReadStartedAt: unique symbol = Symbol(
  "wrappedReadStartedAt",
);
/**
 * An optional method on a producer function. The client calls it with the
 * request's id when a task starts, and calls the release function it returns
 * once the task settles. The hashed-input wrappers use it to keep a request's
 * inputs alive while its production is pending.
 */
export const producerRequestLease: unique symbol = Symbol(
  "producerRequestLease",
);

/** Observe foreground persistence without delaying the produced result. */
export type OnStore = (stored: Promise<void>) => void;

/** Bulk persistence settles every write before exposing the first failure. */
export function notifyStore(
  stores: readonly Promise<void>[],
  onStore: OnStore | undefined,
): void {
  if (onStore === undefined) return;
  const stored = Promise.allSettled(stores).then((results) => {
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  // Callers may ignore persistence or attach a handler after the result arrives.
  void stored.catch(() => {});
  onStore(stored);
}

/**
 * Snapshots a producer's declared covered set for the coverage check: a `Set`
 * for membership testing, insertion-ordered so the error message can still
 * list the names in their declared order, and a copy so a post-wrap mutation
 * of the caller's array can't widen (or otherwise change) coverage later.
 * `undefined` means the producer declared nothing, which (see
 * `CoveringProducer`) means it covers the whole registry: there is no
 * covered set to enumerate and nothing to check.
 */
export function coveredTypeSet(producer: {
  readonly [coveredTypes]?: readonly string[];
}): ReadonlySet<string> | undefined {
  const declared = producer[coveredTypes];
  return declared === undefined ? undefined : new Set(declared);
}

/**
 * Throws {@link NoProducerForResourceTypeError} if `resourceType` is outside a
 * DECLARED covered set. `covered === undefined` (a whole-registry producer)
 * checks nothing.
 */
export function assertResourceTypeCovered(
  cacheName: string,
  covered: ReadonlySet<string> | undefined,
  resourceType: string,
  id: string,
): void {
  if (covered !== undefined && !covered.has(resourceType)) {
    throw new NoProducerForResourceTypeError({
      cacheName,
      resourceType,
      coveredResourceTypes: [...covered],
      id,
    });
  }
}

/**
 * Logged when a request's own if-error entry absorbs a producer failure.
 * Exported so that tests and operators match one string.
 */
export const PRODUCER_ERROR_FALLBACK_WARNING =
  "error calling producer; falling back to a cached value, as permitted";

export function isRequestingCacheBypass(
  dirs: ReadonlyDeep<ConsumerDirectives>,
) {
  return dirs.maxAge === 0;
}

/** The internal, id-erased dispatch shape; see `LooseProducer`. */
export type LooseBulkProducer<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = (
  reqs: readonly LooseRequestFor<RT, Params>[],
) => Promise<(LooseResultFor<RT, Validators, Params> | ErrorType)[]>;

/**
 * A request as the wrappers' id-erased internals see it: every id the wrapper
 * could be handed, with `id` still usable as that type (see
 * {@link ReadonlyConsumerRequest}).
 */
export type LooseRequestFor<
  RT extends ResourceTypes,
  Params extends AnyParams,
> = ReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>;

/** An entry as the wrappers' id-erased internals see it. */
export type LooseEntryFor<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Entry<SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>, Validators, Params>;

/** A cache lookup result as the wrappers' id-erased internals see it. */
export type LooseLookupResultFor<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = CacheLookupResult<
  SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
  Validators,
  Params
>;

/** A request-paired producer result over the whole registry. */
export type LooseResultFor<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = RequestPairedProducerResult<SpecOf<RT>, Validators, Params>;

/**
 * The internal, id-erased shape all wrapper plumbing dispatches through.
 * SAFETY: the producer is only invoked after (a) `cache.classify(req.id)`
 * succeeds and (b) the coverage check confirms the classified type is one the
 * producer declared (or the producer declared none, i.e. it covers the whole
 * registry) -- so the request's id is in exactly the id sub-space the producer
 * accepts.
 */
export type LooseProducer<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = (
  req: LooseRequestFor<RT, Params>,
) => Promise<LooseResultFor<RT, Validators, Params>>;

/** One task as a {@link ProducerScheduler} hands it to `dispatch`. */
export type DispatchedRequest<Work> = {
  /**
   * The work of the request that STARTED the task. Requests that ride the
   * task never replace it, so per-request labels such as a producer trigger
   * keep the starting request's value.
   */
  readonly request: Work;
  /**
   * The number of requests that have ridden the task so far. Each one is a
   * request that sharing served without starting new work. The request that
   * started the task does not count, and a cancelled rider still does. Live:
   * read it at publish time, so that requests that ride the task while it runs
   * count too.
   */
  readonly collapsedRequestCount: () => number;
  /**
   * Milliseconds the task waited in the automatic queue. 0 for a task that
   * was sent at once.
   */
  readonly queueWaitMs: number;
};

/** What the shared client gives a {@link ProducerScheduler} when it builds it. */
export type ProducerSchedulerOptions<Work, Produced> = {
  /**
   * The caller's logger, or undefined to let the scheduler pick its default.
   * The bulk scheduler passes it to its `Batcher`, which warns about work
   * started after `close` under its own component.
   */
  logger: Logger | undefined;
  /**
   * A new request rides a pending task with the same key only if that task
   * started no more than this many milliseconds ago.
   */
  collapseTasksMs: number;
  /**
   * Converts a request into the key that decides which pending task it may
   * ride. `undefined` means the request must not share work with any other:
   * it then starts its own task.
   */
  makeKey: (work: Work) => string | undefined;
  /**
   * Called when a task starts. It returns a release function that the
   * scheduler calls once the task settles, with {@link releaseOnSettle}. It
   * keeps a request's inputs alive while its production is pending.
   */
  retain: (work: Work) => () => void;
  /**
   * Runs one producer invocation for the given tasks. Its `info` describes
   * the whole invocation. It resolves with one result or Error per task, in
   * order. A rejection fails every task in the invocation.
   */
  dispatch: (
    tasks: readonly DispatchedRequest<Work>[],
    info: DispatchInfo,
  ) => Promise<readonly (Produced | Error)[]>;
};

/**
 * Shares pending producer work between independent requests, and sends it.
 * Each wrapper has its own: a single producer sends each task at once, and a
 * bulk producer batches the tasks. Dispatched work always completes.
 */
export type ProducerScheduler<Work, Produced> = {
  /**
   * Starts or rides a task for each request. Reports for each request whether
   * it `rode` a pending task (true) or started one (false). A request without
   * a signal can never be cancelled, so the task it starts or rides can never
   * be cancelled either. Automatic work may wait in a batch.
   */
  startOrRideTasks(
    requests: readonly { request: Work; signal?: AbortSignal | undefined }[],
  ): { promise: Promise<Produced>; rode: boolean }[];
  /**
   * Like `startOrRideTasks`, but sends the call's tasks at once, together with
   * the queued tasks that it rides, as one invocation. Only a scheduler whose
   * automatic work waits in batches has it. A call with
   * `autoBatch.producer: false` then collects all of its producer work, and
   * sends it with one `startOrRideDirect` call.
   */
  startOrRideDirect?(
    requests: readonly { request: Work; signal?: AbortSignal | undefined }[],
  ): { promise: Promise<Produced>; rode: boolean }[];
  flush(): void;
  /**
   * Flushes, then waits until no task is queued or running. The client calls
   * it once it stops starting or riding tasks. Work started after it finishes
   * logs a warning.
   */
  close(): Promise<void>;
};

/** What a producer wrapper gives the shared client. */
export type ProducerBinding<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  /**
   * The wrapped producer function, as the caller passed it. The client reads
   * its declared covered set ({@link coveredTypes}) and its optional
   * {@link producerRequestLease}.
   */
  producer: object & { readonly [coveredTypes]?: readonly string[] };
  /**
   * Calls the producer once for the given requests. It resolves with one
   * result or Error per request, in order.
   */
  call: (
    requests: readonly LooseRequestFor<RT, Params>[],
  ) => Promise<readonly (LooseResultFor<RT, Validators, Params> | Error)[]>;
  /** Builds the scheduler that shares and sends this producer's work. */
  makeScheduler: <Work, Produced>(
    options: ProducerSchedulerOptions<Work, Produced>,
  ) => ProducerScheduler<Work, Produced>;
};

/** The release function of a task whose producer takes no lease. */
const noRelease = () => {};

/**
 * Ends a task's `retain` lease once its result settles. The lease is taken
 * before the task's work starts. Every result settles, including a
 * cancelled one, so the lease always ends.
 */
export function releaseOnSettle<Result>(
  release: () => void,
  result: Promise<Result>,
): Promise<Result> {
  const held = result.finally(release);
  // Cancellation can reject the result before anyone awaits it.
  void held.catch(() => {});
  return held;
}

/**
 * Builds the client that `wrapProducer` returns, for the producer that
 * `binding` describes. See `wrapProducer` for the client's behavior.
 */
export function createProducerClient<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  options: ProducerClientOptions<RT, Validators, Params>,
  { producer, call, makeScheduler }: ProducerBinding<RT, Validators, Params>,
): WrappedProducerClient<RT, Covered, Validators, Params> {
  const {
    cache,
    collapseOverlappingRequestsTime = 3,
    onCacheReadFailure = "call-producer",
    logger = defaultLoggersByComponent["wrap-producer"],
  } = options;
  const covered = coveredTypeSet(producer);

  type Request = LooseRequestFor<RT, Params>;
  type Result = LooseResultFor<RT, Validators, Params>;
  type ResultEntry = LooseEntryFor<RT, Validators, Params>;
  type Lookup = LooseLookupResultFor<RT, Validators, Params>;
  type Produced = { entry: ResultEntry; stored: Promise<void> };
  // Carries the classified type so the produce message can attribute each
  // request to its own type without re-classifying. The scheduler keeps the
  // Work of the request that starts a task, so the starting request's trigger
  // labels the invocation.
  type Work = {
    request: Request;
    resourceType: string;
    trigger: Exclude<CacheProduceMessage["trigger"], "mixed">;
  };

  const normalizeVaryBound = (vary: Vary<Params>) =>
    normalizeVary(cache.normalizeParamName, cache.normalizeParamValue, vary);
  // Entries whose cache.store() is still in flight, consulted on every
  // ordinary lookup; see `wrapProducer`'s docs and PendingResources.
  const pendingResources = new PendingResources<SpecOf<RT>, Validators, Params>(
    normalizeVaryBound,
  );

  // In-flight work that close() drains, in this order: accepted calls, their
  // per-slot pipelines, the producer scheduler, then cache writes. Writes are
  // separate because they outlive the call that started them.
  const writes = new Set<Promise<void>>();
  const calls = new Set<Promise<unknown>>();
  const pipelines = new Set<Promise<unknown>>();
  // `closed` rejects new calls from the first close(). `closing` lets a
  // repeated close() share one drain.
  let closed = false;
  let closing: Promise<void> | undefined;

  // Suppose the caller is requesting a resource, and we're already in the
  // process of requesting that resource from the producer, and our pending
  // request had the same id and the same params.
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
  // So, here, we decide to keep track of the in-flight requests to the origin,
  // and, if there is an identical request pending that was issued less than
  // `collapseOverlappingRequestsTime` seconds ago, we wait for and use the
  // response of the already-pending request, rather than issuing a new one. We
  // make `collapseOverlappingRequestsTime` configurable to placate any user
  // worried about the miniscule risk of inconsistency from this caching.
  //
  // The producer scheduler tracks the pending tasks in memory, so this
  // optimzation will be hindered a bit if the cache frontend is
  // horizontally-scaled across more than one server, but that's fine. We
  // _could_ put this data in the backing store, but that seems like it could
  // create more race conditions? And since batching identical requests at all
  // is an optimization, putting this in the store would probably be overkill.
  //
  // Finally, note is that we only collapse requests that target the same id
  // _with the same normalized parameters_. If we didn't require the params to
  // match, we could get back a response to the first/pending request, only to
  // find out that it includes a `vary` value that makes it unsuitable to serve
  // the second request (that we were trying to avoid making). So we'd have to
  // add fallback logic to handle actually issuing the second request in that
  // case, and that would be too much extra complexity to be worth it. We're in
  // a similar situation with directives, which must also match -- which is
  // also what keeps bypass (`maxAge: 0`) invocations from ever being shared
  // with plain-miss callers.
  //
  // Dispatched work always fires a (non-awaited) cache.store() after the
  // producer resolves. This is critical for the abort-signal design: since
  // shared producer calls don't receive a signal and can't be cancelled by
  // individual callers, we rely on the fact that the producer's work always
  // flows into the cache -- ensuring it isn't wasted even when the caller that
  // triggered it has aborted.
  //
  // Because the store is not awaited, the pending-task map alone leaves a
  // window -- from the producer resolving until the write lands -- in which an
  // identical call would read the store, miss, and run the producer again.
  // The entries handed to cache.store() are therefore also held in
  // `pendingResources` until that store call settles (see PendingResources),
  // and every ordinary lookup merges that overlay with the store's candidates.
  //
  // Each dispatch also publishes one `produce` diagnostics message when the
  // producer settles (one message per actual invocation; requests that
  // collapse onto it share it).
  // Read once: the producer is fixed for the client's life.
  const lease =
    producerRequestLease in producer &&
    typeof producer[producerRequestLease] === "function"
      ? producer[producerRequestLease]
      : undefined;
  const scheduler = makeScheduler<Work, Produced>({
    logger: options.logger,
    collapseTasksMs: collapseOverlappingRequestsTime * 1000,
    // The key covers the full request (id, normalized params, directives) but
    // not resourceType, which is derived from the id and so adds nothing. It
    // also omits the trigger, so a revalidation can ride a pending miss.
    makeKey: ({ request }) => {
      try {
        return stableStringify({
          ...request,
          params: normalizeParams(
            cache.normalizeParamName,
            cache.normalizeParamValue,
            request.params,
          ),
        });
      } catch {
        // Failed normalization cannot prove compatibility. Preserve production
        // with original parameters, but do not share this request's work.
        return undefined;
      }
    },
    retain: ({ request }) => lease?.(request.id) ?? noRelease,
    dispatch: async (tasks, { autoBatched }) => {
      const startedAt = performance.now();
      let results: readonly (Result | Error)[];

      // Publishes this invocation's one `produce` message once the producer
      // settles. `results` is undefined when the producer call rejected,
      // which fails every request.
      //
      // `publish` would discard the message, but not before the argument was
      // built -- so the test has to be here, not left to the channel. The
      // argument is O(batch-size), so it is especially worth not building
      // when nobody is listening. Same reasoning as `Cache.store`.
      // `collapsedRequestCount` is read here, at settlement, so that riders
      // that joined while the producer ran count too.
      const publishProduce = (results: readonly unknown[] | undefined) => {
        if (!cacheProduceChannel.hasSubscribers) return;

        const trigger = tasks[0]!.request.trigger;
        publishCacheProduce({
          cache: cache.name,
          autoBatched,
          requestCount: tasks.length,
          queueWaitTotalMs: sumBy(tasks, (task) => task.queueWaitMs),
          trigger: tasks.every((task) => task.request.trigger === trigger)
            ? trigger
            : "mixed",
          requests: tasks.map(({ request }) => ({
            resourceType: request.resourceType,
            resourceId: request.request.id,
          })),
          collapsedRequestCount: sumBy(tasks, (task) =>
            task.collapsedRequestCount(),
          ),
          failedRequestCount:
            results === undefined
              ? tasks.length
              : results.filter((result) => result instanceof Error).length,
          outcome: results === undefined ? "error" : "success",
          durationMs: performance.now() - startedAt,
        });
      };

      try {
        results = await call(tasks.map(({ request }) => request.request));

        // A producer whose results do not line up 1:1 with the requests it was
        // given violated its contract, and the positional (result, request)
        // pairing is no longer trustworthy -- a dropped middle element would
        // silently pair later results with the wrong requests. So nothing is
        // stored and the WHOLE invocation fails: this throw rejects it, and
        // every waiting call rejects with the CacheContractError.
        //
        // The `undefined`/`null` test catches a sparse array or an explicit
        // `undefined` element hiding behind a correct `length`: neither is
        // ever a legal result -- every `RequestPairedProducerResult` is an
        // object and every error an `Error` -- so it is unambiguously a
        // contract violation, not a value a producer meant to return.
        const definedCount = Array.isArray(results)
          ? Array.from(results).filter(
              (result) => result !== undefined && result !== null,
            ).length
          : 0;
        if (
          !Array.isArray(results) ||
          results.length !== tasks.length ||
          definedCount !== tasks.length
        ) {
          throw new CacheContractError(
            `producer returned ${String(definedCount)} results for ${String(tasks.length)} requests`,
          );
        }
      } catch (error) {
        // A rejected producer call fails every request in the invocation.
        // (A bulk producer should return Error elements for per-request
        // failures instead.)
        publishProduce(undefined);

        // A by-id-type producer routes ids itself and may throw a special
        // UnroutableIdError if the id can't be classified to a covered type.
        // However, the producer has no cache to name in its errors, so this is
        // where the cache's name is attached.
        rethrowUnroutableWithCacheName(cache.name, error);
      }

      // One physical write retains batching for a producer invocation's resources.
      //
      // Share one fallback date with the actual write and any later pending
      // lookup. Lazy normalization must not reset the resource's age.
      const now = new Date();
      const prepared = results.map((result, index) => {
        if (result instanceof Error) return result;

        const id = tasks[index]!.request.request.id;
        try {
          const resources = requestPairedProducerResultToResources<
            SpecOf<RT>,
            Validators,
            Params
          >(result, id).map((resource) => ({
            ...resource,
            date: resource.date ?? now,
          }));
          const entry =
            primaryNormalizedResultResourceFromRequestPairedProducerResult<
              SpecOf<RT>,
              Validators,
              Params,
              SpecOf<RT>["id"]
            >(normalizeVaryBound, result, id, now);
          return { entry, resources };
        } catch (error) {
          // Like an Error slot from the producer, a result that fails to
          // normalize fails only its own slot, even for a CacheContractError:
          // automatic batching merges unrelated callers into one invocation.
          // The slot's own callers still reject their whole public call,
          // through the CacheContractError rethrow in each slot pipeline.
          return asError(error);
        }
      });

      // Published after normalization, so that a slot that fails to
      // normalize counts as failed.
      publishProduce(prepared);

      // Extract all resources to store (main resources + supplemental
      // resources), but NOT requests that failed.
      const resources = prepared.flatMap((result) =>
        result instanceof Error ? [] : result.resources,
      );
      const stored =
        resources.length === 0
          ? Promise.resolve()
          : Promise.try(() => cache.store(resources)).then(() => {});

      writes.add(stored);
      void stored
        .finally(() => writes.delete(stored))
        .catch((error: unknown) =>
          logger(
            "wrap-producer",
            "trace",
            "error storing producer's response",
            error,
          ),
        );
      pendingResources.track(resources, stored, now);

      return prepared.map((result) =>
        result instanceof Error ? result : { entry: result.entry, stored },
      );
    },
  });

  // Undefined for a scheduler that sends every task at once.
  const startDirect = scheduler.startOrRideDirect?.bind(scheduler);

  /** A refresh outlives its caller, so nobody awaits its failure. Log it instead. */
  const logRefreshFailure = (refresh: { promise: Promise<unknown> }) => {
    void refresh.promise.catch((error: unknown) =>
      logger(
        "wrap-producer",
        "warn",
        "error asynchronously requesting refreshed content from producer",
        error,
      ),
    );
  };

  const run = async (
    requests: readonly PartialReadonlyConsumerRequest<
      Params,
      SpecOf<RT>["id"]
    >[],
    callOptions: WrappedReadOptions = {},
    startedAt = performance.now(),
  ): Promise<(ResultEntry | Error)[]> => {
    const { signal } = callOptions;
    const batching = callOptions.autoBatch;

    // Classify every ID before dispatch. Contract failures never become slot errors.
    // Classify once per request: the result dispatches to the producer AND
    // stamps `resourceType` on the fetch/produce messages, so dispatch and
    // telemetry cannot disagree.
    const items = requests.map((input) => {
      const complete = completeRequest(input) as Request;
      const request = complete;
      const resourceType = cache.classify(request.id);
      // A classified type outside this wrapper's DECLARED coverage throws
      // BEFORE any cache read (see NoProducerForResourceTypeError's docs).
      // Skipped entirely for a bare producer, which declares no covered set
      // because it covers the whole registry.
      assertResourceTypeCovered(cache.name, covered, resourceType, request.id);

      const bypass = isRequestingCacheBypass(request.directives);
      // Keep the pending snapshot across the read. The store can snapshot a
      // miss before a write lands and removes its entry from the overlay. The
      // snapshot also retains the selected entries' write promises after the
      // shared overlay removes its records, so onStore can observe those
      // writes.
      const snapshot = (() => {
        try {
          const pending =
            !signal?.aborted &&
            !bypass &&
            !cache.closed &&
            pendingResources.has(request.id)
              ? pendingResources.matching(
                  request.id,
                  normalizeParams(
                    cache.normalizeParamName,
                    cache.normalizeParamValue,
                    complete.params,
                  ),
                )
              : [];
          const pendingLookup = classifyCacheEntries(
            pending.map(({ entry }) => entry),
            request.directives,
            new Date(),
          ).result;
          return { pending, pendingLookup, failure: undefined };
        } catch (error) {
          signal?.throwIfAborted();
          return {
            pending: [],
            pendingLookup: { validatable: [] } satisfies Lookup,
            failure: asError(error),
          };
        }
      })();

      return {
        request,
        readRequest: complete,
        resourceType,
        bypass,
        ...snapshot,
      };
    });
    // Every abort-caused rejection settles each logical request as `aborted`.
    if (signal?.aborted) {
      items.forEach((item) =>
        publishCacheFetch({
          cache: cache.name,
          resourceType: item.resourceType,
          resourceId: item.request.id,
          collapsed: false,
          disposition: "aborted",
          directivesImpliedBypass: item.bypass,
          durationMs: performance.now() - startedAt,
        }),
      );
      signal.throwIfAborted();
    }

    const eligible = items.filter(
      ({ bypass, failure }) => !bypass && failure === undefined,
    );

    // A direct known set uses one Cache call. Automatic reads settle independently
    // when their own Store invocation finishes, without a whole-set barrier.
    const directReads =
      batching?.store === false && eligible.length > 0
        ? cache.getUnbatched(
            eligible.map(({ readRequest }) => readRequest),
            signal === undefined ? {} : { signal },
          )
        : undefined;
    const readByItem = new Map(
      eligible.map((item, index) => [
        item,
        directReads === undefined
          ? cache.get(item.readRequest, signal === undefined ? {} : { signal })
          : directReads.then((results) => {
              const result = results[index]!;
              if (result instanceof Error) throw result;
              return result;
            }),
      ]),
    );

    const lookups = items.map(async (item): Promise<Lookup | Error> => {
      // Bypass requests skip the cache read entirely (see `wrapProducer`'s docs).
      if (item.bypass) return { validatable: [] };

      try {
        if (item.failure !== undefined) throw item.failure;
        const stored = await readByItem.get(item)!;
        // Stored candidates precede pending candidates. The canonical selector
        // chooses the later pending candidate when birth dates are equal.
        return mergeCacheLookups([stored, item.pendingLookup]);
      } catch (error) {
        // If the error was the signal being aborted, propagate that (as an
        // `aborted` settlement); don't assume a read failure.
        signal?.throwIfAborted();
        if (error instanceof CacheContractError) throw error;
        // For "call-producer", pretend the cache returned no results so that
        // we'll fall through to the producer.
        return onCacheReadFailure === "throw"
          ? asError(error)
          : { validatable: [] };
      }
    });

    const stores: Promise<void>[][] = items.map(() => []);
    const fetchEvents: (
      | (CacheFetchDisposition & { collapsed: boolean })
      | undefined
    )[] = items.map(() => undefined);

    type TaskOutcome = ReturnType<typeof scheduler.startOrRideTasks>[number];
    const toTaskRequest = (
      item: (typeof items)[number],
      lookup: Lookup,
      background: boolean,
    ) => ({
      request: {
        request: item.request,
        resourceType: item.resourceType,
        // The trigger labels the invocation's INITIATING cause; if this call
        // instead rides an invocation already in flight, that invocation's
        // original trigger stands.
        trigger: item.bypass
          ? ("bypass" as const)
          : lookup.usableWhileRevalidate
            ? ("revalidation" as const)
            : ("miss" as const),
      },
      // No signal for a background refresh: it is fire-and-forget work, and
      // the caller has already been given a (stale) result. So the refresh
      // never cancels a task that it starts or rides.
      ...(background ? {} : { signal }),
    });

    // A direct call to a batching scheduler sends its misses, bypass requests, and
    // stale-while-revalidate refreshes to the producer together, as one
    // invocation. allSettled waits for every lookup, so one failed lookup does
    // not drop the others from the cohort. The map holds only foreground
    // outcomes. Each foreground slot reads its own entry, and refreshes are
    // logged here because no slot awaits them.
    const directOutcomes =
      startDirect !== undefined && batching?.producer === false
        ? Promise.allSettled(lookups).then((settled) => {
            const cohort = items.flatMap((item, index) => {
              const lookup = settled[index]!;
              if (
                lookup.status === "rejected" ||
                lookup.value instanceof Error ||
                lookup.value.usable
              ) {
                return [];
              }

              const background =
                lookup.value.usableWhileRevalidate !== undefined;

              return [{ item, lookup: lookup.value, background }];
            });

            const outcomes = startDirect(
              cohort.map(({ item, lookup, background }) =>
                toTaskRequest(item, lookup, background),
              ),
            );

            return new Map(
              cohort.flatMap(({ item, background }, index) => {
                const outcome = outcomes[index]!;
                if (!background) return [[item, outcome] as const];

                logRefreshFailure(outcome);
                return [];
              }),
            );
          })
        : undefined;

    // The barrier rejects only if startDirect() throws, for example from a user key
    // function. A call whose slots are all refreshes never awaits it.
    void directOutcomes?.catch(() => {});

    const slotPipelines = items.map(
      async (item, index): Promise<ResultEntry | Error> => {
        let rode = false;
        const publish = (disposition: CacheFetchDisposition) => {
          fetchEvents[index] = { collapsed: rode, ...disposition };
        };

        const observeEntry = (entry: ResultEntry) => {
          stores[index] = item.pending
            .filter((candidate) => candidate.entry === entry)
            .map(({ stored }) => stored);
        };

        try {
          const lookup = await lookups[index]!;
          if (lookup instanceof Error) {
            publish({
              disposition: "cache-read-error",
              directivesImpliedBypass: false,
            });
            return lookup;
          }

          signal?.throwIfAborted();
          // We have ready-to-go content from the cache, w/ no refresh required.
          if (lookup.usable) {
            observeEntry(lookup.usable);
            publish({
              disposition: "served-from-cache",
              vary: lookup.usable.vary,
            });
            return lookup.usable;
          }

          // If we're here, we either don't have usable content at all, or we
          // have content that's only usable in the event of an origin error, or
          // if we make a background request to revalidate it. In any case,
          // we're gonna need to contact the origin for the result.
          //
          // TODO: Support validation requests and invalidation. How to do this
          // is actually tricker than it seems. There are questions like does
          // the validation response create a new Entry [potentially leaving the
          // old entry still there to match on other requests], or should it
          // update an existing one? [Does this mean entries need some notion of
          // an id? Who generates that?] What if the existing entry has since
          // been deleted or aged out of the store? Can the response update more
          // than one entry? Can it update things about it beyond reseting age
          // to zero (e.g., changing the producer directives)? Etc. For some
          // HTTP context, see https://tools.ietf.org/html/rfc7234#section-4.3.4
          // For invalidation, the idea would be to somehow let request A
          // passing through the producer trigger the invalidation of other
          // cached results [a la a POST invalidating a GET in HTTP], but how?
          // Call a user-provided invalidate function and pass it the just-made
          // request, the promise for its response, and the entry store, and
          // can delete entries made invalid by the request that just passed
          // through?
          if (lookup.usableWhileRevalidate) {
            // The refresh obligation survives both the stale return and later joiner cancellation.
            // The direct path starts or rides this refresh through directOutcomes,
            // so skip it here.
            if (directOutcomes === undefined) {
              const [refresh] = scheduler.startOrRideTasks([
                toTaskRequest(item, lookup, true),
              ]);
              logRefreshFailure(refresh!);
            }

            observeEntry(lookup.usableWhileRevalidate);
            publish({
              disposition: "served-stale-while-revalidating",
              vary: lookup.usableWhileRevalidate.vary,
            });
            return lookup.usableWhileRevalidate;
          }

          const outcome: TaskOutcome =
            directOutcomes !== undefined
              ? await directOutcomes.then((outcomes) => outcomes.get(item)!)
              : scheduler.startOrRideTasks([
                  toTaskRequest(item, lookup, false),
                ])[0]!;
          rode = outcome.rode;

          // The shared producer work doesn't receive the signal directly (since
          // it may be shared with other callers who haven't aborted). However,
          // we race the caller's observation of the result against the signal
          // so they can bail out immediately. Dispatched producer work keeps
          // running, and its result is still stored.
          try {
            const produced = await raceWithSignal(outcome.promise, signal);
            stores[index] = [produced.stored];
            publish({
              disposition: "served-from-producer",
              directivesImpliedBypass: item.bypass,
            });
            return produced.entry;
          } catch (error) {
            // If the error was the signal being aborted, propagate that; don't
            // treat it as a producer failure (or fall back to a cached
            // usable-if-error value).
            signal?.throwIfAborted();
            if (error instanceof CacheContractError) throw error;

            if (lookup.usableIfError) {
              logger("wrap-producer", "warn", PRODUCER_ERROR_FALLBACK_WARNING, {
                error,
                entry: lookup.usableIfError,
              });
              observeEntry(lookup.usableIfError);
              publish({
                disposition: "served-stale-after-error",
                vary: lookup.usableIfError.vary,
              });
              return lookup.usableIfError;
            }

            publish({
              disposition: "producer-error",
              directivesImpliedBypass: item.bypass,
            });
            return asError(error);
          }
        } catch (error) {
          if (signal?.aborted) {
            publish({
              disposition: "aborted",
              directivesImpliedBypass: item.bypass,
            });
            signal.throwIfAborted();
          }

          throw error;
        }
      },
    );

    slotPipelines.forEach((pipeline) => {
      pipelines.add(pipeline);
      void pipeline.finally(() => pipelines.delete(pipeline)).catch(() => {});
    });

    const results = await Promise.all(slotPipelines).catch((error: unknown) => {
      if (signal?.aborted) {
        items.forEach((item, index) =>
          publishCacheFetch({
            cache: cache.name,
            resourceType: item.resourceType,
            resourceId: item.request.id,
            collapsed: fetchEvents[index]?.collapsed ?? false,
            disposition: "aborted",
            directivesImpliedBypass: item.bypass,
            durationMs: performance.now() - startedAt,
          }),
        );
      }
      throw error;
    });
    signal?.throwIfAborted();

    items.forEach((item, index) => {
      const event = fetchEvents[index];
      if (event !== undefined) {
        publishCacheFetch({
          cache: cache.name,
          resourceType: item.resourceType,
          resourceId: item.request.id,
          ...event,
          durationMs: performance.now() - startedAt,
        });
      }
    });

    notifyStore(stores.flat(), callOptions.onStore);
    return results;
  };

  const getMany = (
    requests: readonly PartialReadonlyConsumerRequest<
      Params,
      SpecOf<RT>["id"]
    >[],
    callOptions?: WrappedReadOptions,
  ) => {
    if (closed) {
      return Promise.reject(
        new CacheContractError("Producer wrapper is closed"),
      );
    }

    // Register admission before user hooks or producer callbacks can close the client.
    const startedAt =
      callOptions !== undefined &&
      wrappedReadStartedAt in callOptions &&
      typeof callOptions[wrappedReadStartedAt] === "number"
        ? callOptions[wrappedReadStartedAt]
        : performance.now();
    const promise = Promise.resolve().then(() =>
      run(requests, callOptions, startedAt),
    );

    calls.add(promise);
    void promise.finally(() => calls.delete(promise)).catch(() => {});

    return promise;
  };

  // SAFETY: the runtime client is id-erased internally (see LooseProducer),
  // but every path upholds the per-id contract the signature promises: cache
  // reads narrow by id, and each producer's request-paired result is stamped
  // with its own request's id.
  return {
    get: async (request, callOptions) => {
      let stored: Promise<void> | undefined;
      const [result] = await getMany([request], {
        ...callOptions,
        onStore: (promise) => {
          stored = promise;
        },
      });

      if (result instanceof Error) throw result;
      if (stored !== undefined) callOptions?.onStore?.(stored);
      return result!;
    },
    getMany,
    close: () => {
      if (closing) return closing;

      closed = true;
      // Accepted calls still start or ride tasks after this point, so only flush
      // now, and close the scheduler once they finish.
      scheduler.flush();

      closing = (async () => {
        await Promise.allSettled(calls);
        await Promise.allSettled(pipelines);
        await scheduler.close();
        await Promise.allSettled(writes);
      })();

      return closing;
    },
  } as WrappedProducerClient<RT, Covered, Validators, Params>;
}
