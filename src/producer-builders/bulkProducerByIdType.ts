/**
 * @fileoverview Per-resource-type dispatch for BULK producers: the bulk
 * counterpart of `producerByIdType`, and its argument type `BulkProducersFor`.
 *
 * Split from the wrapper for the same reason the single helper is: routing a
 * batch to sub-producers is a function of the resource-type registry's `matches`
 * guards and nothing else, so a by-id-type bulk producer is a value in its own
 * right -- buildable, drivable and testable before any cache exists.
 *
 * Routing itself is imported from `producerByIdType` rather than reimplemented,
 * which is what keeps the two helpers' answers to "is this id covered" from
 * drifting apart. Its return shape, `CoveringBulkProducer`, and the sub-producer
 * type, `BulkResourceTypeProducer`, live with the other producer types in
 * `types/05_Producer.ts`. None of its runtime imports import this file, so the
 * import graph stays acyclic.
 *
 * @module
 */
import type {
  ResourceTypeName,
  ResourceTypes,
} from "../types/00_ResourceTypes.js";
import { resourceTypesEntries } from "../resourceTypeClassification.js";
import { CacheContractError } from "../utils/utils.js";
import {
  emptyProducersRecordMessage,
  resolveCoveredSubProducer,
} from "./producerByIdType.js";
import {
  coveredTypes,
  type AnyParams,
  type AnyValidators,
  type BulkResourceTypeProducer,
  type CoveringBulkProducer,
} from "../types/index.js";
import type {
  LooseBulkProducer,
  LooseRequestFor,
  LooseResultFor,
} from "../types/05_Producer.js";

/**
 * {@link bulkProducerByIdType}'s argument: one entry per covered resource
 * type, any non-empty subset of the registry. `Covered` is inferred from the
 * record's keys, exactly as in `producerByIdType`.
 */
export type BulkProducersFor<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = {
  readonly [K in Covered]: BulkResourceTypeProducer<
    RT,
    K,
    Validators,
    Params,
    ErrorType
  >;
};

/**
 * The bulk counterpart of `producerByIdType`: sugar over `wrapProducer`'s
 * single-producer primitive that turns a record with one bulk producer per
 * covered resource type into ONE function, and declares its covered set in
 * {@link coveredTypes} so the wrapper can both infer `Covered` from it and
 * enforce it at runtime.
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
 * - A sub-producer whose result count does not match the slice it was given --
 *   in EITHER direction -- fails every slot of that slice with one
 *   `CacheContractError` that names the resource type and both counts. Its
 *   positional pairing is no longer trustworthy, but only inside its slice.
 *   The bug still shows: the wrapper rejects the whole public call of each
 *   request in the slice, not just its slot.
 * - Every failure of a slice stays in that slice's slots. Automatic batching
 *   merges unrelated callers into one invocation, so failing the whole
 *   invocation would fail callers whose requests were valid.
 *
 * Requests routed through this helper are classified twice, for the reason
 * given on `producerByIdType`.
 *
 * Throws at construction on an empty record.
 *
 * @param resourceTypes - The registry the producer's ids will be classified
 *   against: `cache.resourceTypes` for the cache it will be wrapped against.
 *   See `producerByIdType` for why the registry and not the cache.
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
  // SAFETY: see LooseProducer in types/05_Producer.ts. A value is
  // only read out of this record after classification succeeds and the key is
  // confirmed to be the record's own, so each sub-producer's slice holds
  // exactly the ids it declared. Snapshotted for the reason given on
  // `coveredTypeSet`.
  const looseProducers = { ...producers } as unknown as Readonly<
    Record<string, LooseBulkProducer<RT, Validators, Params, ErrorType>>
  >;
  const coveredResourceTypes = Object.keys(looseProducers);

  if (coveredResourceTypes.length === 0) {
    throw new Error(emptyProducersRecordMessage("bulkProducerByIdType"));
  }

  // Computed once, here, rather than per classified id. Named for the registry
  // it comes from: `entries` in this function's scope means a request group's.
  const classifierEntries = resourceTypesEntries(resourceTypes);

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

    // Preallocated so each group can write its own results back at their
    // original indices. Every request classifies into exactly one group and
    // every group fills its whole slice (count-checked below), so this is dense
    // by the time it is returned.
    // oxlint-disable-next-line unicorn/no-new-array -- intentional preallocation; filled by index below
    const results: (LooseResult | Error)[] = new Array(reqs.length);

    // No branch rejects: each one turns its failures into Error slots.
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
            // This type's slots settle as Error elements, a CacheContractError
            // included. A non-Error failure is wrapped rather than stored
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

          // A count disagreement fails every slot of this type's slice, rather
          // than filling what came back and leaving the rest as holes for the
          // wrapper's own under-return check to find: this names the offending
          // resource type and both counts, where the wrapper -- which sees only
          // the merged batch -- can report a total ("results for only 7 of 10
          // requests") but never which sub-producer broke it. It also stops the
          // merge resting on `undefined` as the "no result here" sentinel; that
          // is sound (see the wrapper's check) but a count comparison needs no
          // such premise. The failure path above is length-correct by
          // construction, so this only fires for a sub-producer that returned.
          if (
            !Array.isArray(subResults) ||
            subResults.length !== entries.length
          ) {
            const countError = new CacheContractError(
              `bulkProducerByIdType: the "${resourceType}" producer returned a ` +
                `result count (${String(Array.isArray(subResults) ? subResults.length : 0)}) that does not match ` +
                `the number of requests in its slice (${String(entries.length)}); ` +
                `each sub-producer must return exactly one result or Error per ` +
                `request it was given`,
            );
            subResults = entries.map(() => countError);
          }

          entries.forEach((entry, j) => {
            // SAFETY: the counts were checked to match above (or the slice
            // was replaced with one Error per entry), so slot `j` exists for
            // every entry in its slice.
            results[entry.index] = subResults[j]!;
          });
        },
      ),
    );

    return results;
  };

  // SAFETY: the dispatching function is id-erased internally (see
  // LooseProducer in types/05_Producer.ts), and the covered names
  // are the record's own keys, so the declared set and the reachable
  // sub-producers cannot disagree.
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
