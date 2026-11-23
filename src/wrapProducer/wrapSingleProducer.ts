/**
 * @fileoverview The client for a single-request producer (`produce`). It
 * shares pending work between requests, and sends each started task to the
 * producer as its own invocation. A single producer has nothing to batch,
 * so it needs no batcher. See producerScheduler.ts for the parts.
 *
 * @module
 */
import type {
  ResourceTypeName,
  ResourceTypes,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  CoveringProducer,
} from "../types/index.js";
import type { LooseProducer } from "../types/05_Producer.js";
import {
  createProducerClient,
  type ProducerClientOptions,
  type WrappedProducerClient,
} from "./producerClient.js";
import {
  createProducerScheduler,
  immediateSender,
  type ProducerScheduler,
  type ProducerSchedulerOptions,
} from "./producerScheduler.js";

/**
 * Wraps a single-request producer. `wrapProducer` calls it for `produce`, and
 * documents the client.
 */
export function wrapSingleProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(
  options: ProducerClientOptions<RT, Validators, Params>,
  produce: CoveringProducer<RT, Covered, Validators, Params>,
): WrappedProducerClient<RT, Covered, Validators, Params> {
  // Classification and coverage checks prove this erasure before dispatch.
  const looseProduce = produce as LooseProducer<RT, Validators, Params>;
  return createProducerClient<RT, Covered, Validators, Params>(options, {
    producer: produce,
    call: async (requests) => [await looseProduce(requests[0]!)],
    makeScheduler: singleProducerScheduler,
  });
}

/**
 * The scheduler of a single-request producer: requests with the same key
 * share one task, and each started task is its own producer invocation.
 * Nothing accumulates, so it has no `startOrRideDirect`. With a limiter, a
 * task can wait for a slot.
 *
 * @internal
 */
export function singleProducerScheduler<Work, Produced>(
  options: ProducerSchedulerOptions<Work, Produced>,
): ProducerScheduler<Work, Produced> {
  return createProducerScheduler(options, immediateSender(options));
}
