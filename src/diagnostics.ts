import type { Channel } from "node:diagnostics_channel";
import * as diagnosticsChannel from "node:diagnostics_channel";
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

type TypedChannel<T, Name extends string> = Omit<
  Channel,
  "publish" | "subscribe" | "unsubscribe"
> & {
  publish(message: T): void;
  subscribe(callback: (message: T, name: Name) => void): void;
  unsubscribe(callback: (message: T, name: Name) => void): boolean;
};
