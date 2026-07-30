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
  type SingleTypeCacheOptionsBuilder,
} from "./Cache.js";
export { default as MemoryStore } from "./stores/MemoryStore/MemoryStore.js";
export { default as PostgresStore } from "./stores/PostgresStore/PostgresStore.js";
export type { PostgresStoreSupportedParams } from "./stores/PostgresStore/PostgresStore.js";
export {
  default as SqliteStore,
  type SqliteStoreCompatibleSpec,
  type SqliteStoreSupportedParams,
} from "./stores/SqliteStore/SqliteStore.js";
export {
  classifyIdAgainst,
  idStartsWith,
  registryEntries,
  resourceType,
  type IdClassification,
  type ResourceTypesEntries,
} from "./resourceTypeClassification.js";
export * from "./types/index.js";
export { default as collapsedTaskCreator } from "./utils/collapsedTaskCreator.js";
export { restoreInfinityInDirectives } from "./utils/normalization.js";
export type { PartialConsumerRequest } from "./utils/requestPairedProducerUtils.js";
export { naiveGetMany } from "./utils/utils.js";
export type { JsonOf } from "type-party";
export { jsonParse, jsonStringify } from "type-party/runtime/json.js";
export {
  NoProducerForResourceTypeError,
  UnroutableIdError,
  type UnroutableIdReason,
} from "./utils/producer-errors.js";
export {
  bulkHashedInputProducerByInputType,
  hashedInputProducerByInputType,
  type BulkHashedInputProducerBuilder,
  type HashedInputProducer,
  type HashedInputProducerBuilder,
  type HashedInputVariant,
} from "./utils/hashedInputProducerByInputType.js";
export { producerByIdType } from "./utils/producerByIdType.js";
export {
  bulkProducerByIdType,
  type BulkProducersFor,
  type BulkResourceTypeProducer,
} from "./utils/bulkProducerByIdType.js";
export {
  wrapBulkProducer,
  type CoveringBulkProducer,
} from "./utils/wrapBulkProducer.js";
export {
  MintedIdResourceTypeMismatchError,
  wrapBulkHashedInputProducer,
  wrapHashedInputProducer,
  type HashedInputProducerResult,
} from "./utils/wrapHashedInputProducer.js";
export {
  coveredTypes,
  default as wrapProducer,
  type CoveringProducer,
  type ProducersFor,
  type ResourceTypeProducer,
  type WrapProducerOptions,
} from "./utils/wrapProducer.js";

// Diagnostics channels
export {
  CACHE_FETCH_CHANNEL_NAME,
  cacheFetchChannel,
  type CacheFetchDisposition,
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
