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
 * The diagnostics channel for cache result events.
 * @internal
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

type TypedChannel<T, Name extends string> = Omit<
  Channel,
  "publish" | "subscribe"
> & {
  publish(message: T): void;
  subscribe(callback: (message: T, name: Name) => void): void;
};
