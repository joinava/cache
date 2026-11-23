/**
 * @fileoverview The public producer wrapper. `wrapProducer` checks which
 * capability the caller passed, and delegates to `wrapSingleProducer` or
 * `wrapBulkProducer`. Both build on `createProducerClient`
 * (producerClient.ts), which also defines the client's types; this module
 * re-exports the public ones.
 *
 * @module
 */
import {
  type ResourceTypeName,
  type ResourceTypes,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  CoveringBulkProducer,
  CoveringProducer,
} from "../types/index.js";
import type { WrappedProducerClient } from "./producerClient.js";
import {
  wrapBulkProducer,
  type BulkProducerOptions,
} from "./wrapBulkProducer.js";
import { wrapSingleProducer } from "./wrapSingleProducer.js";

export type {
  OnStore,
  ProducerClientOptions,
  WrappedProducerClient,
  WrappedReadOptions,
} from "./producerClient.js";

/**
 * Everything the producer wrappers need besides the producer itself, as one
 * bag. The cache is a FIELD rather than a separate positional argument because
 * a wrapper is always "this cache, wrapped this way": the two were never
 * independently meaningful, and splitting them left every call site passing
 * `undefined` in the middle just to reach the producer.
 *
 * This is the widest options type, the one a bulk producer takes. The
 * `wrapProducer` signature forbids `producerBatching` with `produce`.
 */
export type WrapProducerOptions<
  RT extends ResourceTypes,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = BulkProducerOptions<RT, Validators, Params>;

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
 * default, separately from Store accumulation. autoBatch.producer: false
 * skips that accumulation wait for the call's misses, bypass requests, and
 * stale refreshes. Each request's work is ready as soon as its own cache read
 * settles, and reaches the producer in calls of at most the producerBatching
 * limit, which can also carry other callers' ready work.
 * Such a caller also makes compatible queued work ready immediately.
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
