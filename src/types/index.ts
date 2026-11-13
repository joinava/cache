// The files in this directory hold types defining the contract between the
// various components that make up the caching system, plus the runtime values
// those types key on (`coveredTypes`, `components`).
//
// Those that are meant to be public are re-exported below.
export type { CacheSpec, ContentForId, SpecForId } from "./00_CacheSpec.js";
export type {
  ContentOfResourceType,
  IdOfResourceType,
  ResourceTypeName,
  ResourceTypes,
  ResourceTypeSpec,
  SpecOf,
} from "./00_ResourceTypes.js";
export type { AnyParams, AnyParamValue } from "./01_Params.js";
export type { AnyValidators } from "./02_Validators.js";
export type {
  ConsumerDirectives,
  ConsumerMaxStale,
  ReadonlyConsumerRequest,
  PartialReadonlyConsumerRequest,
} from "./03_ConsumerRequest.js";
export type {
  ProducerDirectives,
  ProducerMaxStale,
  ProducerResult,
  ProducerResultResource,
  ProducerResultResourceForId,
  ProducerResultResourceObject,
  Vary,
} from "./04_ProducerResult.js";
export {
  coveredTypes,
  type BulkResourceTypeProducer,
  type CoveringBulkProducer,
  type CoveringProducer,
  type RequestPairedProducerResult,
  type ResourceTypeProducer,
} from "./05_Producer.js";
export type {
  Entry,
  EntryForId,
  JsonifiedEntry,
  NormalizedConsumerMaxStale,
  NormalizedParams,
  NormalizedProducerDirectives,
  NormalizedProducerMaxStale,
  NormalizedProducerResult,
  NormalizedProducerResultResource,
  NormalizedVary,
} from "./06_Normalization.js";
export type {
  Store,
  StoreEntryInput,
  StoreEntryRelationship,
  StoreEntryResult,
  StoreGetManyRequest,
  StoreGetManyResult,
} from "./07_Store.js";
export { components, type ComponentName, type Logger } from "./08_Logger.js";
export type { CacheOptions } from "./09_CacheOptions.js";
