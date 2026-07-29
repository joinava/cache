import type { Channel } from "node:diagnostics_channel";
import * as diagnosticsChannel from "node:diagnostics_channel";
import type { AnyParams } from "./types/01_Params.js";
import type { AnyValidators } from "./types/02_Validators.js";
import type { Vary } from "./types/04_ProducerResult.js";
import type { StoreEntryRelationship } from "./types/06_Store.js";

/**
 * @fileoverview The package's diagnostics channels. There are four:
 *
 * - `@zingage/cache:read` -- what did a cache lookup find? Published by
 *   `Cache.get`/`Cache.getMany` (including direct callers that never touch a
 *   wrapper).
 * - `@zingage/cache:fetch` -- how was a logical wrapped-producer request
 *   answered? Published by the producer wrappers, once per call of the
 *   wrapped function (per request element, for bulk), at settlement.
 * - `@zingage/cache:produce` -- one message per actual producer invocation
 *   (foreground misses AND background revalidations). Producer latency and
 *   error rate live here.
 * - `@zingage/cache:store-entry` -- one message per entry passed to
 *   `Cache.store()`.
 *
 * Every message carries the same two attribution fields ({@link Attribution};
 * `produce` carries them per element of `requests[]` instead): the cache
 * instance's `name` and the resource-type name from the cache's registry.
 *
 * ## Why `fetch` and `produce` are two channels, not one
 *
 * They are the two spans of the same story with different subjects and
 * cardinalities: a `fetch` is the consumer-side span (one per logical
 * request); a `produce` is the origin-side span (one per producer
 * invocation). They relate many-to-one in two ways -- request collapsing (N
 * callers ride 1 invocation; inlining invocation stats into fetch messages
 * would republish them once per rider, weighting producer error/latency
 * metrics by rider count) and bulk batching (one invocation covers
 * `requests[]`) -- and are temporally decoupled in two ways: a
 * stale-while-revalidate revalidation settles *after* its triggering fetch
 * event already shipped, and an `aborted` fetch settles *before* its
 * invocation does (the collapsed producer call keeps running and stores in
 * the background). The durations also mean different things:
 * `produce.durationMs` is invocation time, while any fetch-level duration
 * would be caller wait (riders wait less than the invocation took).
 */

/**
 * The attribution fields shared by every diagnostics message.
 */
type Attribution = {
  /** Cache instance name (constructor `options.name`). */
  cache: string;
  /** Resource-type name from the cache's registry (`cache.classify(id)`). */
  resourceType: string;
};

/**
 * A `diagnostics_channel` {@link Channel} whose publish/subscribe sides are
 * typed to a specific message shape.
 */
export type TypedChannel<T, Name extends string> = Omit<
  Channel,
  "publish" | "subscribe" | "unsubscribe"
> & {
  publish(message: T): void;
  subscribe(callback: (message: T, name: Name) => void): void;
  unsubscribe(callback: (message: T, name: Name) => void): boolean;
};

/**
 * Name of the diagnostics channel that fires once per cache lookup --
 * i.e., once per `Cache.get()` call and once per request in a
 * `Cache.getMany()` call -- reporting what the lookup found.
 *
 * Wrapper requests with bypass directives (`maxAge: 0`) never appear here:
 * they skip the cache read entirely. A read that itself **fails** (the store
 * threw) emits no message either -- the error propagates
 * (`Cache.get`/`getMany` reject).
 */
export const CACHE_READ_CHANNEL_NAME = "@zingage/cache:read";

/**
 * The message type published to the read diagnostics channel.
 */
export type CacheReadMessage = Attribution & {
  resourceId: string;
  /**
   * What the lookup found, evaluated against the request's directives:
   * - "usable":                  satisfiable from cache alone
   * - "usable-while-revalidate": only usable if paired with a background refresh
   * - "usable-if-error":         only usable as a producer-failure fallback
   * - "none":                    nothing this request could use
   * (Reserved for future conditional revalidation: entries that are merely
   * `validatable` report "none" today.)
   */
  found: "usable" | "usable-while-revalidate" | "usable-if-error" | "none";
};

/**
 * The diagnostics channel for read events. Subscribe with
 * `cacheReadChannel.subscribe((message) => …)` for an inferred
 * `CacheReadMessage`, or by name via `CACHE_READ_CHANNEL_NAME`.
 */
export const cacheReadChannel = diagnosticsChannel.channel(
  CACHE_READ_CHANNEL_NAME,
) as TypedChannel<CacheReadMessage, typeof CACHE_READ_CHANNEL_NAME>;

/**
 * Publishes a read event to the diagnostics channel.
 * @internal
 */
export function publishCacheRead(message: CacheReadMessage): void {
  cacheReadChannel.publish(message);
}

/**
 * Name of the diagnostics channel that fires once per call of a wrapped
 * producer function (per request element, for the bulk wrappers), at
 * settlement, reporting how the logical request was answered.
 *
 * Sole exception: a cache-read failure under `onCacheReadFailure: "throw"`
 * rethrows before any disposition exists and emits nothing.
 */
export const CACHE_FETCH_CHANNEL_NAME = "@zingage/cache:fetch";

/**
 * The message type published to the fetch diagnostics channel.
 */
export type CacheFetchMessage = Attribution & {
  resourceId: string;
  /**
   * True if this request rode an already-in-flight producer call. In the base
   * (not the union) because it doesn't co-vary with the bypass flag: e.g.
   * `served-stale-after-error` can be collapsed (a rider on a failed shared
   * invocation falling back to its own if-error entry) but never bypassed.
   */
  collapsed: boolean;
} & (
    | {
        // Dispositions reachable only via a cache read -- which bypass
        // requests skip entirely, making this branch sound by construction
        // rather than statistically. (Without skip-read, `maxAge: 0` can be
        // satisfied: age is a ms-resolution float compared with strict `>`,
        // so a same-millisecond entry has age 0 ≤ 0, and cross-pod clock skew
        // makes age *negative* -- the producer-stamped `date` is the birth
        // basis.)
        disposition:
          | "served-from-cache" // 1.6.0 "hit"
          | "served-stale-while-revalidating" // 1.6.0 "stale_while_revalidate"
          | "served-stale-after-error"; // NEW (stale-if-error; invisible in 1.6.0)
        directivesImpliedBypass?: false;
      }
    | {
        disposition:
          | "served-from-producer" // 1.6.0 "miss" / "bypass"
          | "producer-error" // NEW (nothing servable; error propagated)
          | "aborted"; // NEW (caller's signal fired first)
        /**
         * True iff the consumer's directives forced producer contact
         * regardless of cache contents (`isRequestingCacheBypass`:
         * `maxAge: 0`). A pure request property -- and any of these three
         * dispositions can be bypass-triggered (the producer trip can fail
         * or be abandoned). Lets hit-rate dashboards separate bypass traffic
         * from real misses.
         */
        directivesImpliedBypass: boolean;
      }
  );

/**
 * The diagnostics channel for fetch events. Subscribe with
 * `cacheFetchChannel.subscribe((message) => …)` for an inferred
 * `CacheFetchMessage`, or by name via `CACHE_FETCH_CHANNEL_NAME`.
 */
export const cacheFetchChannel = diagnosticsChannel.channel(
  CACHE_FETCH_CHANNEL_NAME,
) as TypedChannel<CacheFetchMessage, typeof CACHE_FETCH_CHANNEL_NAME>;

/**
 * Publishes a fetch event to the diagnostics channel.
 * @internal
 */
export function publishCacheFetch(message: CacheFetchMessage): void {
  cacheFetchChannel.publish(message);
}

/**
 * Name of the diagnostics channel that fires once per actual producer
 * invocation, when the invocation settles -- foreground misses AND
 * background revalidations (whose outcome is invisible on the fetch channel,
 * arriving after the triggering fetch event already shipped).
 */
export const CACHE_PRODUCE_CHANNEL_NAME = "@zingage/cache:produce";

/**
 * The message type published to the produce diagnostics channel.
 */
export type CacheProduceMessage = {
  cache: string;
  /**
   * Why the producer was contacted -- the invocation's INITIATING cause.
   * Bypass never mixes with the other two (the collapse key includes the
   * request's directives, so a `maxAge: 0` caller and a plain-miss caller
   * never share an invocation), but miss and revalidation callers use
   * identical directives and CAN share one: a same-key miss arriving while a
   * revalidation is in flight rides it (and vice versa) without re-labeling
   * the trigger.
   */
  trigger: "miss" | "revalidation" | "bypass";
  /**
   * The requests this invocation covered. Length 1 except for bulk producers
   * (which batch within one resource type, so all elements share
   * resourceType).
   */
  requests: readonly { resourceType: string; resourceId: string }[];
  /** Logical callers that rode this invocation via request collapsing. */
  collapsedCallerCount: number;
  outcome: "success" | "error";
  durationMs: number;
};

/**
 * The diagnostics channel for produce events. Subscribe with
 * `cacheProduceChannel.subscribe((message) => …)` for an inferred
 * `CacheProduceMessage`, or by name via `CACHE_PRODUCE_CHANNEL_NAME`.
 */
export const cacheProduceChannel = diagnosticsChannel.channel(
  CACHE_PRODUCE_CHANNEL_NAME,
) as TypedChannel<CacheProduceMessage, typeof CACHE_PRODUCE_CHANNEL_NAME>;

/**
 * Publishes a produce event to the diagnostics channel.
 * @internal
 */
export function publishCacheProduce(message: CacheProduceMessage): void {
  cacheProduceChannel.publish(message);
}

/**
 * Name of the diagnostics channel that fires once per entry passed to
 * `Cache.store()`, reporting how the entry's value relates to what was
 * already stored for the same `(id, vary)` slot (see
 * {@link StoreEntryRelationship}) -- or `undefined` when the store didn't
 * report a relationship for the entry.
 *
 * Attribution comes from classifying the entry's own id -- which is what
 * makes supplemental writes and direct `Cache.store()` calls correctly
 * attributed with no name threading.
 *
 * Subscribers can use these events to, e.g., observe how often cached data is
 * actually changing at the origin.
 */
export const CACHE_STORE_ENTRY_CHANNEL_NAME = "@zingage/cache:store-entry";

/**
 * The message type published to the store-entry diagnostics channel.
 */
export type CacheStoreEntryMessage = Attribution & {
  /** The stored entry's resource id */
  resourceId: string;
  /** The stored entry's (normalized) vary object */
  vary: Vary<AnyParams>;
  /** The stored entry's validators, on which the comparison was keyed */
  validators: Partial<AnyValidators>;
  /**
   * How the entry's value relates to what the slot previously held (see
   * {@link StoreEntryRelationship}, unchanged), or `undefined` when the store
   * didn't report a relationship for this entry (it didn't perform the
   * check, the entry had empty validators so there was nothing to compare
   * on, or the entry was an in-call duplicate that lost to a newer entry for
   * the same slot and so was never persisted).
   */
  relationshipToExistingStoredData: StoreEntryRelationship | undefined;
};

/**
 * The diagnostics channel for store-entry events. Subscribe with
 * `cacheStoreEntryChannel.subscribe((message) => …)` for an inferred
 * `CacheStoreEntryMessage`, or by name via `CACHE_STORE_ENTRY_CHANNEL_NAME`.
 */
export const cacheStoreEntryChannel = diagnosticsChannel.channel(
  CACHE_STORE_ENTRY_CHANNEL_NAME,
) as TypedChannel<CacheStoreEntryMessage, typeof CACHE_STORE_ENTRY_CHANNEL_NAME>;

/**
 * Publishes a store-entry event to the diagnostics channel.
 * @internal
 */
export function publishCacheStoreEntry(message: CacheStoreEntryMessage): void {
  cacheStoreEntryChannel.publish(message);
}
