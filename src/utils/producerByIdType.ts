/**
 * @fileoverview Per-resource-type producer dispatch: opt-in sugar over the
 * single-producer primitive that both wrappers take.
 *
 * Split out from the wrappers because it needs no `Cache` at all: routing an id
 * to a sub-producer is a function of the resource-type registry's `matches`
 * guards and nothing else. What it does still need it imports -- the
 * {@link coveredTypes} carrier and the id-erased internal shapes from
 * `wrapProducer`, the routing errors from `producer-errors` -- so the runtime
 * import graph runs one way (this file -> those) and the bulk side is type-only.
 *
 * @module
 */
import {
  classifyIdAgainst,
  type IdClassification,
  type RegistryEntries,
  registryEntries,
  type ResourceTypeName,
  type ResourceTypes,
} from "../types/00_ResourceTypes.js";
import type { AnyParams, AnyValidators } from "../types/index.js";
import {
  UnroutableIdError,
  type UnroutableIdReason,
} from "./producer-errors.js";
import { assertUnreachable } from "./utils.js";
import type {
  BulkProducersFor,
  CoveringBulkProducer,
  LooseBulkProducer,
} from "./wrapBulkProducer.js";
import {
  coveredTypes,
  emptyProducersRecordMessage,
  type CoveringProducer,
  type LooseProducer,
  type LooseRequestFor,
  type LooseResultFor,
  type ProducersFor,
} from "./wrapProducer.js";

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
  entries: RegistryEntries<ResourceTypes>,
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
    throw new Error(
      emptyProducersRecordMessage("producerByIdType", "wrapProducer"),
    );
  }

  // Computed once, here, rather than per classified id.
  const entries = registryEntries(resourceTypes);

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

/**
 * The bulk counterpart of {@link producerByIdType}: sugar over
 * {@link wrapBulkProducer}'s single-producer primitive that turns a record with
 * one bulk producer per covered resource type into ONE function, and declares
 * its covered set in {@link coveredTypes} so the wrapper can both infer
 * `Covered` from it and enforce it at runtime.
 *
 * Use it when each resource type has its own origin, or to cover a strict
 * subset of the registry. Skip it -- pass a bare function -- when the producer
 * wants the full mixed batch, which is the capability the single-function form
 * exists for.
 *
 * Behaviour on each invocation:
 *
 * - The incoming batch is split by classifying each `req.id` against the
 *   registry, remembering every request's ORIGINAL index, and each sub-producer
 *   is invoked once, concurrently, with its own slice.
 * - Results are reassembled **positionally**: slice position `j` maps back to
 *   that request's original index. Positional is forced, not chosen: a batch
 *   can legitimately contain the same id twice with different `params`, so the
 *   id is not a routing key.
 * - A sub-producer's **failure** -- a rejection, or a synchronous throw from a
 *   non-async sub-producer -- is caught and written into that type's slots as
 *   `Error` elements, so per-request error isolation survives the merge, and one
 *   type's failure never discards a sibling type's results. It lives in the
 *   sugar rather than in the wrapper.
 * - A sub-producer that **under-returns** is NOT repaired or padded: those
 *   slots are left absent, so the wrapper's own under-return check (which
 *   rejects the whole invocation rather than risk misaligned pairing) fires
 *   exactly as it would for a bare producer. Silently substituting an `Error`
 *   would convert a contract violation into a per-request failure and hide the
 *   bug.
 * - A sub-producer that **over-returns** has no slot for the extras, so they
 *   are dropped -- matching the wrapper's own choice not to police
 *   over-return.
 *
 * Requests routed through this helper are classified twice, for the reason
 * given on {@link producerByIdType}.
 *
 * Throws at construction on an empty record.
 *
 * @param resourceTypes - The registry the producer's ids will be classified
 *   against: `cache.resourceTypes` for the cache it will be wrapped against.
 *   See {@link producerByIdType} for why the registry and not the cache.
 * @param producers - One {@link BulkResourceTypeProducer} per covered resource
 *   type; `Covered` is inferred from the keys.
 */
export function bulkProducerByIdType<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  resourceTypes: RT,
  producers: BulkProducersFor<RT, Covered, Validators, Params, ErrorType>,
): CoveringBulkProducer<RT, Covered, Validators, Params, ErrorType> {
  // SAFETY: see LooseProducer in wrapProducer.ts. A value is only read out of
  // this record after classification succeeds and the key is confirmed to be
  // the record's own, so each sub-producer's slice holds exactly the ids it
  // declared. Snapshotted for the reason given on `coveredTypeSet`.
  const looseProducers = { ...producers } as unknown as Readonly<
    Record<string, LooseBulkProducer<RT, Validators, Params, ErrorType>>
  >;
  const coveredResourceTypes = Object.keys(looseProducers);

  if (coveredResourceTypes.length === 0) {
    throw new Error(
      emptyProducersRecordMessage("bulkProducerByIdType", "wrapBulkProducer"),
    );
  }

  // Computed once, here, rather than per classified id. Named for the registry
  // it comes from: `entries` in this function's scope means a request group's.
  const classifierEntries = registryEntries(resourceTypes);

  type LooseRequest = LooseRequestFor<RT, Params>;
  type LooseResult = LooseResultFor<RT, Validators, Params>;

  const dispatchingProducer = async (reqs: readonly LooseRequest[]) => {
    // Throws UnroutableIdError on the first id that doesn't classify to exactly
    // one covered type -- before any sub-producer runs, so a batch with an
    // unroutable element contacts no origin at all. Unreachable through the
    // wrapper unless the registry here disagrees with the cache's; reachable
    // whenever the returned producer is driven directly.
    const classified = reqs.map((req, index) => ({
      index,
      req,
      ...resolveCoveredSubProducer(
        classifierEntries,
        looseProducers,
        coveredResourceTypes,
        req.id,
      ),
    }));

    // Sparse by design: only the slots a sub-producer actually returned get
    // filled, so an under-return leaves holes for the wrapper to catch.
    // oxlint-disable-next-line unicorn/no-new-array -- intentional sparse preallocation; filled by index below
    const results: (LooseResult | Error)[] = new Array(reqs.length);

    await Promise.all(
      [...Map.groupBy(classified, (it) => it.resourceType).entries()].map(
        async ([resourceType, entries]) => {
          // Every member of a group resolved to the same resource type, hence
          // to the same sub-producer. Non-null assertion is safe: Map.groupBy
          // never makes an empty group.
          const { subProducer } = entries[0]!;

          // try/catch rather than a `.catch()` on the returned promise: a
          // sub-producer that fails SYNCHRONOUSLY -- a non-async function with
          // an argument-validation `throw`, or one whose first synchronous step
          // throws (the hashed-input wrappers' internal producers read their
          // input registry synchronously) -- never reaches a handler attached
          // to its return value. That would take the whole MIXED batch down
          // with it, discarding the other resource types' already-computed
          // results and their store, for exactly the failure this helper
          // promises to isolate to one type's slots.
          let subResults: readonly (LooseResult | Error)[];
          try {
            subResults = await subProducer(entries.map((it) => it.req));
          } catch (error: unknown) {
            // Per-request error isolation survives the merge: this type's
            // slots settle as Error elements instead of failing the whole
            // invocation. A non-Error rejection is wrapped rather than stored
            // raw, since a non-Error in a result slot would be read as a
            // successful producer result; the original is kept as `cause`.
            const asError =
              error instanceof Error
                ? error
                : new Error(
                    `bulkProducerByIdType: the "${resourceType}" producer rejected with a non-Error value`,
                    { cause: error },
                  );
            subResults = entries.map(() => asError);
          }

          entries.forEach((entry, j) => {
            const result = subResults[j];
            if (result !== undefined) {
              results[entry.index] = result;
            }
          });
        },
      ),
    );

    return results;
  };

  // SAFETY: the dispatching function is id-erased internally (see
  // LooseProducer in wrapProducer.ts), and the covered names are the record's
  // own keys, so the declared set and the reachable sub-producers cannot
  // disagree.
  return Object.assign(dispatchingProducer, {
    [coveredTypes]: coveredResourceTypes,
  }) as unknown as CoveringBulkProducer<
    RT,
    Covered,
    Validators,
    Params,
    ErrorType
  >;
}
