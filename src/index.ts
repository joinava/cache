import {
  age,
  birthDate,
  isFresh,
  isValidatable,
} from "./utils/normalizedProducerResultResourceHelpers.js";

export { default as Cache } from "./Cache.js";
export { default as MemoryStore } from "./stores/MemoryStore/MemoryStore.js";
export { default as PostgresStore } from "./stores/PostgresStore/PostgresStore.js";
export type { PostgresStoreSupportedParams } from "./stores/PostgresStore/PostgresStore.js";
export * from "./types/index.js";
export { default as collapsedTaskCreator } from "./utils/collapsedTaskCreator.js";
export { naiveGetMany } from "./utils/utils.js";
export { wrapBulkProducer } from "./utils/wrapBulkProducer.js";
export { default as wrapProducer } from "./utils/wrapProducer.js";
export type { CacheResultOutcome } from "./utils/wrapProducer.js";

// Diagnostics channel for cache result events
export { cacheResultChannel, type CacheResultMessage } from "./diagnostics.js";

export const entryUtils = { birthDate, age, isValidatable, isFresh };

// These are functions that Store authors will likely want to use to implement
// support for variants in their stores.
export {
  requestVariantKeyForVaryKeys,
  resultVariantKey,
  variantMatchesRequest,
} from "./utils/varyHelpers.js";
export type { VariantKey, VaryKeys } from "./utils/varyHelpers.js";
