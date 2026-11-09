import type { BulkResourceTypeProducer } from "./bulkProducerByIdType.js";
import type { ReadBatchOptions } from "./storeReadBatcher.js";
import stableStringify from "safe-stable-stringify";
import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import {
  NoProducerForResourceTypeError,
  rethrowUnroutableWithCacheName,
} from "./producer-errors.js";
import {
  cacheProduceChannel,
  publishCacheFetch,
  publishCacheProduce,
  type CacheFetchDisposition,
} from "../diagnostics.js";
import type { SpecForId } from "../types/00_CacheSpec.js";
import {
  type IdOfResourceType,
  type ResourceTypeName,
  type ResourceTypes,
  type SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ReadonlyConsumerRequest,
  Entry,
  EntryForId,
  Logger,
  RequestPairedProducerResult,
  Vary,
  PartialReadonlyConsumerRequest,
} from "../types/index.js";
import { createProducerScheduler } from "./collapsedTaskCreator.js";
import { normalizeParams, normalizeVary } from "./normalization.js";
import { PendingResources } from "./pendingResources.js";
import {
  classifyCacheEntries,
  mergeCacheLookups,
  type CacheLookupResult,
} from "./cacheHelpers.js";
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

/** Internal input ownership hook for hashed producer scheduling. */
export const wrappedReadStartedAt: unique symbol = Symbol(
  "wrappedReadStartedAt",
);
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
 * Everything the producer wrappers need besides the producer itself, as one
 * bag. The cache is a FIELD rather than a separate positional argument because
 * a wrapper is always "this cache, wrapped this way": the two were never
 * independently meaningful, and splitting them left every call site passing
 * `undefined` in the middle just to reach the producer.
 */
export type WrapProducerOptions<
  RT extends ResourceTypes,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = {
  /**
   * REQUIRED. An instance of the cache class. This is where values returned by
   * the producer will actually be stored, and it is the inference site for
   * `RT`/`Validators`/`Params` (see {@link Cache.resourceTypes} for why a
   * bare-`RT` member is needed for that at all).
   */
  cache: PublicInterface<Cache<RT, Validators, Params>>;
  /**
   * Operational cache read failures call the producer by default. "throw"
   * returns an Error slot instead; scalar calls reject. Cancellation and
   * package contract violations never use this fallback. A cache outage can
   * multiply origin load: a 95% hit rate becomes 20 times as much production.
   * Choose this policy against the origin's capacity and load shedding.
   */
  onCacheReadFailure?: "throw" | "call-producer";
  /** Maximum joining age in seconds for compatible pending work. Defaults to 3. */
  collapseOverlappingRequestsTime?: number;
  /**
   * A custom logger to use (optional).
   */
  logger?: Logger;
  /**
   * Bulk accumulation settings; default limit 20. The limit applies only to
   * accumulated work. Does not change participation.
   */
  producerBatching?: ReadBatchOptions;
};

/**
 * A producer over some set of resource types: it sees exactly those types' ids
 * and returns results stamped with them. Used at both scales -- with a single
 * `K` it is a {@link producerByIdType} sub-producer (which sees only its own
 * branch's ids), and with a whole covered set it is the function half of
 * {@link CoveringProducer}, which is what the wrappers take.
 *
 * Each request remains valid when reordered, split, or shared with other calls.
 * Producers receive original parameters; normalization promises equivalent behavior.
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
  req: ReadonlyConsumerRequest<Params, IdOfResourceType<RT[K]>>,
) => Promise<
  RequestPairedProducerResult<
    SpecOf<RT>,
    Validators,
    Params,
    IdOfResourceType<RT[K]>
  >
>;

/**
 * {@link producerByIdType}'s argument: one entry per covered resource type,
 * any non-empty subset of the registry. `Covered` is inferred from the
 * record's keys. Non-coverage is expressed by omission, so a wrapper never has
 * to make claims about types that other wrappers may produce.
 */
export type ProducersFor<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  readonly [K in Covered]: ResourceTypeProducer<RT, K, Validators, Params>;
};

/**
 * The key under which a producer function declares WHICH resource types it
 * covers. A real runtime symbol carrying a real runtime value (see
 * {@link CoveringProducer}), not a type-only phantom: the wrappers read it to
 * enforce coverage, and it is exported so declaration emit can name it.
 */
export const coveredTypes: unique symbol = Symbol(
  "@zingage/cache.coveredTypes",
);

/**
 * A producer function that may additionally declare WHICH resource types it
 * covers. The property carries a real runtime value -- the covered type names
 * -- so it serves double duty: `Covered` is inferred from it at compile time,
 * and the wrapper reads it at runtime to enforce coverage before touching the
 * store. A value-less phantom would leave the wrapper with no runtime source for
 * the covered set, since there are no record keys to read.
 *
 * ## Why the property is conditionally required
 *
 * It is optional when `Covered` is the whole registry -- that is what lets a
 * bare function be passed with no ceremony, and no runtime check is needed
 * there because the compiler already made the function prove it accepts every
 * registry id. It is REQUIRED when `Covered` is a strict subset, which makes
 * "narrowed coverage implies runtime proof of that narrowing" an invariant the
 * type system enforces rather than a convention.
 *
 * That requirement is what keeps coverage from having two sources that can
 * disagree. You might expect an explicit `Covered` type argument
 * (`wrapProducer<RT, "story">(...)`) to be enough to narrow coverage; it is
 * rejected precisely because it would narrow the TYPES while leaving the runtime
 * covered set absent, which the wrapper reads as "the whole registry". The types
 * still ban uncovered ids at the call site, so the gap is only reachable by
 * defeating them (a cast or a loosely-typed id -- see
 * {@link NoProducerForResourceTypeError}), but that is exactly the case that
 * error exists to catch: instead of throwing, the wrapper would hand the id to a
 * producer written for a different resource type and then store its content
 * under the incoming id. Routing partial coverage through
 * {@link producerByIdType}, which always supplies the runtime value, makes the
 * declared set and the reachable producers one and the same by construction.
 *
 * `Covered` still infers from the property even though it also appears in the
 * condition (probed, along with the deferred case where `Covered` is an
 * unresolved generic -- how the hashed-input wrappers forward theirs).
 *
 * Narrowing each result's `Id` to `IdOfResourceType<RT[Covered]>` bounds the
 * PRIMARY result to covered types only. Supplementals are unaffected: they are
 * a separate field typed over the full `SpecOf<RT>`, so a covered producer can
 * still attach supplementals for any registry type.
 */
export type CoveringProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = ResourceTypeProducer<RT, Covered, Validators, Params> &
  CoveredTypesCarrier<RT, Covered>;

/**
 * The conditionally-required {@link coveredTypes} carrier: optional when
 * `Covered` is the whole registry, REQUIRED when it is a strict subset. Shared
 * by {@link CoveringProducer} and its bulk counterpart so the two cannot drift
 * -- relaxing one to always-optional would reopen the hole described on
 * `CoveringProducer` for that wrapper alone.
 *
 * The tuple brackets make this a whole-set comparison rather than a
 * distributive, member-by-member one.
 */
export type CoveredTypesCarrier<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
> = [ResourceTypeName<RT>] extends [Covered]
  ? { readonly [coveredTypes]?: readonly Covered[] }
  : { readonly [coveredTypes]: readonly Covered[] };

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

/**
 * Snapshots a producer's declared covered set for the coverage check: a `Set`
 * for membership testing, insertion-ordered so the error message can still
 * list the names in their declared order, and a copy so a post-wrap mutation
 * of the caller's array can't widen (or otherwise change) coverage later.
 * `undefined` means the producer declared nothing, which (see
 * {@link CoveringProducer}) means it covers the whole registry: there is no
 * covered set to enumerate and nothing to check.
 */
export function coveredTypeSet(producer: {
  readonly [coveredTypes]?: readonly string[];
}): ReadonlySet<string> | undefined {
  const declared = producer[coveredTypes];
  return declared === undefined ? undefined : new Set(declared);
}

/**
 * The write side of the coverage contract: what `producerByIdType` and
 * `bulkProducerByIdType` throw when handed an empty record. Shared so the two
 * helpers can't word the same refusal differently, and kept next to the read
 * side ({@link coveredTypeSet}) because both are statements about where a
 * declared covered set comes from.
 */
export function emptyProducersRecordMessage(
  helper: "producerByIdType" | "bulkProducerByIdType",
  wrapper: "wrapProducer",
): string {
  return (
    `${helper}: \`producers\` must be a record with one entry per covered ` +
    `resource type and cannot be empty. (A producer that covers the whole ` +
    `registry needs no helper: pass the function itself to ${wrapper}.)`
  );
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
 * What {@link wrapProducer} returns. Named because it is spelled both in the
 * signature and in the closing cast, far enough apart to drift, and the cast is
 * the only thing that would notice them disagreeing.
 */
export type WrappedReadOptions = {
  signal?: AbortSignal;
  autoBatch?: { store?: false; producer?: false };
  onStore?: OnStore;
};

export type WrappedProducerClient<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  get: <Id extends IdOfResourceType<RT[Covered]>>(
    request: PartialReadonlyConsumerRequest<Params, Id>,
    options?: WrappedReadOptions,
  ) => Promise<EntryForId<SpecOf<RT>, Validators, Params, Id>>;
  getMany: <
    const Requests extends readonly PartialReadonlyConsumerRequest<
      Params,
      IdOfResourceType<RT[Covered]>
    >[],
  >(
    requests: Requests,
    options?: WrappedReadOptions,
  ) => Promise<{
    -readonly [K in keyof Requests]:
      | EntryForId<
          SpecOf<RT>,
          Validators,
          Params,
          Extract<Requests[K]["id"], SpecOf<RT>["id"]>
        >
      | Error;
  }>;
  close: () => Promise<void>;
};

/**
 * Logged by both wrappers when a producer failure is absorbed by the request's
 * own if-error entry. Shared so a rewording can't land in one wrapper only,
 * leaving operators grepping for two different strings for one event.
 */
export const PRODUCER_ERROR_FALLBACK_WARNING =
  "error calling producer; falling back to a cached value, as permitted";

/** The always-unreachable tail of a wrapper's abort path. */
export function throwUnreachableAbort(signal: AbortSignal | undefined): never {
  signal?.throwIfAborted();
  // Unreachable: only called after observing `signal.aborted`.
  throw new Error("unreachable: throwAborted called without an aborted signal");
}

/**
 * Wrap one producer capability and return a client with get, getMany, and close.
 * Bare callbacks cover the whole registry. Typed dispatch helpers can declare
 * partial coverage; classification and coverage checks run before Store reads.
 * Supplemental resources may target any registered type without adding slots.
 *
 * Producer requests must be independent. Results must remain valid when work
 * is reordered, split, deduplicated, or combined with other requests. Producers
 * perform side-effect-free reads. maxAge: 0 skips cache lookup and requires
 * production; storeFor: 0 prevents retention of a produced resource.
 *
 * Single producers dispatch promptly. Bulk producers accumulate ready work by
 * default, separately from Store accumulation. autoBatch.producer: false waits
 * for classification of the known set. It then sends the call's misses,
 * bypass requests, and stale refreshes to the producer as one invocation,
 * whatever the producerBatching limit.
 * A direct caller can also dispatch compatible queued work immediately.
 *
 * Sharing covers pending requests within collapseOverlappingRequestsTime.
 * Compatibility uses normalized parameters and directives. Producers receive
 * original parameters, whose behavior must be equivalent under normalization.
 * Failed normalization cannot establish sharing; permitted read-failure
 * fallback produces independently with the original parameters.
 *
 * Cancellation removes unused queued participation. It never aborts shared
 * dispatched work or an accepted background refresh. Bulk operational failures
 * remain positional Errors; scalar reads reject their Error slot. Cancellation
 * and package contract violations reject the complete public call.
 *
 * Produced values return before their writes finish. Eligible primary and
 * supplemental resources remain in this wrapper's pending-write overlay until
 * persistence settles. Each ordinary lookup merges Store candidates with a
 * retained pending snapshot using canonical freshness and variant rules.
 * Newer persisted candidates can win; equal birth dates prefer pending entries.
 * The overlay models all eligible candidates, not the Store's retained subset.
 * It never survives a settled write and does not cross wrapper/process borders.
 *
 * onStore observes every foreground write before reporting the first failure
 * in request order. Pending hits and stale fallbacks observe the selected
 * entry's original write. Stale returns exclude their background refresh.
 * A successful foreground refresh observes its new write instead.
 *
 * Close clients before their Cache and externally owned dependencies. close()
 * rejects new calls, flushes queues, and drains accepted pipelines, background
 * refreshes, and writes. It takes no timeout and does not replay operation errors.
 * Await onStore separately when successful persistence matters.
 */
export default function wrapProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT> = ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  options: WrapProducerOptions<RT, Validators, Params> &
    (
      | {
          produce: CoveringProducer<RT, Covered, Validators, Params>;
          produceMany?: never;
        }
      | {
          produce?: never;
          produceMany: CoveringBulkProducer<RT, Covered, Validators, Params>;
        }
    ),
): WrappedProducerClient<RT, Covered, Validators, Params> {
  const {
    cache,
    collapseOverlappingRequestsTime = 3,
    onCacheReadFailure = "call-producer",
    logger = defaultLoggersByComponent["wrap-producer"],
  } = options;
  const single = options.produce;
  const bulk = options.produceMany;
  if (
    (typeof single === "function") === (typeof bulk === "function") ||
    (single !== undefined && typeof single !== "function") ||
    (bulk !== undefined && typeof bulk !== "function")
  ) {
    throw new CacheContractError(
      "wrapProducer requires exactly one of produce or produceMany",
    );
  }
  if (
    options.producerBatching !== undefined &&
    (options.producerBatching === null ||
      typeof options.producerBatching !== "object")
  ) {
    throw new CacheContractError("producerBatching must be a settings object");
  }
  const producer = single ?? bulk!;
  const covered = coveredTypeSet(producer);
  type Request = LooseRequestFor<RT, Params>;
  type Result = LooseResultFor<RT, Validators, Params>;
  type ResultEntry = LooseEntryFor<RT, Validators, Params>;
  type Lookup = LooseLookupResultFor<RT, Validators, Params>;
  type Produced = { entry: ResultEntry; stored: Promise<void> };
  type Work = { request: Request; resourceType: string };
  // Classification and coverage checks prove this erasure before dispatch.
  const produceOne = single as
    | LooseProducer<RT, Validators, Params>
    | undefined;
  const produceMany = bulk as
    | LooseBulkProducer<RT, Validators, Params, Error>
    | undefined;
  const normalizeVaryBound = (vary: Vary<Params>) =>
    normalizeVary(cache.normalizeParamName, cache.normalizeParamValue, vary);
  const pendingResources = new PendingResources<SpecOf<RT>, Validators, Params>(
    normalizeVaryBound,
  );
  const writes = new Set<Promise<void>>();
  const calls = new Set<Promise<unknown>>();
  const pipelines = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const scheduler = createProducerScheduler<Work, Produced>({
    bulk: bulk !== undefined,
    ...options.producerBatching,
    collapseTasksMs: collapseOverlappingRequestsTime * 1000,
    key: ({ request }) => {
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
    retain: ({ request }) => {
      if (
        producerRequestLease in producer &&
        typeof producer[producerRequestLease] === "function"
      ) {
        return producer[producerRequestLease](request.id);
      }
      return () => {};
    },
    dispatch: async (tasks) => {
      const startedAt = performance.now();
      let results: readonly (Result | Error)[];
      const common = {
        operation:
          bulk === undefined ? ("produce" as const) : ("produceMany" as const),
        automatic: tasks[0]!.automatic,
        requestCount: tasks.length,
        queueWaitTotalMs: tasks.reduce(
          (sum, task) => sum + task.queueWaitMs,
          0,
        ),
        trigger: tasks.every((task) => task.trigger === tasks[0]!.trigger)
          ? tasks[0]!.trigger
          : ("mixed" as const),
      };
      try {
        results =
          produceMany !== undefined
            ? await produceMany(tasks.map(({ request }) => request.request))
            : [await produceOne!(tasks[0]!.request.request)];
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
        const contractFailure = results.find(
          (result) => result instanceof CacheContractError,
        );
        if (contractFailure instanceof CacheContractError)
          throw contractFailure;
      } catch (error) {
        if (cacheProduceChannel.hasSubscribers)
          publishCacheProduce({
            cache: cache.name,
            ...common,
            requests: tasks.map(({ request }) => ({
              resourceType: request.resourceType,
              resourceId: request.request.id,
            })),
            collapsedCallerCount: new Set(
              tasks.flatMap((task) => [...task.attachedCallers()]),
            ).size,
            operationFailed: true,
            failedRequestCount: tasks.length,
            outcome: "error",
            durationMs: performance.now() - startedAt,
          });
        rethrowUnroutableWithCacheName(cache.name, error);
      }
      if (cacheProduceChannel.hasSubscribers)
        publishCacheProduce({
          cache: cache.name,
          ...common,
          requests: tasks.map(({ request }) => ({
            resourceType: request.resourceType,
            resourceId: request.request.id,
          })),
          collapsedCallerCount: new Set(
            tasks.flatMap((task) => [...task.attachedCallers()]),
          ).size,
          operationFailed: false,
          failedRequestCount: results.filter(
            (result) => result instanceof Error,
          ).length,
          outcome: "success",
          durationMs: performance.now() - startedAt,
        });
      // One physical write retains batching for a producer invocation's resources.
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
          if (error instanceof CacheContractError) throw error;
          return asError(error);
        }
      });
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
    const caller = {};
    const batching = callOptions.autoBatch;
    if (
      batching !== undefined &&
      (batching === null ||
        typeof batching !== "object" ||
        (batching.store !== undefined && batching.store !== false) ||
        (batching.producer !== undefined && batching.producer !== false))
    ) {
      throw new CacheContractError(
        "autoBatch accepts only { store?: false, producer?: false }",
      );
    }
    // Classify every ID before dispatch. Contract failures never become slot errors.
    const items = requests.map((input) => {
      const complete = completeRequest(input) as Request;
      const request = complete;
      const resourceType = cache.classify(request.id);
      assertResourceTypeCovered(cache.name, covered, resourceType, request.id);
      const bypass = isRequestingCacheBypass(request.directives);
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
        ? cache.getMany(
            eligible.map(({ readRequest }) => readRequest),
            { ...(signal === undefined ? {} : { signal }), autoBatch: false },
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
      if (item.bypass) return { validatable: [] };
      try {
        if (item.failure !== undefined) throw item.failure;
        const stored = await readByItem.get(item)!;
        return mergeCacheLookups([stored, item.pendingLookup]);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof CacheContractError) throw error;
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
    type Attachment = ReturnType<typeof scheduler.attach>[number];
    const attach = (
      item: (typeof items)[number],
      lookup: Lookup,
      background: boolean,
    ) => ({
      request: { request: item.request, resourceType: item.resourceType },
      trigger: item.bypass
        ? ("bypass" as const)
        : lookup.usableWhileRevalidate
          ? ("revalidation" as const)
          : ("miss" as const),
      background,
      caller,
      ...(background ? {} : { signal }),
    });
    // A direct bulk call sends its misses, bypass requests, and
    // stale-while-revalidate refreshes to the producer together, as one
    // invocation. allSettled waits for every lookup, so one failed lookup does
    // not drop the others from the cohort. The map holds only foreground
    // attachments. Each foreground slot reads its own entry, and refreshes are
    // logged here because no slot awaits them.
    const directAttachments =
      bulk !== undefined && batching?.producer === false
        ? Promise.allSettled(lookups).then((settled) => {
            const cohort = items.flatMap((item, index) => {
              const lookup = settled[index]!;
              if (
                lookup.status === "rejected" ||
                lookup.value instanceof Error ||
                lookup.value.usable
              )
                return [];
              const background =
                lookup.value.usableWhileRevalidate !== undefined;
              // After a cancel, leave out foreground requests: attach() would
              // throw on their aborted signal and drop the whole cohort,
              // refreshes included. With no cancel, this filter does nothing.
              if (!background && signal?.aborted) return [];
              return [{ item, lookup: lookup.value, background }];
            });
            const attachments = scheduler.attach(
              cohort.map(({ item, lookup, background }) =>
                attach(item, lookup, background),
              ),
              false,
            );
            return new Map(
              cohort.flatMap(({ item, background }, index) => {
                const attachment = attachments[index]!;
                if (!background) return [[item, attachment] as const];
                logRefreshFailure(attachment);
                return [];
              }),
            );
          })
        : undefined;
    // The barrier rejects only if attach() throws, for example from a user key
    // function. A call whose slots are all refreshes never awaits it.
    void directAttachments?.catch(() => {});
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
          if (lookup.usable) {
            observeEntry(lookup.usable);
            publish({
              disposition: "served-from-cache",
              vary: lookup.usable.vary,
            });
            return lookup.usable;
          }
          if (lookup.usableWhileRevalidate) {
            // The refresh obligation survives both the stale return and later joiner cancellation.
            // The direct path attaches this refresh through directAttachments,
            // so skip it here.
            if (directAttachments === undefined) {
              const [refresh] = scheduler.attach(
                [attach(item, lookup, true)],
                true,
              );
              logRefreshFailure(refresh!);
            }
            observeEntry(lookup.usableWhileRevalidate);
            publish({
              disposition: "served-stale-while-revalidating",
              vary: lookup.usableWhileRevalidate.vary,
            });
            return lookup.usableWhileRevalidate;
          }
          // The cohort leaves out foreground requests after a cancel, so check
          // the signal before reading this slot's entry.
          const attachment: Attachment =
            directAttachments !== undefined
              ? await directAttachments.then((attachments) => {
                  signal?.throwIfAborted();
                  return attachments.get(item)!;
                })
              : scheduler.attach([attach(item, lookup, false)], true)[0]!;
          rode = attachment.rode;
          try {
            const produced = await raceWithSignal(attachment.promise, signal);
            stores[index] = [produced.stored];
            publish({
              disposition: "served-from-producer",
              directivesImpliedBypass: item.bypass,
            });
            return produced.entry;
          } catch (error) {
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
      if (signal?.aborted)
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
      throw error;
    });
    signal?.throwIfAborted();
    items.forEach((item, index) => {
      const event = fetchEvents[index];
      if (event !== undefined)
        publishCacheFetch({
          cache: cache.name,
          resourceType: item.resourceType,
          resourceId: item.request.id,
          ...event,
          durationMs: performance.now() - startedAt,
        });
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
    if (closed)
      return Promise.reject(
        new CacheContractError("Producer wrapper is closed"),
      );
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
      scheduler.flush();
      closing = (async () => {
        await Promise.allSettled(calls);
        await Promise.allSettled(pipelines);
        await scheduler.drain();
        await Promise.allSettled(writes);
      })();
      return closing;
    },
  } as WrappedProducerClient<RT, Covered, Validators, Params>;
}

export function isRequestingCacheBypass(
  dirs: ReadonlyDeep<ConsumerDirectives>,
) {
  return dirs.maxAge === 0;
}
