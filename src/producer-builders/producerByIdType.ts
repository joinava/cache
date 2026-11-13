/**
 * @fileoverview Per-resource-type producer dispatch: opt-in sugar over the
 * single-producer primitive that both wrappers take.
 *
 * Split out from the wrappers because it needs no `Cache` at all: routing an id
 * to a sub-producer is a function of the resource-type registry's `matches`
 * guards and nothing else. It imports the {@link coveredTypes} carrier from the
 * producer types, and only types from `producerClient`. The routing error it
 * throws, {@link UnroutableIdError}, is defined here, and the producer client
 * imports it to re-throw it with its cache's name. So the runtime import graph
 * between the two runs one way: wrapper -> this file.
 *
 * @module
 */
import type {
  ResourceTypeName,
  ResourceTypes,
} from "../types/00_ResourceTypes.js";
import {
  classifyIdAgainst,
  type IdClassification,
  resourceTypesEntries,
  type ResourceTypesEntries,
} from "../resourceTypeClassification.js";
import { CacheContractError, assertUnreachable } from "../utils/utils.js";
import {
  coveredTypes,
  type AnyParams,
  type AnyValidators,
  type CoveringProducer,
  type ResourceTypeProducer,
} from "../types/index.js";
import type {
  LooseProducer,
  LooseRequestFor,
} from "../wrapProducer/producerClient.js";

/**
 * Why an id could not be routed to one of a by-id-type producer's covered
 * sub-producers. A discriminated union so a renderer cannot read a field the
 * reason does not populate.
 */
export type UnroutableIdReason =
  | {
      readonly reason: "unclassifiable";
      /** See {@link IdClassification}'s `cause`. */
      readonly cause: unknown;
    }
  | {
      readonly reason: "ambiguous";
      readonly matchedResourceTypes: readonly string[];
    }
  | { readonly reason: "uncovered"; readonly resourceType: string };

/**
 * Thrown by {@link producerByIdType}/`bulkProducerByIdType` when an id cannot
 * be routed to one of their sub-producers.
 *
 * Cache-free by construction: these helpers are built from a resource-type
 * registry, so they have no cache to name. When one is driven through a wrapper
 * the wrapper catches it and re-throws the equivalent cache-named error
 * (see {@link rethrowUnroutableWithCacheName}), so a wrapped producer's
 * observable errors are unchanged; this error surfaces only when the helper's
 * result is invoked directly.
 *
 * Reaching it through a wrapper at all means the registry the helper was built
 * from disagrees with the cache's own -- the wrapper classifies first, against
 * the cache's registry, and rejects uncovered types before dispatching. Passing
 * `cache.resourceTypes` (rather than some other object of the same shape) is
 * what keeps the two in step.
 */
export class UnroutableIdError extends CacheContractError {
  override readonly name = "UnroutableIdError";
  readonly id: string;
  readonly coveredResourceTypes: readonly string[];
  readonly detail: UnroutableIdReason;

  constructor(args: {
    id: string;
    coveredResourceTypes: readonly string[];
    detail: UnroutableIdReason;
  }) {
    const covered = args.coveredResourceTypes.join(", ");
    super(
      args.detail.reason === "uncovered"
        ? `id ${JSON.stringify(args.id)} classifies to resource type "${args.detail.resourceType}", which is outside this producer's coverage (${covered})`
        : args.detail.reason === "ambiguous"
          ? `id ${JSON.stringify(args.id)} matches more than one resource type (${args.detail.matchedResourceTypes.join(", ")}) in the registry this producer was built from`
          : `id ${JSON.stringify(args.id)} matches no resource type in the registry this producer was built from`,
      args.detail.reason === "unclassifiable" && args.detail.cause !== undefined
        ? { cause: args.detail.cause }
        : undefined,
    );
    this.id = args.id;
    this.coveredResourceTypes = args.coveredResourceTypes;
    this.detail = args.detail;
  }
}

/**
 * Classifies `id` against the registry a by-id-type helper was built from and
 * resolves the sub-producer to dispatch to, throwing {@link UnroutableIdError}
 * when the id doesn't classify to exactly one *covered* resource type.
 *
 * Returns the sub-producer rather than just its name so the membership test and
 * the lookup are one own-property read: "is this type covered" and "which
 * function covers it" cannot then disagree, and neither call site needs a
 * non-null assertion. Shared by the single and bulk helpers so their routing --
 * and so which failures are contract violations rather than dispositions --
 * cannot drift.
 */
export function resolveCoveredSubProducer<SubProducer>(
  entries: ResourceTypesEntries<ResourceTypes>,
  subProducers: Readonly<Record<string, SubProducer>>,
  coveredResourceTypes: readonly string[],
  id: string,
): { readonly resourceType: string; readonly subProducer: SubProducer } {
  const unroutable = (detail: UnroutableIdReason) =>
    new UnroutableIdError({ id, coveredResourceTypes, detail });

  const classification: IdClassification<ResourceTypes> = classifyIdAgainst(
    entries,
    id,
  );
  switch (classification.matched) {
    case "one": {
      const { name } = classification;
      // Own-property read: the record came from a spread of the caller's, so
      // inherited keys must never resolve a producer.
      const subProducer = Object.hasOwn(subProducers, name)
        ? subProducers[name]
        : undefined;
      if (subProducer === undefined) {
        throw unroutable({ reason: "uncovered", resourceType: name });
      }
      return { resourceType: name, subProducer };
    }
    case "none": {
      throw unroutable({
        reason: "unclassifiable",
        cause: classification.cause,
      });
    }
    case "many": {
      throw unroutable({
        reason: "ambiguous",
        matchedResourceTypes: classification.names,
      });
    }
    default: {
      return assertUnreachable(classification);
    }
  }
}

/**
 * The write side of the coverage contract: what `producerByIdType` and
 * `bulkProducerByIdType` throw when handed an empty record. Shared so the two
 * helpers can't word the same refusal differently. The read side is
 * `coveredTypeSet` in wrapProducer/producerClient.ts.
 */
export function emptyProducersRecordMessage(
  helper: "producerByIdType" | "bulkProducerByIdType",
): string {
  return (
    `${helper}: \`producers\` must be a record with one entry per covered ` +
    `resource type and cannot be empty. (A producer that covers the whole ` +
    `registry needs no helper: pass the function itself to wrapProducer.)`
  );
}

/**
 * {@link producerByIdType}'s argument: one entry per covered resource type,
 * any non-empty subset of the registry. `Covered` is inferred from the
 * record's keys. Non-coverage is expressed by omission, so a wrapper never has
 * to make claims about types that other wrappers may produce.
 */
export type ProducersFor<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  readonly [K in Covered]: ResourceTypeProducer<RT, K, Validators, Params>;
};

/**
 * Sugar over {@link wrapProducer}'s single-producer primitive: turns a record
 * with one entry per covered resource type into ONE function that dispatches
 * by the request's classified type, and that declares its covered set in
 * {@link coveredTypes} so `wrapProducer` can both infer `Covered` from it and
 * enforce it at runtime.
 *
 * Use this when a wrapper should cover a strict subset of the registry, or
 * when each resource type has its own origin. A producer that covers the whole
 * registry needs no helper: pass it to `wrapProducer` directly.
 *
 * Throws at construction on an empty record: a helper whose whole purpose is to
 * declare a covered set has nothing to declare.
 *
 * Note that requests routed through this helper are classified TWICE (once
 * here to pick the sub-producer, once in the wrapper for dispatch/telemetry).
 * That is the price of the sugar being opt-in; guards are meant to be cheap.
 *
 * @param resourceTypes - The registry the producer's ids will be classified
 *   against: `cache.resourceTypes` for the cache it will be wrapped against.
 *   The registry, not the cache, because routing by id type needs nothing else
 *   -- so a by-id-type producer is a value in its own right, buildable and
 *   testable before any cache exists. It is also the inference site for `RT`
 *   (see {@link Cache.resourceTypes} for why a bare-`RT` member is needed for
 *   that at all).
 * @param producers - One {@link ResourceTypeProducer} per covered resource
 *   type; `Covered` is inferred from the keys.
 */
export function producerByIdType<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  resourceTypes: RT,
  producers: ProducersFor<RT, Covered, Validators, Params>,
): CoveringProducer<RT, Covered, Validators, Params> {
  // SAFETY: see LooseProducer. A value is only read out of this record after
  // classification succeeds and the key is confirmed to be the record's own,
  // so the request's id is in exactly the id sub-space that sub-producer
  // declared. Snapshotted for the reason given on `coveredTypeSet`.
  const looseProducers: Readonly<
    Record<string, LooseProducer<RT, Validators, Params>>
  > = {
    ...(producers as unknown as Readonly<
      Record<string, LooseProducer<RT, Validators, Params>>
    >),
  };
  const coveredResourceTypes = Object.keys(looseProducers);

  if (coveredResourceTypes.length === 0) {
    throw new Error(emptyProducersRecordMessage("producerByIdType"));
  }

  // Computed once, here, rather than per classified id.
  const entries = resourceTypesEntries(resourceTypes);

  type LooseRequest = LooseRequestFor<RT, Params>;

  const dispatchingProducer = async (req: LooseRequest) => {
    // Throws UnroutableIdError when the id doesn't classify to exactly one
    // covered type. Unreachable through `wrapProducer` unless the registry here
    // disagrees with the cache's; reachable whenever the returned producer is
    // driven directly. Fail loud either way rather than serving nothing.
    const { subProducer } = resolveCoveredSubProducer(
      entries,
      looseProducers,
      coveredResourceTypes,
      req.id,
    );
    return subProducer(req);
  };

  // SAFETY: the dispatching function is id-erased internally (see
  // LooseProducer), and the covered names are the record's own keys, so the
  // declared set and the reachable sub-producers cannot disagree.
  return Object.assign(dispatchingProducer, {
    [coveredTypes]: coveredResourceTypes,
  }) as unknown as CoveringProducer<RT, Covered, Validators, Params>;
}
