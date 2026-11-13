/**
 * @fileoverview The public producer wrapper and its types. `wrapProducer`
 * checks which capability the caller passed, and delegates to
 * `wrapSingleProducer` or `wrapBulkProducer`. Both build on
 * `createProducerClient` (producerClient.ts).
 *
 * @module
 */
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import {
  type IdOfResourceType,
  type ResourceTypeName,
  type ResourceTypes,
  type SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  CoveringBulkProducer,
  CoveringProducer,
  EntryForId,
  Logger,
  PartialReadonlyConsumerRequest,
} from "../types/index.js";
import type { BatchOptions } from "../batcher/batcher.js";
import type { OnStore } from "./producerClient.js";
import { wrapBulkProducer } from "./wrapBulkProducer.js";
import { wrapSingleProducer } from "./wrapSingleProducer.js";

export {
  assertResourceTypeCovered,
  coveredTypeSet,
  isRequestingCacheBypass,
  notifyStore,
  PRODUCER_ERROR_FALLBACK_WARNING,
  producerRequestLease,
  wrappedReadStartedAt,
  type OnStore,
} from "./producerClient.js";

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
> = ProducerClientOptions<RT, Validators, Params> & {
  /**
   * Bulk accumulation settings; default limit 20. The limit applies only to
   * accumulated work. Does not change participation. Only a `produceMany`
   * producer accepts it, because a single producer never batches.
   *
   * Automatic batches run concurrently, with no limit: a wrapped `getMany`
   * of 1,000 misses makes 50 concurrent `produceMany` calls at the default
   * limit. To limit concurrent producer calls, wrap the producer itself, for
   * example with `pLimit`.
   */
  producerBatching?: BatchOptions;
};

/**
 * The {@link WrapProducerOptions} that every producer wrapper takes: all of
 * them except `producerBatching`, which only a bulk producer uses. The single
 * wrapper and the shared client take this type, so neither can read batch
 * settings that do not apply to it.
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
   * uses that one response for all of them. A request joins pending work only
   * when that work started no more than `collapseOverlappingRequestsTime`
   * seconds earlier. Otherwise, a new request goes to the producer.
   */
  collapseOverlappingRequestsTime?: number;
  /**
   * A custom logger to use (optional).
   */
  logger?: Logger;
};

export type WrappedReadOptions = {
  signal?: AbortSignal;
  autoBatch?: { store?: false; producer?: false };
  onStore?: OnStore;
};

/**
 * What {@link wrapProducer} returns. Named because the facade, both variant
 * wrappers, and the closing cast in `createProducerClient` (producerClient.ts)
 * all spell it, and the cast is the only thing that would notice them
 * disagreeing.
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
 * ## Bypass requests skip the cache read
 *
 * When the consumer's directives could never be satisfied by cached data
 * (`maxAge: 0`), the wrapper does not read the cache at all. This
 * structurally guarantees producer contact. It closes the age-≤0/clock-skew
 * hole, where a same-millisecond or future-dated entry has age ≤ 0 and would
 * satisfy `maxAge: 0` from cache. Bypass requests also do not pollute the
 * `read` channel. Bypass requests still collapse (only with
 * identical-directive peers, because the collapse key includes directives),
 * and their results are still stored.
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
 * The signal is forwarded to the cache read, so the store read can be
 * aborted. If the signal fires before the cache read completes, the call
 * throws without contacting the producer. No signal reaches the producer,
 * because one producer invocation may serve other callers who have not
 * aborted. Producers accordingly take no `options` parameter at all (see
 * `ResourceTypeProducer`). The caller's wait for the producer result is
 * instead raced against the signal, so the caller can bail out immediately.
 * Bailing out does not prevent the result of dispatched work from being
 * stored, so that work is never wasted. The trade-off is that the producer
 * cannot observe the signal to cancel its own in-progress work (for example,
 * an outgoing HTTP request).
 *
 * Produced values return before their writes finish. Eligible primary and
 * supplemental resources remain in this wrapper's pending-write overlay until
 * persistence settles. Each ordinary lookup merges Store candidates with a
 * retained pending snapshot using canonical freshness and variant rules.
 * Newer persisted candidates can win; equal birth dates prefer pending entries.
 * The overlay models all eligible candidates, not the Store's retained subset.
 * It never survives a settled write and does not cross wrapper/process borders.
 * A failed write never fails the call: the wrapper logs and drops it. The
 * failed write is never pinned, so the next call reads the store, misses, and
 * runs the producer again.
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
 *
 * @param options - The cache to wrap, the wrapping behavior (see
 *   {@link WrapProducerOptions}), and exactly one producer: `produce` or
 *   `produceMany`. The producer is the function actually responsible for
 *   returning the results that will be sent to the user and/or stored in the
 *   cache. It acts as the origin for every resource type it covers. It is
 *   passed the request (id and params) along with the caller's cache
 *   directives, which it may need if it is itself backed by a cache and must
 *   decide whether to contact its origin. `produceMany` is passed an array of
 *   requests and must return one result (or Error) per request, in the same
 *   order. Pass a bare function to cover the whole registry, or the result of
 *   {@link producerByIdType} or {@link bulkProducerByIdType} to cover a subset
 *   with one sub-producer per resource type.
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
          // A single-request producer never batches.
          producerBatching?: never;
        }
      | {
          produce?: never;
          produceMany: CoveringBulkProducer<RT, Covered, Validators, Params>;
        }
    ),
): WrappedProducerClient<RT, Covered, Validators, Params> {
  if (options.produce !== undefined) {
    return wrapSingleProducer<RT, Covered, Validators, Params>(
      options,
      options.produce,
    );
  }
  if (options.produceMany !== undefined) {
    return wrapBulkProducer<RT, Covered, Validators, Params>(
      options,
      options.produceMany,
    );
  }
  // Unreachable through the types, but an untyped caller can pass neither.
  throw new TypeError(
    "wrapProducer: pass exactly one of `produce` and `produceMany`",
  );
}
