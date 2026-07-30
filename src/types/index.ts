// The files in this directory hold types defining the contract between the
// various components that make up the caching system.
//
// Those that are meant to be public are re-exported below.
export type { CacheSpec, ContentForId, SpecForId } from "./00_CacheSpec.js";
export {
  idStartsWith,
  resourceType,
  type ContentOfResourceType,
  type IdOfResourceType,
  type ResourceTypeName,
  type ResourceTypes,
  type ResourceTypeSpec,
  type SpecOf,
} from "./00_ResourceTypes.js";
export type { AnyParams, AnyParamValue } from "./01_Params.js";
export type { AnyValidators } from "./02_Validators.js";
export type {
  ConsumerDirectives,
  ConsumerMaxStale,
  ConsumerRequest,
  ReadonlyConsumerRequest,
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
export type {
  RequestPairedProducer,
  RequestPairedProducerResult,
} from "./05_RequestPairedProducer.js";
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
} from "./06_Store.js";
export { components, type ComponentName, type Logger } from "./07_Logger.js";
