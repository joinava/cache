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
export {
  default as SqliteStore,
  type SqliteStoreCompatibleSpec,
  type SqliteStoreSupportedParams,
} from "./stores/SqliteStore/SqliteStore.js";
export * from "./types/index.js";
export { default as collapsedTaskCreator } from "./utils/collapsedTaskCreator.js";
export {
  idStartsWith,
  producerByIdType,
  type ProducerBranch,
  type ProducerByIdTypeBuilder,
} from "./utils/producerByIdType.js";
export { restoreInfinityInDirectives } from "./utils/normalization.js";
export { naiveGetMany } from "./utils/utils.js";
export { wrapBulkProducer } from "./utils/wrapBulkProducer.js";
export { default as wrapProducer } from "./utils/wrapProducer.js";
export type { CacheResultOutcome } from "./utils/wrapProducer.js";
export {
  computingProducerByInputType,
  type ComputingProducerByInputTypeBuilder,
  type ComputingVariant,
  type ComputingVariantSupplemental,
  type ContentForVariants,
  type InputForVariants,
} from "./utils/computingProducerByInputType.js";
export {
  wrapBulkComputingProducer,
  wrapComputingProducer,
} from "./utils/wrapComputingProducer.js";

// Diagnostics channels
export {
  CACHE_RESULT_CHANNEL_NAME,
  cacheResultChannel,
  type CacheResultMessage,
  DROPPED_DIRECTIVE_CHANNEL_NAME,
  droppedDirectiveChannel,
  type DroppedDirectiveMessage,
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
