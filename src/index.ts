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
  type CacheOptions,
  type ReadOptions,
  type SingleTypeCacheOptionsBuilder,
  type SingleTypeRegistry,
} from "./Cache.js";
export type { CacheLookupResult } from "./utils/cacheHelpers.js";
export { default as MemoryStore } from "./stores/MemoryStore/MemoryStore.js";
export { default as PostgresStore } from "./stores/PostgresStore/PostgresStore.js";
export type {
  PostgresStoreCompatibleSpec,
  PostgresStoreSupportedParams,
} from "./stores/PostgresStore/PostgresStore.js";
export {
  default as SqliteStore,
  type SqliteStoreCompatibleSpec,
  type SqliteStoreSupportedParams,
} from "./stores/SqliteStore/SqliteStore.js";
export {
  classifyIdAgainst,
  idStartsWith,
  resourceType,
  resourceTypesEntries,
  type IdClassification,
  type ResourceTypesEntries,
} from "./resourceTypeClassification.js";
export * from "./types/index.js";
export { default as collapsedTaskCreator } from "./scheduling/collapsedTaskCreator.js";
export { restoreInfinityInDirectives } from "./utils/normalization.js";
export { throwIfAnyError } from "./utils/utils.js";
export type { JsonOf, JSONWithUndefined } from "type-party";
export { jsonParse, jsonStringify } from "type-party/runtime/json.js";
export { NoProducerForResourceTypeError } from "./wrapProducer/producerClient.js";
export {
  bulkHashedInputProducerByInputType,
  hashedInputProducerByInputType,
  type BulkHashedInputProducerBuilder,
  type HashedInputProducer,
  type HashedInputProducerBuilder,
  type HashedInputVariant,
} from "./producer-builders/hashedInputProducerByInputType.js";
export {
  producerByIdType,
  UnroutableIdError,
  type ProducersFor,
  type UnroutableIdReason,
} from "./producer-builders/producerByIdType.js";
export {
  bulkProducerByIdType,
  type BulkProducersFor,
} from "./producer-builders/bulkProducerByIdType.js";

export {
  MintedIdResourceTypeMismatchError,
  wrapHashedInputProducer,
  type HashedInputProducerResult,
} from "./wrapProducer/wrapHashedInputProducer.js";
export {
  default as wrapProducer,
  type WrappedProducerClient,
  type WrappedReadOptions,
  type WrapProducerOptions,
} from "./wrapProducer/wrapProducer.js";

// Diagnostics channels
export {
  CACHE_FETCH_CHANNEL_NAME,
  cacheFetchChannel,
  type CacheFetchDisposition,
  type CacheFetchMessage,
  CACHE_PRODUCE_CHANNEL_NAME,
  cacheProduceChannel,
  type CacheProduceMessage,
  CACHE_READ_STORE_CHANNEL_NAME,
  cacheReadStoreChannel,
  type CacheReadStoreMessage,
  CACHE_READ_CHANNEL_NAME,
  cacheReadChannel,
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

export type { OnStore } from "./wrapProducer/wrapProducer.js";
