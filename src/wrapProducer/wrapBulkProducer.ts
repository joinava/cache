/**
 * @fileoverview The client for a bulk producer (`produceMany`). It shares
 * pending work between requests, and batches the work into producer calls.
 * See producerScheduler.ts for the parts.
 *
 * @module
 */
import type { BatchOptions } from "@zingage/scheduling";
import type {
  ResourceTypeName,
  ResourceTypes,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  CoveringBulkProducer,
} from "../types/index.js";
import type { LooseBulkProducer } from "../types/05_Producer.js";
import {
  createProducerClient,
  type ProducerClientOptions,
  type WrappedProducerClient,
} from "./producerClient.js";

/**
 * The options that a bulk producer wrapper takes: the shared client's, plus
 * the batch settings that only a bulk producer uses.
 */
export type BulkProducerOptions<
  RT extends ResourceTypes,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = ProducerClientOptions<RT, Validators, Params> & {
  /**
   * Bulk accumulation settings; default limit 20. `maxBatchSize` limits
   * every `produceMany` call, also for work with
   * `autoBatch.producer: false`, which skips only the accumulation wait.
   * Does not change participation. Only a `produceMany` producer accepts it,
   * because a single producer never batches.
   *
   * By default, batches run concurrently, with no limit: a wrapped `getMany`
   * of 1,000 misses makes 50 concurrent `produceMany` calls at the default
   * batch limit. `maxConcurrentProducerCalls` limits them.
   */
  producerBatching?: BatchOptions;
};

/**
 * Wraps a bulk producer. `wrapProducer` calls it for `produceMany`, and
 * documents the client.
 */
export function wrapBulkProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  options: BulkProducerOptions<RT, Validators, Params>,
  produceMany: CoveringBulkProducer<RT, Covered, Validators, Params>,
): WrappedProducerClient<RT, Covered, Validators, Params> {
  // Classification and coverage checks prove this erasure before dispatch.
  const looseProduceMany = produceMany as LooseBulkProducer<
    RT,
    Validators,
    Params,
    Error
  >;
  return createProducerClient<RT, Covered, Validators, Params>(options, {
    producer: produceMany,
    call: looseProduceMany,
    batching: options.producerBatching ?? {},
  });
}
