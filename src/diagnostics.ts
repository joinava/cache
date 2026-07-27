import type { Channel } from "node:diagnostics_channel";
import * as diagnosticsChannel from "node:diagnostics_channel";
import type { AnyParams } from "./types/01_Params.js";
import type { AnyValidators } from "./types/02_Validators.js";
import type { Vary } from "./types/04_ProducerResult.js";
import type { StoreEntryRelationship } from "./types/06_Store.js";
import type { CacheResultOutcome } from "./utils/wrapProducer.js";

/**
 * The name of the diagnostics channel used for cache result events.
 * Subscribe to this channel to receive cache hit/miss notifications.
 *
 * @example
 * ```ts
 * import { subscribe } from "node:diagnostics_channel";
 * import { CACHE_RESULT_CHANNEL_NAME, type CacheResultMessage } from "@zingage/cache";
 *
 * subscribe(CACHE_RESULT_CHANNEL_NAME, (message: CacheResultMessage) => {
 *   console.log(`Cache ${message.cacheName}: ${message.outcome} for key ${message.cacheKey}`);
 * });
 * ```
 */
export const CACHE_RESULT_CHANNEL_NAME = "@zingage/cache:result";

/**
 * The message type published to the cache result diagnostics channel.
 */
export type CacheResultMessage = {
  /** The name of the cache (passed via `cacheName` option to wrapProducer/wrapBulkProducer) */
  cacheName: string | undefined;
  /** The outcome of the cache lookup */
  outcome: CacheResultOutcome;
  /** The cache key (id) for the request */
  cacheKey: string;
};

/**
 * The diagnostics channel for cache result events. Subscribe with
 * `cacheResultChannel.subscribe((message) => …)` for an inferred
 * `CacheResultMessage`, or by name via `CACHE_RESULT_CHANNEL_NAME`.
 */
export const cacheResultChannel = diagnosticsChannel.channel(
  CACHE_RESULT_CHANNEL_NAME,
) as TypedChannel<CacheResultMessage, typeof CACHE_RESULT_CHANNEL_NAME>;

/**
 * Publishes a cache result event to the diagnostics channel.
 * @internal
 */
export function publishCacheResult(message: CacheResultMessage): void {
  cacheResultChannel.publish(message);
}

/**
 * Name of the diagnostics channel that fires when normalization silently drops
 * an optional producer directive because it contained an invalid value (e.g.
 * `NaN`). Subscribers can use these events to surface producer-side bugs that
 * would otherwise be invisible.
 *
 * Note: this channel does NOT fire when a required directive is invalid
 * (e.g. `freshUntilAge: NaN`); those cases throw instead.
 */
export const DROPPED_DIRECTIVE_CHANNEL_NAME = "@zingage/cache:dropped-directive";

/**
 * The message type published to the dropped-directive diagnostics channel.
 */
export type DroppedDirectiveMessage = {
  /**
   * Which optional producer directive was dropped. For `maxStale`, the whole
   * object is dropped even if only one of its fields was invalid, because a
   * `maxStale` with a missing threshold is not meaningful.
   */
  directive: "storeFor" | "maxStale";
  /** Why the directive was dropped. */
  reason: "contains-NaN";
};

/**
 * The diagnostics channel for dropped-directive events. Subscribe with
 * `droppedDirectiveChannel.subscribe((message) => …)` for an inferred
 * `DroppedDirectiveMessage`, or by name via `DROPPED_DIRECTIVE_CHANNEL_NAME`.
 */
export const droppedDirectiveChannel = diagnosticsChannel.channel(
  DROPPED_DIRECTIVE_CHANNEL_NAME,
) as TypedChannel<
  DroppedDirectiveMessage,
  typeof DROPPED_DIRECTIVE_CHANNEL_NAME
>;

/**
 * Publishes a dropped-directive event to the diagnostics channel.
 * @internal
 */
export function publishDroppedDirective(
  message: DroppedDirectiveMessage,
): void {
  droppedDirectiveChannel.publish(message);
}

/**
 * Name of the diagnostics channel that fires once per stored entry for which
 * the store reported how the entry's value relates to what was already stored
 * for the same `(id, vary)` slot (see {@link StoreEntryRelationship}). No
 * event fires for entries where the store omitted the check (or the entry had
 * empty validators, in which case there's nothing to compare on).
 *
 * Subscribers can use these events to, e.g., observe how often cached data is
 * actually changing at the origin.
 */
export const STORE_ENTRY_RESULT_CHANNEL_NAME =
  "@zingage/cache:store-entry-result";

/**
 * The message type published to the store-entry-result diagnostics channel.
 */
export type StoreEntryResultMessage = {
  /** The stored entry's resource id */
  id: string;
  /** The stored entry's (normalized) vary object */
  vary: Vary<AnyParams>;
  /** The stored entry's validators, on which the comparison was keyed */
  validators: Partial<AnyValidators>;
  /** How the entry's value relates to what the slot previously held */
  relationshipToExistingStoredData: StoreEntryRelationship;
};

/**
 * The diagnostics channel for store-entry-result events. Subscribe with
 * `storeEntryResultChannel.subscribe((message) => …)` for an inferred
 * `StoreEntryResultMessage`, or by name via
 * `STORE_ENTRY_RESULT_CHANNEL_NAME`.
 */
export const storeEntryResultChannel = diagnosticsChannel.channel(
  STORE_ENTRY_RESULT_CHANNEL_NAME,
) as TypedChannel<
  StoreEntryResultMessage,
  typeof STORE_ENTRY_RESULT_CHANNEL_NAME
>;

/**
 * Publishes a store-entry-result event to the diagnostics channel.
 * @internal
 */
export function publishStoreEntryResult(
  message: StoreEntryResultMessage,
): void {
  storeEntryResultChannel.publish(message);
}

type TypedChannel<T, Name extends string> = Omit<
  Channel,
  "publish" | "subscribe" | "unsubscribe"
> & {
  publish(message: T): void;
  subscribe(callback: (message: T, name: Name) => void): void;
  unsubscribe(callback: (message: T, name: Name) => void): boolean;
};
