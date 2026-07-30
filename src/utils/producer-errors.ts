/**
 * @fileoverview The errors both producer wrappers raise, and the mapping that
 * puts a cache's name back on a cache-free one.
 *
 * Extracted so `wrapProducer`, `wrapBulkProducer` and `producerByIdType` can
 * each raise or map them without importing one another for it: the routing
 * errors are thrown by the by-id-type helpers, and re-thrown named by whichever
 * wrapper the producer was handed to.
 *
 * @module
 */
import {
  AmbiguousResourceTypeError,
  UnclassifiableIdError,
} from "../Cache.js";
import { assertUnreachable } from "./utils.js";

/**
 * Thrown by the producer wrappers (not by Cache) when a request's id
 * classifies to a resource type outside the wrapper's inferred coverage.
 * Reachable only via casts or loosely-typed ids -- the wrapped function's
 * request type bans covered-set violations at compile time. Thrown BEFORE
 * any cache read: serving a hit for an uncovered type would smuggle the
 * serve-if-present contract back in through a cast.
 *
 * Only reachable when coverage was actually NARROWED -- i.e. the producer
 * came from {@link producerByIdType}/`bulkProducerByIdType` (which declare
 * their covered set), or `Covered` was pinned by an explicit type argument.
 * A bare producer function covers the whole registry by construction (its
 * parameter type must accept every registry id), so it declares no covered
 * set, the wrapper runs no coverage check, and this error cannot occur: every
 * classifiable id has a producer. Unclassifiable/ambiguous ids still fail
 * loud, from `cache.classify`.
 */
export class NoProducerForResourceTypeError extends Error {
  override readonly name = "NoProducerForResourceTypeError";
  readonly cacheName: string;
  readonly resourceType: string;
  readonly coveredResourceTypes: readonly string[];
  readonly id: string;

  constructor(args: {
    cacheName: string;
    resourceType: string;
    coveredResourceTypes: readonly string[];
    id: string;
  }) {
    super(
      `Cache "${args.cacheName}": id ${JSON.stringify(args.id)} classifies to resource type "${args.resourceType}", which is outside this wrapper's coverage (${args.coveredResourceTypes.join(", ")})`,
    );
    this.cacheName = args.cacheName;
    this.resourceType = args.resourceType;
    this.coveredResourceTypes = args.coveredResourceTypes;
    this.id = args.id;
  }
}

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
export class UnroutableIdError extends Error {
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
 * Re-throws a by-id-type helper's cache-free {@link UnroutableIdError} as the
 * cache-named error the wrapper's own pre-dispatch checks would have thrown for
 * the same id, so routing through a wrapper reports one error vocabulary
 * regardless of which layer noticed. Anything else is re-thrown untouched.
 */
export function rethrowUnroutableWithCacheName(
  cacheName: string,
  error: unknown,
): never {
  if (!(error instanceof UnroutableIdError)) {
    throw error;
  }
  const { detail } = error;
  switch (detail.reason) {
    case "uncovered": {
      throw new NoProducerForResourceTypeError({
        cacheName,
        resourceType: detail.resourceType,
        coveredResourceTypes: error.coveredResourceTypes,
        id: error.id,
      });
    }
    case "unclassifiable": {
      throw new UnclassifiableIdError({
        cacheName,
        id: error.id,
        cause: detail.cause,
      });
    }
    case "ambiguous": {
      throw new AmbiguousResourceTypeError({
        cacheName,
        id: error.id,
        matchedResourceTypes: detail.matchedResourceTypes,
      });
    }
    default: {
      return assertUnreachable(detail);
    }
  }
}
