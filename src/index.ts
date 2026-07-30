import {
  age,
  birthDate,
  isFresh,
  isValidatable,
} from "./utils/normalizedProducerResultResourceHelpers.js";

export {
  AmbiguousResourceTypeError,
  default as Cache,
  singleTypeCacheOptions,
  UnclassifiableIdError,
  type CacheLookupResult,
  type CacheOptions,
} from "./Cache.js";
export { default as MemoryStore } from "./stores/MemoryStore/MemoryStore.js";
export { default as PostgresStore } from "./stores/PostgresStore/PostgresStore.js";
export type { PostgresStoreSupportedParams } from "./stores/PostgresStore/PostgresStore.js";
export {
  default as SqliteStore,
  type SqliteStoreCompatibleSpec,
  type SqliteStoreSupportedParams,
} from "./stores/SqliteStore/SqliteStore.js";
export * from "./types/index.js";
export { default as collapsedTaskCreator } from "./utils/collapsedTaskCreator.js";
export { restoreInfinityInDirectives } from "./utils/normalization.js";
export type { PartialConsumerRequest } from "./utils/requestPairedProducerUtils.js";
export { naiveGetMany } from "./utils/utils.js";
export type { JsonOf } from "type-party";
export { jsonParse, jsonStringify } from "type-party/runtime/json.js";
export {
  bulkProducerByIdType,
  wrapBulkProducer,
  type BulkProducersFor,
  type BulkResourceTypeProducer,
  type CoveringBulkProducer,
} from "./utils/wrapBulkProducer.js";
export {
  coveredTypes,
  default as wrapProducer,
  NoProducerForResourceTypeError,
  producerByIdType,
  type CoveringProducer,
  type ProducersFor,
  type ResourceTypeProducer,
  type WrapProducerOptions,
} from "./utils/wrapProducer.js";
export {
  wrapBulkComputingProducer,
  wrapComputingProducer,
  type ComputingBranch,
  type ComputingProducerResult,
} from "./utils/wrapComputingProducer.js";

// Diagnostics channels
export {
  CACHE_FETCH_CHANNEL_NAME,
  cacheFetchChannel,
  type CacheFetchMessage,
  CACHE_PRODUCE_CHANNEL_NAME,
  cacheProduceChannel,
  type CacheProduceMessage,
  CACHE_READ_CHANNEL_NAME,
  cacheReadChannel,
  type CacheReadFound,
  type CacheReadMessage,
  CACHE_STORE_ENTRY_CHANNEL_NAME,
  cacheStoreEntryChannel,
  type CacheStoreEntryMessage,
  type TypedChannel,
} from "./diagnostics.js";

export const entryUtils = { birthDate, age, isValidatable, isFresh };

// These are functions that Store authors will likely want to use to implement
// support for variants in their stores.
export {
  requestVariantKeyForVaryKeys,
  resultVariantKey,
  variantMatchesRequest,
} from "./utils/varyHelpers.js";
export type { VariantKey, VaryKeys } from "./utils/varyHelpers.js";
