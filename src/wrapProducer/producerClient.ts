/**
 * @fileoverview The client that both producer wrappers share:
 * `wrapSingleProducer` and `wrapBulkProducer`. It reads the cache, overlays
 * pending writes, shares and sends producer work through a
 * {@link ProducerScheduler} (producerScheduler.ts), stores produced
 * resources, and publishes diagnostics. A wrapper supplies only what
 * differs: how to call its producer, and the scheduler that sends the work.
 *
 * The client's option and result types and the runtime helpers that it needs
 * live here too, so that imports run one way: `wrapProducer` imports the
 * wrappers, which import this module, which imports none of them.
 * `wrapProducer` re-exports the public types.
 *
 * @module
 */
import { sumBy } from "es-toolkit";
import stableStringify from "safe-stable-stringify";
import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import {
  AmbiguousResourceTypeError,
  UnclassifiableIdError,
} from "../resourceTypeClassification.js";
import { UnroutableIdError } from "../producer-builders/producerByIdType.js";
import {
  cacheProduceChannel,
  publishCacheFetch,
  publishCacheProduce,
  type CacheFetchDisposition,
  type CacheProduceMessage,
} from "../diagnostics.js";
import type Cache from "../cache/Cache.js";
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
  Entry,
  EntryForId,
  Logger,
  PartialReadonlyConsumerRequest,
  ProducerResultResource,
} from "../types/index.js";
import type { CacheLookupResult } from "../utils/cacheHelpers.js";
import {
  ConcurrencyLimiter,
  PendingPromisesTracker,
} from "@zingage/scheduling";
import type {
  DispatchedRequest,
  ProducerScheduler,
  ProducerSchedulerOptions,
  SchedulerRequest,
  TaskOutcome,
} from "./producerScheduler.js";
import {
  completeRequest,
  type ReachesProducerAsIs,
  primaryNormalizedResultResourceFromRequestPairedProducerResult,
  requestPairedProducerResultToResources,
} from "./requestPairedProducerUtils.js";
import {
  asError,
  assertUnreachable,
  CacheContractError,
  defaultLoggersByComponent,
  isContractError,
  raceWithSignal,
} from "../utils/utils.js";
import type { SpecForId } from "../types/00_CacheSpec.js";
import type { LooseRequestFor, LooseResultFor } from "../types/05_Producer.js";
import { coveredTypes } from "../types/index.js";
import {
  msSince,
  performanceNow,
  type PerformanceNow,
} from "../utils/performanceNow.js";

/**
 * Thrown by the producer wrappers (not by Cache) when a request's id
 * classifies to a resource type outside the wrapper's inferred coverage.
 * Reachable only via casts or loosely-typed ids -- the wrapped function's
 * request type bans covered-set violations at compile time. Thrown BEFORE
 * any cache read: serving a hit for an uncovered type would smuggle the
 * serve-if-present contract back in through a cast.
 *
 * Only reachable when coverage was actually NARROWED -- i.e. the producer
 * came from {@link producerByIdType}/`bulkProducerByIdType` (which declare
 * their covered set), or `Covered` was pinned by an explicit type argument.
 * A bare producer function covers the whole registry by construction (its
 * parameter type must accept every registry id), so it declares no covered
 * set, the wrapper runs no coverage check, and this error cannot occur: every
 * classifiable id has a producer. Unclassifiable/ambiguous ids still fail
 * loud, from `cache.classify`.
 */
export class NoProducerForResourceTypeError extends CacheContractError {
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

/**
 * Re-throws a by-id-type helper's cache-free {@link UnroutableIdError} as the
 * cache-named error the wrapper's own pre-dispatch checks would have thrown for
 * the same id, so routing through a wrapper reports one error vocabulary
 * regardless of which layer noticed. Anything else is re-thrown untouched.
 */
export function rethrowUnroutableWithCacheName(
  cacheName: string,
  error: unknown,
): never {
  if (!(error instanceof UnroutableIdError)) {
    throw error;
  }
  const { detail } = error;
  switch (detail.reason) {
    case "uncovered": {
      throw new NoProducerForResourceTypeError({
        cacheName,
        resourceType: detail.resourceType,
        coveredResourceTypes: error.coveredResourceTypes,
        id: error.id,
      });
    }
    case "unclassifiable": {
      throw new UnclassifiableIdError({
        cacheName,
        id: error.id,
        cause: detail.cause,
      });
    }
    case "ambiguous": {
      throw new AmbiguousResourceTypeError({
        cacheName,
        id: error.id,
        matchedResourceTypes: detail.matchedResourceTypes,
      });
    }
    default: {
      return assertUnreachable(detail);
    }
  }
}

/**
 * The options that every producer wrapper takes: all of `WrapProducerOptions`
 * except `producerBatching`, which only a bulk producer uses (see
 * `BulkProducerOptions` in wrapBulkProducer.ts). The single wrapper and the
 * shared client take this type, so neither can read batch settings that do
 * not apply to it.
 */
export type ProducerClientOptions<
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
  /**
   * Maximum joining age in seconds for compatible pending work. Defaults to 3.
   *
   * Overlapping requests that would all go to the producer (because no cached
   * value satisfies them) can share one producer request. The wrapper then
   * uses that one response for all of them. A request always joins pending
   * work that still waits, in a batch or for a slot under
   * `maxConcurrentProducerCalls`. It joins work whose producer call has
   * started only when that call started no more than
   * `collapseOverlappingRequestsTime` seconds earlier. Otherwise, a new
   * request goes to the producer.
   */
  collapseOverlappingRequestsTime?: number;
  /**
   * The most producer calls that run at one time: `produce` calls, or
   * `produceMany` calls. A positive integer. Defaults to no limit.
   *
   * Work that waits for a slot stays queued, in arrival order. Other
   * requests can still join it, and it leaves the queue when every request
   * on it is cancelled. For `produceMany`, an automatic batch keeps taking
   * work until it is full, so a busy producer gets fuller batches, not more
   * calls. A call with `autoBatch.producer: false` also waits for a slot,
   * and so does a background refresh. The wait counts as queue time in the
   * `produce` message, not as producer time.
   *
   * A limit inside the producer function, for example `pLimit`, cannot do
   * this: the wrapper then counts waiting work as running.
   */
  maxConcurrentProducerCalls?: number;
  /**
   * A custom logger to use (optional).
   */
  logger?: Logger;
};

export type WrappedReadOptions = {
  signal?: AbortSignal;
  /**
   * Turns off automatic accumulation for this call, at either stage. `true`
   * is not accepted, because accumulation is already the default where the
   * stage supports it.
   *
   * - `store: false` reads the call's requests as one Store call of their
   *   own (see `ReadOptions.autoBatch` on `Cache`).
   * - `producer: false` sends the call's producer work as one `produceMany`
   *   call of its own, whatever the `producerBatching` limit. A `getMany`
   *   call first waits until all of its requests are read from the cache. A
   *   `produce` producer never accumulates, so the option changes nothing
   *   there.
   */
  autoBatch?: { store?: false; producer?: false };
  /**
   * `false` keeps this call from joining producer work whose producer call
   * has already started. Use it for a read that must see a change that the
   * caller just made, together with `maxAge: 0`: a producer call that started
   * before the change can return the old value.
   *
   * The call still joins work that waits, in a batch or for a slot, because
   * that producer call starts after this call. Later callers can join the
   * work that this call starts. Requests of one call with the same key
   * always share one task.
   */
  joinInFlight?: false;
  onStore?: OnStore;
};

/**
 * What `wrapProducer` returns. Named because the facade, both variant
 * wrappers, and the closing cast in {@link createProducerClient} all spell it,
 * and the cast is the only thing that would notice them disagreeing.
 */
export type WrappedProducerClient<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  // Generic over the request's id, so the result's content type narrows to
  // the covered spec variants compatible with that id.
  get: <Id extends IdOfResourceType<RT[Covered]>>(
    request: PartialReadonlyConsumerRequest<Params, Id>,
    options?: WrappedReadOptions,
  ) => Promise<EntryForId<SpecOf<RT>, Validators, Params, Id>>;
  // Generic over the requests' ids, so each output slot's content type narrows
  // to the covered spec variants compatible with its request's id.
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
 * Lets an outer wrapper pass its own call start time in the read options, so
 * that a fetch message's `durationMs` covers the outer wrapper's work before
 * the read.
 */
export const wrappedReadStartedAt: unique symbol = Symbol(
  "wrappedReadStartedAt",
);

/**
 * The read options that the client accepts: the public
 * {@link WrappedReadOptions}, plus the {@link wrappedReadStartedAt} key. The
 * package does not export that symbol, so only an internal wrapper can set it.
 */
export type ClientReadOptions = WrappedReadOptions & {
  readonly [wrappedReadStartedAt]?: PerformanceNow;
};

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

/** An entry as the wrappers' id-erased internals see it. */
export type LooseEntryFor<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Entry<SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>, Validators, Params>;

/** What a producer wrapper gives the shared client. */
export type ProducerBinding<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  /**
   * The wrapped producer function, as the caller passed it. The client reads
   * its declared covered set ({@link coveredTypes}).
   */
  producer: object & { readonly [coveredTypes]?: readonly string[] };
  /**
   * Calls the producer once for the given requests. It resolves with one
   * result or Error per request, in order. It must pass each request object
   * to the producer as is, never a copy; see {@link ReachesProducerAsIs}.
   */
  call: (
    requests: readonly ReachesProducerAsIs<LooseRequestFor<RT, Params>>[],
  ) => Promise<readonly (LooseResultFor<RT, Validators, Params> | Error)[]>;
  /** Builds the scheduler that shares and sends this producer's work. */
  makeScheduler: <Work, Produced>(
    options: ProducerSchedulerOptions<Work, Produced>,
  ) => ProducerScheduler<Work, Produced>;
};

/** A producer invocation's trigger, as one task reports it. */
type ProducerTrigger = Exclude<CacheProduceMessage["trigger"], "mixed">;

/**
 * What one request's slot does with its cache lookup. {@link decideSlot}
 * computes it without side effects, so the direct producer cohort and the
 * per-slot executor apply one rule.
 *
 * - `fail`: the cache read failed and `onCacheReadFailure` is `"throw"`.
 * - `serve`: a usable entry; no producer work.
 * - `serve-and-refresh`: serve a stale entry now, and refresh it in the
 *   background.
 * - `produce`: wait for the producer. `ifError` is the entry to serve if the
 *   producer fails.
 */
export type SlotDecision<E> =
  | { readonly action: "fail"; readonly error: Error }
  | { readonly action: "serve"; readonly entry: E }
  | { readonly action: "serve-and-refresh"; readonly entry: E }
  | { readonly action: "produce"; readonly ifError: E | undefined };

/** A decision that needs producer work: a refresh, or a foreground task. */
type ProducerSlotDecision<E> = Extract<
  SlotDecision<E>,
  { action: "serve-and-refresh" | "produce" }
>;

/** Decides what one slot does with its lookup. See {@link SlotDecision}. */
export function decideSlot<E>(
  lookup:
    | {
        readonly usable?: E | undefined;
        readonly usableWhileRevalidate?: E | undefined;
        readonly usableIfError?: E | undefined;
      }
    | Error,
): SlotDecision<E> {
  if (lookup instanceof Error) return { action: "fail", error: lookup };

  // We have ready-to-go content from the cache, w/ no refresh required.
  if (lookup.usable !== undefined) {
    return { action: "serve", entry: lookup.usable };
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
  if (lookup.usableWhileRevalidate !== undefined) {
    return { action: "serve-and-refresh", entry: lookup.usableWhileRevalidate };
  }

  return { action: "produce", ifError: lookup.usableIfError };
}

function needsProducer<E>(
  decision: SlotDecision<E>,
): decision is ProducerSlotDecision<E> {
  return (
    decision.action === "serve-and-refresh" || decision.action === "produce"
  );
}

/** The fetch dispositions of a slot that serves an entry it read. */
type ServedFromCacheDisposition = Extract<
  CacheFetchDisposition,
  { vary: unknown }
>["disposition"];

/**
 * What one slot settled with: its result, its fetch disposition, and the
 * write behind the served entry that `onStore` reports. `write` is undefined
 * for an entry that is already persisted, and for an Error result.
 */
type SlotRecord<E> = {
  readonly result: E | Error;
  readonly fetch: CacheFetchDisposition;
  readonly write: Promise<void> | undefined;
};

/** What the slots of one public call share. */
type CallContext = {
  readonly signal: AbortSignal | undefined;
  readonly joinInFlight: false | undefined;
};

/**
 * The scheduler request for a slot that needs producer work. The trigger
 * labels the invocation's INITIATING cause; if this request instead rides an
 * invocation already in flight, that invocation's original trigger stands.
 * A background refresh gets no signal: it is fire-and-forget work, and the
 * caller has already been given a (stale) result. So the refresh never
 * cancels a task that it starts or rides.
 */
function producerTask<Request>(
  item: {
    readonly request: Request;
    readonly resourceType: string;
    readonly bypass: boolean;
  },
  decision: ProducerSlotDecision<unknown>,
  { signal, joinInFlight }: CallContext,
): SchedulerRequest<{
  request: Request;
  resourceType: string;
  trigger: ProducerTrigger;
}> {
  const background = decision.action === "serve-and-refresh";
  return {
    request: {
      request: item.request,
      resourceType: item.resourceType,
      trigger: item.bypass ? "bypass" : background ? "revalidation" : "miss",
    },
    signal: background ? undefined : signal,
    joinInFlight,
  };
}

/**
 * The key that decides which pending task a request may ride. It covers the
 * full request (id, normalized params, directives) but not resourceType,
 * which is derived from the id and so adds nothing. It also omits the
 * trigger, so a revalidation can ride a pending miss. It names the request's
 * fields, because the request is the caller's own object (see
 * ReachesProducerAsIs) and may carry other properties.
 */
function producerTaskKey<Params>(
  request: {
    readonly id: string;
    readonly params: Params;
    readonly directives: unknown;
  },
  normalizeParams: (params: Params) => unknown,
): string | undefined {
  try {
    return stableStringify({
      id: request.id,
      params: normalizeParams(request.params),
      directives: request.directives,
    });
  } catch {
    // Failed normalization cannot prove compatibility. Preserve production
    // with original parameters, but do not share this request's work.
    return undefined;
  }
}

/**
 * Throws a {@link CacheContractError} unless the producer returned exactly
 * one defined result per request.
 *
 * A producer whose results do not line up 1:1 with the requests it was
 * given violated its contract, and the positional (result, request)
 * pairing is no longer trustworthy -- a dropped middle element would
 * silently pair later results with the wrong requests. So nothing is
 * stored and the WHOLE invocation fails: this throw rejects it, and
 * every waiting call rejects with the CacheContractError.
 *
 * The `undefined`/`null` test catches a sparse array or an explicit
 * `undefined` element hiding behind a correct `length`: neither is
 * ever a legal result -- every `RequestPairedProducerResult` is an
 * object and every error an `Error` -- so it is unambiguously a
 * contract violation, not a value a producer meant to return.
 */
function assertOneResultPerRequest(
  results: unknown,
  requestCount: number,
): void {
  const definedCount = Array.isArray(results)
    ? Array.from(results).filter(
        (result) => result !== undefined && result !== null,
      ).length
    : 0;
  if (
    !Array.isArray(results) ||
    results.length !== requestCount ||
    definedCount !== requestCount
  ) {
    throw new CacheContractError(
      `producer returned ${String(definedCount)} results for ${String(requestCount)} requests`,
    );
  }
}

/**
 * Publishes one producer invocation's `produce` message once the producer
 * settles. `results` is undefined when the producer call rejected, which
 * fails every request.
 *
 * `publish` would discard the message, but not before the argument was
 * built -- so the test has to be here, not left to the channel. The
 * argument is O(batch-size), so it is especially worth not building
 * when nobody is listening. Same reasoning as `Cache.store`.
 * `collapsedRequestCount` is read here, at settlement, so that riders
 * that joined while the producer ran count too.
 */
function publishProduce(
  cacheName: string,
  tasks: readonly DispatchedRequest<{
    readonly request: { readonly id: string };
    readonly resourceType: string;
    readonly trigger: ProducerTrigger;
  }>[],
  autoBatched: boolean,
  startedAt: PerformanceNow,
  results: readonly unknown[] | undefined,
): void {
  if (!cacheProduceChannel.hasSubscribers) return;

  const trigger = tasks[0]!.request.trigger;
  publishCacheProduce({
    cache: cacheName,
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
    collapsedRequestCount: sumBy(tasks, (task) => task.collapsedRequestCount()),
    failedRequestCount:
      results === undefined
        ? tasks.length
        : results.filter((result) => result instanceof Error).length,
    outcome: results === undefined ? "error" : "success",
    durationMs: msSince(startedAt),
  });
}

/** A refresh outlives its caller, so nobody awaits its failure. Log it instead. */
function logRefreshFailure(
  logger: Logger,
  refresh: { promise: Promise<unknown> },
): void {
  void refresh.promise.catch((error: unknown) =>
    logger(
      "wrap-producer",
      "warn",
      "error asynchronously requesting refreshed content from producer",
      error,
    ),
  );
}

/**
 * Builds a client's `get` from its `getMany`. `get` rejects with its one
 * slot's Error, and then never calls `onStore`: a caller that saw the call
 * fail has no write to observe.
 */
export function getFromGetMany<
  Request,
  Result,
  Options extends { onStore?: OnStore | undefined },
>(
  getMany: (
    requests: readonly Request[],
    options?: Options,
  ) => Promise<readonly (Result | Error)[]>,
): (request: Request, options?: Options) => Promise<Result> {
  return async (request, options) => {
    let stored: Promise<void> | undefined;
    // SAFETY: only `onStore` is replaced. Without `options`, the object holds
    // only `onStore`, which is a valid `Options` because every field of both
    // clients' read options is optional.
    const forwarded = {
      ...options,
      onStore: (promise: Promise<void>) => {
        stored = promise;
      },
    } as Options;
    const [result] = await getMany([request], forwarded);

    if (result instanceof Error) throw result;
    if (stored !== undefined) options?.onStore?.(stored);
    return result!;
  };
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
    collapseOverlappingRequestsTime = 3,
    onCacheReadFailure = "call-producer",
    logger = defaultLoggersByComponent["wrap-producer"],
  } = options;
  const covered = coveredTypeSet(producer);
  // The cache's reads also find the entries whose write is still in flight;
  // see `Cache.store`.
  const { cache } = options;

  // The client holds and sends each request as the object that
  // completeRequest returned; see ReachesProducerAsIs.
  type Request = ReachesProducerAsIs<LooseRequestFor<RT, Params>>;
  type Result = LooseResultFor<RT, Validators, Params>;
  type ResultEntry = LooseEntryFor<RT, Validators, Params>;
  type Lookup = CacheLookupResult<
    SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
    Validators,
    Params
  >;
  type Produced = { entry: ResultEntry; stored: Promise<void> };
  // Carries the classified type so the produce message can attribute each
  // request to its own type without re-classifying. The scheduler keeps the
  // Work of the request that starts a task, so the starting request's trigger
  // labels the invocation. It also keeps the starting request object alive
  // until the task settles, which a producer keyed by that object relies on
  // (see ReachesProducerAsIs). Riders reach the producer only through the
  // starter's object; an equal key means an equal request.
  type Work = {
    request: Request;
    resourceType: string;
    trigger: ProducerTrigger;
  };

  // In-flight work that close() drains, in this order: accepted calls, their
  // per-slot pipelines, the producer scheduler, then cache writes. Writes come
  // last because they outlive the call that started them. The client tracks
  // its own writes, because it does not own the cache, so it cannot close it.
  const calls = new PendingPromisesTracker();
  const pipelines = new PendingPromisesTracker();
  const writes = new PendingPromisesTracker();

  // Starts writing `resources`. Returns the write, which never rejects
  // unobserved: a failure is logged here.
  const store = (
    resources: readonly ProducerResultResource<
      SpecOf<RT>,
      Validators,
      Params
    >[],
  ): Promise<void> => {
    const stored =
      resources.length === 0
        ? Promise.resolve()
        : Promise.try(() => cache.store(resources)).then(() => {});
    void writes
      .track(stored)
      .catch((error: unknown) =>
        logger(
          "wrap-producer",
          "trace",
          "error storing producer's response",
          error,
        ),
      );
    return stored;
  };
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
  // The cache therefore holds the entries handed to store() until that write
  // settles, and every ordinary lookup merges them with the Store's
  // candidates.
  //
  // Each dispatch also publishes one `produce` diagnostics message when the
  // producer settles (one message per actual invocation; requests that
  // collapse onto it share it).
  const scheduler = makeScheduler<Work, Produced>({
    logger: options.logger,
    limiter:
      options.maxConcurrentProducerCalls === undefined ||
      options.maxConcurrentProducerCalls === Infinity
        ? undefined
        : new ConcurrencyLimiter(options.maxConcurrentProducerCalls),
    collapseTasksMs: collapseOverlappingRequestsTime * 1000,
    makeKey: ({ request }) =>
      producerTaskKey(request, (params) => cache.normalizeParams(params)),
    dispatch: async (tasks, { autoBatched }) => {
      const startedAt = performanceNow();
      let results: readonly (Result | Error)[];

      const publish = (results: readonly unknown[] | undefined) =>
        publishProduce(cache.name, tasks, autoBatched, startedAt, results);

      try {
        results = await call(tasks.map(({ request }) => request.request));

        assertOneResultPerRequest(results, tasks.length);
      } catch (error) {
        // A rejected producer call fails every request in the invocation.
        // (A bulk producer should return Error elements for per-request
        // failures instead.)
        publish(undefined);

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
            >((vary) => cache.normalizeVary(vary), result, id, now);
          return { entry, resources };
        } catch (error) {
          // Like an Error slot from the producer, a result that fails to
          // normalize fails only its own slot, even for a contract error:
          // automatic batching merges unrelated callers into one invocation.
          // The slot's own callers still reject their whole public call,
          // through the contract-error rethrow in each slot pipeline.
          return asError(error);
        }
      });

      // Published after normalization, so that a slot that fails to
      // normalize counts as failed.
      publish(prepared);

      // Extract all resources to store (main resources + supplemental
      // resources), but NOT requests that failed.
      const resources = prepared.flatMap((result) =>
        result instanceof Error ? [] : result.resources,
      );
      const stored = store(resources);

      return prepared.map((result) =>
        result instanceof Error ? result : { entry: result.entry, stored },
      );
    },
  });

  // Undefined for a scheduler whose sender never accumulates work.
  const startDirect = scheduler.startOrRideDirect?.bind(scheduler);

  // The rest of the client is a set of small steps that `get` and `getMany`
  // compose. Each call prepares its items, reads and decides each slot,
  // executes each slot with a `ProducerStarter`, and publishes each slot's
  // message. `get` runs the steps for one item, with no per-call arrays.
  // `getMany` maps them over its items. The steps are built once per client,
  // not once per call.

  /** One request of a call, prepared for its slot. */
  type Item = {
    readonly request: Request;
    readonly resourceType: string;
    readonly bypass: boolean;
    /**
     * Whether the slot's request rode a pending task. Only a slot that waits
     * for the producer sets it. It lives here, not in the slot's record,
     * because an aborted slot returns no record, but its `aborted` message
     * still reports it.
     */
    rode: boolean;
  };

  // Classify every ID before dispatch. Contract failures never become slot
  // errors. Classify once per request: the result dispatches to the producer
  // AND stamps `resourceType` on the fetch/produce messages, so dispatch and
  // telemetry cannot disagree.
  const prepare = (
    input: PartialReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>,
  ): Item => {
    const request: Request = completeRequest(input);
    const resourceType = cache.classify(request.id);
    // A classified type outside this wrapper's DECLARED coverage throws
    // BEFORE any cache read (see NoProducerForResourceTypeError's docs).
    // Skipped entirely for a bare producer, which declares no covered set
    // because it covers the whole registry.
    assertResourceTypeCovered(cache.name, covered, resourceType, request.id);

    return {
      request,
      resourceType,
      bypass: isRequestingCacheBypass(request.directives),
      rode: false,
    };
  };

  // Every abort-caused rejection settles each logical request as `aborted`,
  // whether the call was aborted before its reads or while its slots ran.
  const publishAborted = (item: Item, startedAt: PerformanceNow) => {
    publishCacheFetch({
      cache: cache.name,
      resourceType: item.resourceType,
      resourceId: item.request.id,
      collapsed: item.rode,
      disposition: "aborted",
      directivesImpliedBypass: item.bypass,
      durationMs: msSince(startedAt),
    });
  };

  const publishFetch = (
    item: Item,
    fetch: CacheFetchDisposition,
    startedAt: PerformanceNow,
  ) => {
    publishCacheFetch({
      cache: cache.name,
      resourceType: item.resourceType,
      resourceId: item.request.id,
      collapsed: item.rode,
      ...fetch,
      durationMs: msSince(startedAt),
    });
  };

  /**
   * The decision of a slot with no cached candidate: a bypass request, which
   * skips the cache read entirely (see `wrapProducer`'s docs), or a failed
   * read that falls through to the producer.
   */
  const PRODUCE_UNCACHED: SlotDecision<ResultEntry> = {
    action: "produce",
    ifError: undefined,
  };

  /** A slot's decision, or a promise for it when the slot reads the cache. */
  type Decided = SlotDecision<ResultEntry> | Promise<SlotDecision<ResultEntry>>;

  /**
   * Decides one slot from its cache read. It rejects only for an abort or a
   * contract violation, which reject the whole public call.
   */
  const decide = async (
    read: Promise<Lookup>,
    signal: AbortSignal | undefined,
  ): Promise<SlotDecision<ResultEntry>> => {
    let lookup: Lookup;
    try {
      lookup = await read;
    } catch (error) {
      // If the error was the signal being aborted, propagate that (as an
      // `aborted` settlement); don't assume a read failure.
      signal?.throwIfAborted();
      if (isContractError(error)) throw error;
      // For "call-producer", act as if the cache returned no results, so
      // that the slot falls through to the producer.
      return onCacheReadFailure === "throw"
        ? { action: "fail", error: asError(error) }
        : PRODUCE_UNCACHED;
    }
    return decideSlot(lookup);
  };

  /**
   * Reads and decides every item of a `getMany` call. Automatic reads settle
   * independently, when their own Store call finishes, with no whole-set
   * barrier. With `autoBatch.store: false`, the non-bypass items are one
   * Cache call.
   */
  const decideAll = (
    items: readonly Item[],
    callOptions: ClientReadOptions,
  ): Decided[] => {
    const { signal } = callOptions;
    if (callOptions.autoBatch?.store !== false) {
      const readOptions = { signal };
      return items.map((item) =>
        item.bypass
          ? PRODUCE_UNCACHED
          : decide(cache.get(item.request, readOptions), signal),
      );
    }

    const eligible = items.filter(({ bypass }) => !bypass);
    if (eligible.length === 0) return items.map(() => PRODUCE_UNCACHED);

    const reads = cache.getMany(
      eligible.map(({ request }) => request),
      { signal, autoBatch: false },
    );
    const eligibleIndexes = new Map(
      eligible.map((item, index) => [item, index]),
    );
    return items.map((item) => {
      const index = eligibleIndexes.get(item);
      if (index === undefined) return PRODUCE_UNCACHED;
      return decide(
        reads.then((results) => {
          const result = results[index]!;
          if (result instanceof Error) throw result;
          return result;
        }),
        signal,
      );
    });
  };

  /**
   * How a call's slots start their producer work. The slot pipeline is the
   * same for every call; only this part differs between a call whose slots
   * each start their own work and a call that sends its work together.
   */
  type ProducerStarter = {
    /** Starts or rides the task that a slot waits for. */
    produce(
      item: Item,
      decision: ProducerSlotDecision<ResultEntry>,
      call: CallContext,
    ): TaskOutcome<Produced> | Promise<TaskOutcome<Produced>>;
    /** Starts or rides a slot's background refresh, which nothing awaits. */
    refresh(
      item: Item,
      decision: ProducerSlotDecision<ResultEntry>,
      call: CallContext,
    ): void;
  };

  /** A starter whose slots each start or ride their own task with `start`. */
  const starterOver = (
    start: (
      requests: readonly SchedulerRequest<Work>[],
    ) => TaskOutcome<Produced>[],
  ): ProducerStarter => ({
    produce: (item, decision, call) =>
      start([producerTask(item, decision, call)])[0]!,
    refresh: (item, decision, call) => {
      logRefreshFailure(
        logger,
        start([producerTask(item, decision, call)])[0]!,
      );
    },
  });

  // Each slot's work goes to the scheduler's sender on its own.
  const perSlot = starterOver((requests) =>
    scheduler.startOrRideTasks(requests),
  );
  // For a `get` with `autoBatch.producer: false`: its one slot is the whole
  // call, so it needs no barrier. A scheduler that never accumulates sends
  // every task on its own already.
  const perSlotDirect =
    startDirect === undefined ? perSlot : starterOver(startDirect);

  /**
   * The starter of a `getMany` call with `autoBatch.producer: false`, on a
   * scheduler that accumulates work. It sends the call's misses, bypass
   * requests, and stale-while-revalidate refreshes to the producer together,
   * as one invocation. allSettled waits for every decision, so one failed
   * lookup does not drop the others from the cohort. The map holds only
   * foreground outcomes. Each foreground slot reads its own entry, and
   * refreshes are logged here because no slot awaits them.
   */
  const cohortStarter = (
    items: readonly Item[],
    decisions: readonly Decided[],
    call: CallContext,
    start: NonNullable<typeof startDirect>,
  ): ProducerStarter => {
    const outcomes = Promise.allSettled(
      // A bypass slot's decision is already known.
      decisions.map(async (decision) => decision),
    ).then((settled) => {
      const cohort = items.flatMap((item, index) => {
        const decision = settled[index]!;
        return decision.status === "fulfilled" && needsProducer(decision.value)
          ? [{ item, decision: decision.value }]
          : [];
      });

      const started = start(
        cohort.map(({ item, decision }) => producerTask(item, decision, call)),
      );

      return new Map(
        cohort.flatMap(({ item, decision }, index) => {
          const outcome = started[index]!;
          if (decision.action === "produce") {
            return [[item, outcome] as const];
          }

          logRefreshFailure(logger, outcome);
          return [];
        }),
      );
    });
    // The barrier rejects only if `start` throws, for example from a user key
    // function. A call whose slots are all refreshes never awaits it.
    void outcomes.catch(() => {});

    return {
      produce: async (item) => (await outcomes).get(item)!,
      // The cohort above starts or rides every refresh.
      refresh: () => {},
    };
  };

  const serve = (
    entry: ResultEntry,
    disposition: ServedFromCacheDisposition,
  ): SlotRecord<ResultEntry> => ({
    result: entry,
    fetch: { disposition, vary: entry.vary },
    write: cache.writeFor(entry),
  });

  /**
   * Carries out one slot's decision: starts or rides producer work through
   * `starter`, races it against the caller's signal, and applies the
   * if-error fallback. It returns what the slot served, its fetch
   * disposition, and the write that `onStore` reports, so that no branch has
   * to record them itself.
   */
  const executeSlot = async (
    item: Item,
    decision: SlotDecision<ResultEntry>,
    starter: ProducerStarter,
    call: CallContext,
  ): Promise<SlotRecord<ResultEntry>> => {
    switch (decision.action) {
      case "fail": {
        return {
          result: decision.error,
          fetch: {
            disposition: "cache-read-error",
            directivesImpliedBypass: false,
          },
          write: undefined,
        };
      }
      case "serve": {
        return serve(decision.entry, "served-from-cache");
      }
      case "serve-and-refresh": {
        // The refresh obligation survives both the stale return and later
        // joiner cancellation.
        starter.refresh(item, decision, call);
        return serve(decision.entry, "served-stale-while-revalidating");
      }
      case "produce": {
        // Await only a starter that is asynchronous, so that a slot that
        // starts its own work does so in this same turn.
        const started = starter.produce(item, decision, call);
        const outcome = started instanceof Promise ? await started : started;
        item.rode = outcome.rode;

        // The shared producer work doesn't receive the signal directly (since
        // it may be shared with other callers who haven't aborted). However,
        // we race the caller's observation of the result against the signal
        // so they can bail out immediately. Dispatched producer work keeps
        // running, and its result is still stored.
        try {
          const produced = await raceWithSignal(outcome.promise, call.signal);
          return {
            result: produced.entry,
            fetch: {
              disposition: "served-from-producer",
              directivesImpliedBypass: item.bypass,
            },
            write: produced.stored,
          };
        } catch (error) {
          // If the error was the signal being aborted, propagate that; don't
          // treat it as a producer failure (or fall back to a cached
          // usable-if-error value).
          call.signal?.throwIfAborted();
          if (isContractError(error)) throw error;

          if (decision.ifError) {
            logger("wrap-producer", "warn", PRODUCER_ERROR_FALLBACK_WARNING, {
              error,
              entry: decision.ifError,
            });
            return serve(decision.ifError, "served-stale-after-error");
          }

          return {
            result: asError(error),
            fetch: {
              disposition: "producer-error",
              directivesImpliedBypass: item.bypass,
            },
            write: undefined,
          };
        }
      }
      default: {
        return assertUnreachable(decision);
      }
    }
  };

  /** One slot's whole pipeline: wait for its decision, then execute it. */
  const settleSlot = async (
    item: Item,
    decision: Decided,
    starter: ProducerStarter,
    call: CallContext,
  ): Promise<SlotRecord<ResultEntry>> => {
    const decided = await decision;
    call.signal?.throwIfAborted();
    return executeSlot(item, decided, starter, call);
  };

  /** `get`: the slot pipeline for one item. It rejects with its slot's Error. */
  const runOne = async (
    input: PartialReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>,
    callOptions: ClientReadOptions,
    startedAt: PerformanceNow,
  ): Promise<ResultEntry> => {
    const { signal } = callOptions;
    const call: CallContext = {
      signal,
      joinInFlight: callOptions.joinInFlight,
    };
    const item = prepare(input);

    let record: SlotRecord<ResultEntry>;
    try {
      signal?.throwIfAborted();
      const decision = item.bypass
        ? PRODUCE_UNCACHED
        : decide(
            cache.get(
              item.request,
              callOptions.autoBatch?.store === false
                ? { signal, autoBatch: false }
                : { signal },
            ),
            signal,
          );
      const slot = settleSlot(
        item,
        decision,
        callOptions.autoBatch?.producer === false ? perSlotDirect : perSlot,
        call,
      );
      void pipelines.track(slot);
      record = await slot;
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) publishAborted(item, startedAt);
      throw error;
    }

    publishFetch(item, record.fetch, startedAt);
    // A caller that saw the call fail has no write to observe.
    if (record.result instanceof Error) throw record.result;
    if (callOptions.onStore !== undefined) {
      notifyStore(
        record.write === undefined ? [] : [record.write],
        callOptions.onStore,
      );
    }
    return record.result;
  };

  /** `getMany`: the slot pipeline for each item. Operational failures stay in their slots. */
  const runMany = async (
    inputs: readonly PartialReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>[],
    callOptions: ClientReadOptions,
    startedAt: PerformanceNow,
  ): Promise<(ResultEntry | Error)[]> => {
    const { signal } = callOptions;
    const call: CallContext = {
      signal,
      joinInFlight: callOptions.joinInFlight,
    };
    const items = inputs.map(prepare);
    const publishAllAborted = () => {
      items.forEach((item) => {
        publishAborted(item, startedAt);
      });
    };
    if (signal?.aborted) {
      publishAllAborted();
      signal.throwIfAborted();
    }

    const decisions = decideAll(items, callOptions);
    const starter =
      startDirect !== undefined && callOptions.autoBatch?.producer === false
        ? cohortStarter(items, decisions, call, startDirect)
        : perSlot;
    const slots = items.map((item, index) =>
      settleSlot(item, decisions[index]!, starter, call),
    );
    slots.forEach((slot) => {
      void pipelines.track(slot);
    });

    let records: SlotRecord<ResultEntry>[];
    try {
      records = await Promise.all(slots);
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) publishAllAborted();
      throw error;
    }

    records.forEach(({ fetch }, index) => {
      publishFetch(items[index]!, fetch, startedAt);
    });
    notifyStore(
      records.flatMap(({ write }) => (write === undefined ? [] : [write])),
      callOptions.onStore,
    );
    return records.map(({ result }) => result);
  };

  /**
   * Admits one public call. It registers the call before user hooks or
   * producer callbacks can close the client.
   */
  const admit = <T>(
    callOptions: ClientReadOptions | undefined,
    run: (
      callOptions: ClientReadOptions,
      startedAt: PerformanceNow,
    ) => Promise<T>,
  ): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new CacheContractError("Producer wrapper is closed"),
      );
    }

    const startedAt = callOptions?.[wrappedReadStartedAt] ?? performanceNow();
    return calls.run(() => run(callOptions ?? NO_READ_OPTIONS, startedAt));
  };

  // SAFETY: the runtime client is id-erased internally (see LooseProducer in types/05_Producer.ts),
  // but every path upholds the per-id contract the signature promises: cache
  // reads narrow by id, and each producer's request-paired result is stamped
  // with its own request's id.
  return {
    get: (
      request: PartialReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>,
      callOptions?: ClientReadOptions,
    ) =>
      admit(callOptions, (options, startedAt) =>
        runOne(request, options, startedAt),
      ),
    getMany: (
      requests: readonly PartialReadonlyConsumerRequest<
        Params,
        SpecOf<RT>["id"]
      >[],
      callOptions?: ClientReadOptions,
    ) =>
      admit(callOptions, (options, startedAt) =>
        runMany(requests, options, startedAt),
      ),
    close: () => {
      if (closing) return closing;

      closed = true;
      // Accepted calls still start or ride tasks after this point, so only flush
      // now, and close the scheduler once they finish.
      scheduler.flush();

      closing = (async () => {
        await calls.drain();
        await pipelines.drain();
        await scheduler.close();
        await writes.drain();
      })();

      return closing;
    },
  } as WrappedProducerClient<RT, Covered, Validators, Params>;
}

/** The options of a call that passed none. */
const NO_READ_OPTIONS: ClientReadOptions = {};
