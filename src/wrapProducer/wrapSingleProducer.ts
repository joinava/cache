/**
 * @fileoverview The client for a single-request producer (`produce`). It
 * shares pending work between requests, and sends each unit of work to the
 * producer as its own call. A single producer has nothing to batch, so its
 * work never accumulates. See producerScheduler.ts for the parts.
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
    batching: undefined,
  });
}
