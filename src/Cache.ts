import { groupBy, sortBy, sumBy } from "es-toolkit";
import { EventEmitter } from "events";
import type { InvariantOf, ReadonlyDeep } from "type-fest";
import { isNonEmptyArray, mapNonEmpty } from "type-party/runtime/nonempty.js";
import {
  publishCacheRead,
  publishCacheStoreEntry,
  type CacheReadFound,
} from "./diagnostics.js";
import {
  type Entry,
  type NormalizeParamName,
  type NormalizeParamValue,
} from "./types/06_Normalization.js";
import {
  type AnyParams,
  type AnyParamValue,
  type AnyValidators,
  type CacheSpec,
  type ConsumerDirectives,
  type ConsumerRequest,
  type Logger,
  type ProducerResultResource,
  type ResourceTypeName,
  type ResourceTypes,
  type ResourceTypeSpec,
  soleResourceType,
  type SpecForId,
  type SpecOf,
  type Store,
  type StoreEntryResult,
  type Vary,
} from "./types/index.js";
import { type Bind1 } from "./types/utils.js";
import {
  normalizeParams,
  normalizeProducerResultResource,
  normalizeVary,
} from "./utils/normalization.js";
import * as entryUtils from "./utils/normalizedProducerResultResourceHelpers.js";
import { defaultLoggersByComponent } from "./utils/utils.js";

/**
 * Thrown when an id matches zero resource types in the cache's registry.
 * See the classification contract in {@link ResourceTypes}' module docs.
 */
export class UnclassifiableIdError extends Error {
  override readonly name = "UnclassifiableIdError";
  readonly cacheName: string;
  readonly id: string;

  constructor(args: {
    cacheName: string;
    id: string;
    message?: string;
    /**
     * When one or more registry guards THREW on this id (rather than
     * returning false), the error(s) land here (an `AggregateError` when
     * more than one threw) so the underlying parse failure stays
     * debuggable from the log line. See {@link Cache.classify}.
     */
    cause?: unknown;
  }) {
    super(
      args.message ??
        `Cache "${args.cacheName}": id ${JSON.stringify(args.id)} matches no resource type in the registry`,
      args.cause === undefined ? undefined : { cause: args.cause },
    );
    this.cacheName = args.cacheName;
    this.id = args.id;
  }
}

/**
 * Thrown when an id matches more than one resource type in the cache's
 * registry. Registries must partition the id space, so this always indicates
 * a bug in the registry's `matches` guards; classification fails loud (over
 * first-match-wins) so the overlap is caught the first time it occurs rather
 * than silently resolved by object-key order.
 */
export class AmbiguousResourceTypeError extends Error {
  override readonly name = "AmbiguousResourceTypeError";
  readonly cacheName: string;
  readonly id: string;
  readonly matchedResourceTypes: readonly string[];

  constructor(args: {
    cacheName: string;
    id: string;
    matchedResourceTypes: readonly string[];
    message?: string;
  }) {
    super(
      args.message ??
        `Cache "${args.cacheName}": id ${JSON.stringify(args.id)} matches more than one resource type in the registry (${args.matchedResourceTypes.join(", ")})`,
    );
    this.cacheName = args.cacheName;
    this.id = args.id;
    this.matchedResourceTypes = args.matchedResourceTypes;
  }
}

/**
 * The result of a cache lookup. MatchingSpecs is the subset of CacheSpec
 * variants whose id is compatible with the request's id (`Id`).
 */
export type CacheLookupResult<
  MatchingSpecs extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  usable?: Entry<MatchingSpecs, Validators, Params> | undefined;
  usableWhileRevalidate?: Entry<MatchingSpecs, Validators, Params> | undefined;
  usableIfError?: Entry<MatchingSpecs, Validators, Params> | undefined;
  validatable: Entry<MatchingSpecs, Validators, Params>[];
};

/**
 * Maps a lookup result to the `found` value published on the read channel.
 * The keys are mutually exclusive in the direction of this priority order
 * (see {@link Cache.get}'s docs), so the first present key is *the* answer.
 * (The parameter is a loose structural slice of {@link CacheLookupResult} so
 * every generic instantiation of the result type is accepted.)
 */
function foundForLookupResult(result: {
  usable?: unknown;
  usableWhileRevalidate?: unknown;
  usableIfError?: unknown;
  validatable?: unknown;
}): CacheReadFound {
  return result.usable
    ? "usable"
    : result.usableWhileRevalidate
      ? "usable-while-revalidate"
      : result.usableIfError
        ? "usable-if-error"
        : "none";
}

/**
 * Everything a {@link Cache} needs, as one bag. The store is a field rather
 * than a separate constructor argument because `options` has no useful default
 * (`name` and `resourceTypes` are both required), so there was never a call
 * shape where passing the store alone said anything.
 */
export type CacheOptions<
  RT extends ResourceTypes,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = {
  /**
   * REQUIRED. The backing store that will actually hold cache entries.
   *
   * Note: the Store interface should _already_ be invariant in its Params, but
   * TS's underlying handling of functions as always bivariant (which the
   * compiler tries to hide/override in some cases under strictFunctionTypes,
   * but this doesn't apply to class methods; see
   * https://www.typescriptlang.org/tsconfig/#strictFunctionTypes) means that we
   * have to use `InvariantOf<Params>` explicitly to get the type errors we want.
   */
  store: Store<SpecOf<RT>, Validators, InvariantOf<Params>>;
  /**
   * REQUIRED. Names this cache instance (≈ the backing table) in every
   * diagnostics message. Instance-unique per process by convention;
   * uniqueness is not enforced.
   */
  name: string;
  /**
   * REQUIRED. The cache's resource-type registry; see {@link ResourceTypes}.
   * Must partition the id space. For a cache with exactly one resource type,
   * {@link singleTypeCacheOptions} builds this (and names it) for you.
   */
  resourceTypes: RT;
  logger?: Logger;
  onGetAfterClose?: "throw" | "act-empty";
  onStoreAfterClose?: "throw" | "no-op";
  normalizeParamName?: NormalizeParamName<Params>;
  normalizeParamValue?: NormalizeParamValue<Params>;
};

/**
 * This class implements a cache using a generalized version of HTTP's
 * underlying caching model, but w/o encoding HTTP-specific details (like header
 * parsing), so that it can be useful in more contexts. As part of this
 * generalization, this class talks about a cached value's "id and request
 * params" rather than its "URI and request headers", and cache directives are
 * provided as explicit arguments (not header strings). Similarly, it refers to
 * the "producer and consumer" of cached values, rather than the "server and the
 * client". Beyond renaming, it leaves open the set of available validators for
 * users to define (e.g., db row version numbers), rather than hard-coding HTTP
 * validators like etags and last-modified dates, and it supports a set of
 * directives somewhat more general than their HTTP equivalents.
 *
 * For (critical) background details on the HTTP caching model, see the docs.
 *
 * The cache is parameterized over a {@link ResourceTypes} registry, which
 * names each kind of resource the cache can hold and pairs it with a runtime
 * classifier for its id sub-space plus a (phantom) content type. The cache's
 * {@link CacheSpec} union is derived from the registry via {@link SpecOf}:
 * the get/store/getMany methods narrow the content type based on the id of
 * each request, and reject mismatched (id, content) pairs at compile time.
 * At runtime, every id the cache sees (requests, stored entries -- primary
 * and supplemental -- and deletes) is classified against the registry, and
 * ids that match zero or multiple resource types are loudly rejected.
 *
 * TODO: support the concept of warnings.
 * See https://tools.ietf.org/html/rfc7234#section-5.5
 */
export default class Cache<
  const RT extends ResourceTypes = ResourceTypes,
  Validators extends AnyValidators = AnyValidators,
  in out Params extends AnyParams = AnyParams,
> {
  readonly #logger: Bind1<Logger, "cache">;
  readonly #dataStore: Store<SpecOf<RT>, Validators, Params>;
  #closed = false;
  readonly #onGetAfterClose: "throw" | "act-empty";
  readonly #onStoreAfterClose: "throw" | "no-op";
  readonly #resourceTypeEntries: readonly (readonly [
    ResourceTypeName<RT>,
    RT[ResourceTypeName<RT>],
  ])[];

  /**
   * Names this cache instance (≈ the backing table) in every diagnostics
   * message. Instance-unique per process by convention; uniqueness is not
   * enforced.
   */
  public readonly name: string;

  /**
   * The cache's resource-type registry (constructor `options.resourceTypes`).
   *
   * Note: beyond letting callers introspect the registry, this public
   * property is what lets the producer wrappers *infer* `RT` from a cache
   * value: the other RT-mentioning members (`classify`'s
   * `ResourceTypeName<RT>`, the `SpecOf<RT>`-derived method types) are
   * keyof-/conditional-shaped and unusable as inference sources, so without
   * a bare-`RT` member, wrapping a cache built over a narrowed
   * `soleResourceType<C, Id>` registry would collapse `RT` to its constraint
   * (producer `req.id` would become plain `string`).
   */
  public readonly resourceTypes: RT;

  public readonly emitter = new EventEmitter();
  public readonly normalizeParamName: NormalizeParamName<Params>;
  public readonly normalizeParamValue: NormalizeParamValue<Params>;

  constructor(options: CacheOptions<RT, Validators, Params>) {
    const unboundLogger = options.logger ?? defaultLoggersByComponent.cache;
    this.#logger = unboundLogger.bind(null, "cache");
    this.#dataStore = options.store;
    this.#onGetAfterClose = options.onGetAfterClose ?? "throw";
    this.#onStoreAfterClose = options.onStoreAfterClose ?? "throw";
    this.name = options.name;
    this.resourceTypes = options.resourceTypes;
    this.#resourceTypeEntries = Object.entries(
      options.resourceTypes,
      // SAFETY: Object.entries widens a generic mapped type's values to
      // `unknown` (its keys to `string`); the registry's own enumerable
      // entries are exactly the `[name, spec]` pairs this asserts.
    ) as [ResourceTypeName<RT>, RT[ResourceTypeName<RT>]][];
    this.normalizeParamName = options.normalizeParamName ?? ((it) => it);
    this.normalizeParamValue =
      options.normalizeParamValue ??
      (<K extends keyof Params>(_name: K, v: AnyParamValue) =>
        v as Params[K] & AnyParamValue);
  }

  private static bestEntry<
    EntrySpec extends CacheSpec,
    Validators extends AnyValidators,
    Params extends AnyParams,
  >(suitableEntries: readonly Entry<EntrySpec, Validators, Params>[]) {
    // "When more than one suitable response is stored, a cache MUST use
    // the most recent response (as determined by the Date header field)."
    // https://tools.ietf.org/html/rfc7234#section-4
    return sortBy(suitableEntries, [(it) => entryUtils.birthDate(it)]).at(-1);
  }

  // Create this as an instance member to get `this` binding
  private normalizeParams = (params: ReadonlyDeep<Partial<Params>>) =>
    normalizeParams(this.normalizeParamName, this.normalizeParamValue, params);

  // Create this as an instance member to get `this` binding
  private normalizeVary = (vary: Vary<Params>) =>
    normalizeVary(this.normalizeParamName, this.normalizeParamValue, vary);

  /**
   * Total classification of an id against the cache's registry: evaluates
   * EVERY registry entry's `matches` guard, and returns the name of the one
   * resource type that matched.
   *
   * Throws {@link UnclassifiableIdError} (0 matches) or
   * {@link AmbiguousResourceTypeError} (>1 match); every guard is evaluated
   * (rather than first-match-wins) so registry overlaps are caught the first
   * time an id hits them.
   *
   * Classification runs on every get/getMany request id, every stored entry
   * id (primary and supplemental), and every delete id -- classification
   * failures reject the operation BEFORE touching the store.
   *
   * A guard that THROWS is treated as not matching: guards routinely reject
   * foreign ids by failing to parse them (e.g. a `JSON.parse`-based guard
   * fed a non-JSON id), so a throw is a "no" -- and when no type ends up
   * matching, the guard error(s) surface as the
   * {@link UnclassifiableIdError}'s `cause` rather than leaking as a raw
   * parse error with no cache/id attribution.
   */
  public classify(id: string): ResourceTypeName<RT> {
    const evaluated = this.#resourceTypeEntries.map(([name, spec]) => {
      try {
        return { name, matched: spec.matches(id) };
      } catch (error) {
        return { name, matched: false, error };
      }
    });
    const matched = evaluated.filter((it) => it.matched).map((it) => it.name);

    if (matched.length === 1) {
      // Non-null assertion is safe: length was just checked.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return matched[0]!;
    }

    if (matched.length === 0) {
      const guardErrors = evaluated.flatMap((it) =>
        "error" in it ? [it.error] : [],
      );
      throw new UnclassifiableIdError({
        cacheName: this.name,
        id,
        cause:
          guardErrors.length === 0
            ? undefined
            : guardErrors.length === 1
              ? guardErrors[0]
              : new AggregateError(
                  guardErrors,
                  "one or more registry guards threw while classifying",
                ),
      });
    }

    throw new AmbiguousResourceTypeError({
      cacheName: this.name,
      id,
      matchedResourceTypes: matched,
    });
  }

  /**
   * Gets relevant items from the cache, always returning a promise for an
   * object with four possible keys:
   *
   * - `usable`: this is the cached value (if any) that satisfies the consumer's
   *   request, given its cache directives, without requiring even background
   *   revalidation. **If this key holds a value, all other keys in this object
   *   will be undefined/empty.** This value will almost always be fresh, since
   *   stale values aren't usable by defualt; the exception is if the consumer
   *   allowed stale responses (sans revalidation) through the `maxStale`
   *   directive. If multiple cached values would've have been suitable, this
   *   holds the preferred one (which currently means the newest).
   *
   * - `usableWhileRevalidate`: this holds the preferred response (if any)
   *   that's usable to satisfy the client's request, but that must be
   *   (re-)validated in the background.
   *
   * - `usableIfError`: holds an entry (if any) that's usable only in case of an
   *   error reaching the producer while trying to fetch/revalidate the cached
   *   value. If there's a `usableWhileRevalidate` response, this key will
   *   always be empty [because the usableWhileRevalidate response should be
   *   returned before calling the producer, so there's no chance on an error.]
   *
   * - `validatable`: when validation is necessary (either because no usable
   *    response is held by the cache, or the usable response requires
   *    background re-validation), this array holds all entries in the cache
   *    that have validation info -- including, possibly, responses present in
   *    the other returned keys -- and that would be usable were the producer
   *    to confirm (revalidate) that the resource's current state matches the
   *    state identified by the validation info. Otherwise, this array is empty.
   *    These are returned so that the user can make a conditional request for
   *    the latest content that takes into account the validation info (e.g.,
   *    the etags w/ `If-None-Match`) of these saved responses. These responses
   *    are probably stale, but it's possible they're not (e.g., if consumer
   *    used a maxAge directive shorter than the producer's freshness lifetime).
   *
   * The result's content type is narrowed to the spec variants whose id is
   * compatible with `req.id`. So, e.g., if the cache's `Spec` is a union and
   * `req.id` is a literal that only matches one variant, callers don't have to
   * narrow the returned content themselves.
   *
   * Emits one `read` diagnostics message (see `CACHE_READ_CHANNEL_NAME`) per
   * call: the lookup result on success, or `found: "read-failed"` with the
   * error if the store threw (and then the error still propagates). An
   * *aborted* read emits nothing, matching the `throwIfAborted` fast path.
   */
  public async get<Id extends SpecOf<RT>["id"]>(
    req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
    options?: { signal?: AbortSignal },
  ): Promise<CacheLookupResult<SpecForId<SpecOf<RT>, Id>, Validators, Params>> {
    options?.signal?.throwIfAborted();

    const { id, params, directives } = req;
    const resourceType = this.classify(id satisfies ReadonlyDeep<Id> as Id);

    if (this.#closed) {
      if (this.#onGetAfterClose === "throw") {
        this.#logger("trace", "received request when closed and throwing");
        throw new Error("Store has been closed...");
      }
      this.#logger(
        "trace",
        "received request when closed, so returning no entries",
      );
      const res = { validatable: [] };
      publishCacheRead({
        cache: this.name,
        resourceType,
        resourceId: id satisfies ReadonlyDeep<Id> as Id,
        found: foundForLookupResult(res),
      });
      return res;
    }

    const now = new Date();
    const normalizedParams = this.normalizeParams(params);

    this.#logger("trace", "received request", { id, params, normalizedParams });
    this.#logger("trace", "requested entries from the store");

    // Unlike producer invocations, store reads are NOT collapsed: N
    // concurrent identical requests perform N row fetches. If hot-key read
    // load ever warrants deduping them, the right shape is a PENDING-ONLY
    // promise share right here, keyed by (id, normalizedParams) -- never a
    // reuse window (a lookup RESULT is a freshness decision evaluated at a
    // specific `now`, so sharing one across a window serves decisions
    // computed against a stale clock; sharing only while the fetch is
    // in-flight bounds the skew to the read's own duration, which callers
    // already experience). Keying by (id, params) rather than the full
    // request lets different-directive callers share the I/O, because
    // classification (#processCacheEntries) stays per-caller -- which also
    // keeps `read` messages one-per-logical-request. The wrappers would be
    // the wrong layer for this: they'd miss direct get()/getMany() callers
    // and could only collapse whole-request keys. Not built today because a
    // point read is cheap next to the producer calls collapsing exists to
    // protect; the read channel measures per-id read rates, so the evidence
    // would be visible before the need is real.
    const cacheEntries = await this.#dataStore
      .get(id satisfies ReadonlyDeep<Id> as Id, normalizedParams, options)
      .catch((error: unknown) => {
        // A read that FAILED is reported on the channel (one message, same as
        // a successful lookup) before the error propagates, so subscribers can
        // use the read channel as a total denominator -- see
        // CACHE_READ_CHANNEL_NAME. An *aborted* read is not a failed read: the
        // caller cancelled, and aborts already emit nothing here (the
        // `throwIfAborted` at the top of this method rejects before any
        // message), so staying silent keeps that consistent instead of
        // inflating read-failure rates with client cancellations.
        if (options?.signal?.aborted !== true) {
          publishCacheRead({
            cache: this.name,
            resourceType,
            resourceId: id satisfies ReadonlyDeep<Id> as Id,
            found: "read-failed",
            error,
          });
        }
        throw error;
      });

    const res = this.#processCacheEntries(cacheEntries, directives, now, {
      requestIndex: 0,
    });

    publishCacheRead({
      cache: this.name,
      resourceType,
      resourceId: id satisfies ReadonlyDeep<Id> as Id,
      found: foundForLookupResult(res),
    });

    return res;
  }

  /**
   * Gets relevant items from the cache for multiple requests in a single
   * operation. This method is functionally equivalent to calling `get()` for
   * each individual request and concatenating the results, but is optimized by
   * using the store's `getMany` method to batch the underlying data store
   * operations.
   *
   * The result is a tuple typed per-request: each output slot's content type
   * is narrowed to the spec variants compatible with the corresponding input
   * request's id.
   *
   * Emits one `read` diagnostics message PER request -- the lookup result on
   * success, or `found: "read-failed"` with the error for every request in the
   * batch if the underlying store read throws (and then the error still
   * propagates). An *aborted* read emits nothing. All request ids are
   * classified up front, so a classification failure rejects the whole call
   * before touching the store, emitting nothing.
   *
   * @param requests Array of consumer requests to process
   * @returns Promise that resolves to an array of CacheLookupResult objects in
   * the same order as the input requests
   */
  public async getMany<
    const Reqs extends readonly ReadonlyDeep<
      ConsumerRequest<Params, SpecOf<RT>["id"]>
    >[],
  >(
    requests: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<{
    -readonly [K in keyof Reqs]: CacheLookupResult<
      SpecForId<SpecOf<RT>, Extract<Reqs[K]["id"], SpecOf<RT>["id"]>>,
      Validators,
      Params
    >;
  }> {
    options?.signal?.throwIfAborted();

    if (!isNonEmptyArray(requests)) {
      return [] as {
        -readonly [K in keyof Reqs]: CacheLookupResult<
          SpecForId<SpecOf<RT>, Extract<Reqs[K]["id"], SpecOf<RT>["id"]>>,
          Validators,
          Params
        >;
      };
    }

    // Classify every request id up front: a classification failure rejects
    // the whole operation before we touch the store.
    const resourceTypes = mapNonEmpty(requests, (req) => this.classify(req.id));

    const publishRead = (
      requestIndex: number,
      res: {
        usable?: unknown;
        usableWhileRevalidate?: unknown;
        usableIfError?: unknown;
        validatable?: unknown;
      },
    ) => {
      publishCacheRead({
        cache: this.name,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        resourceType: resourceTypes[requestIndex]!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        resourceId: requests[requestIndex]!.id,
        found: foundForLookupResult(res),
      });
    };

    if (this.#closed) {
      if (this.#onGetAfterClose === "throw") {
        this.#logger(
          "trace",
          "received getMany request when closed and throwing",
        );
        throw new Error("Store has been closed...");
      }
      this.#logger(
        "trace",
        "received getMany request when closed, so returning no entries",
      );

      return mapNonEmpty(requests, (_req, i) => {
        const res = { validatable: [] };
        publishRead(i, res);
        return res;
      });
    }

    const now = new Date();

    // Prepare requests for the store's getMany method
    this.#logger("trace", "received getMany request", {
      requestCount: requests.length,
      requests: requests.map((r) => ({ id: r.id, params: r.params })),
    });
    this.#logger("trace", "requested entries from the store via getMany");

    // Use the store's optimized getMany method
    const cacheEntriesForRequests = await this.#dataStore
      .getMany(
        mapNonEmpty(requests, (req) => ({
          // SAFETY: `req.id` is `ReadonlyDeep<SpecOf<RT>["id"]>`, which is the
          // id value itself at runtime (ids are strings); the ReadonlyDeep
          // wrapper just can't *reduce* to the id type while `RT` is an
          // unresolved generic.
          id: req.id as SpecOf<RT>["id"],
          params: this.normalizeParams(req.params),
        })),
        options,
      )
      .catch((error: unknown) => {
        // One `read-failed` message PER REQUEST, not one per call: the channel
        // is one-message-per-lookup, and a batch read is N lookups that all
        // failed together. Emitting one message for the batch would make a
        // subscriber's per-id read counts disagree with the successful path.
        // Aborts stay silent for the reason given in `get`.
        if (options?.signal?.aborted !== true) {
          requests.forEach((req, i) => {
            publishCacheRead({
              cache: this.name,
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              resourceType: resourceTypes[i]!,
              resourceId: req.id,
              found: "read-failed",
              error,
            });
          });
        }
        throw error;
      });

    this.#logger("trace", "received entries from the store via getMany", {
      resultCount: sumBy(cacheEntriesForRequests, (it) => it.length),
    });

    // Process each request and return results in the same order
    return mapNonEmpty(requests, (req, i) => {
      const res = this.#processCacheEntries(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        cacheEntriesForRequests[i]!,
        req.directives,
        now,
        { requestIndex: i },
      );
      publishRead(i, res);
      return res;
    });
  }

  /**
   * Stores ProducerResultResources that it assumes were _just now_ retrieved
   * from the producer. If the result wasn't retrieved just now, its retrieval
   * time can be specified.
   *
   * The (id, content) pairs in `data` are checked against the cache's derived
   * spec at compile time, so a `Story[]` cannot be stored under a `story:...`
   * id, etc.
   *
   * Every entry's id -- primary and supplemental callers alike pass a flat
   * list here -- is classified against the registry up front; any
   * classification failure rejects the call before persisting anything (so a
   * producer minting a malformed id can't write a permanently unreadable
   * row).
   *
   * Emits one `store-entry` diagnostics message PER entry (see
   * `CACHE_STORE_ENTRY_CHANNEL_NAME`).
   */
  public async store(
    data: readonly ProducerResultResource<SpecOf<RT>, Validators, Params>[],
  ): Promise<readonly StoreEntryResult[]> {
    // Classify all entry ids up front -- any failure rejects before we
    // normalize, emit events, or persist anything.
    const resourceTypes = data.map((it) => this.classify(it.id));

    if (this.#closed) {
      if (this.#onStoreAfterClose === "throw") {
        this.#logger(
          "trace",
          "received store request when closed and throwing",
        );
        throw new Error("Store has been closed...");
      }
      this.#logger(
        "trace",
        "received store request after throwing and doing nothing",
      );
      return [];
    }

    const now = new Date();
    const entriesWithTimes = data.map((it) => {
      const entry = normalizeProducerResultResource(
        this.normalizeVary,
        it,
        now,
      );
      return { entry, maxStoreForSeconds: calculateStoreFor(entry, now) };
    });

    this.#logger(
      "trace",
      "storing the following entries with (possibly inferred) storeFor times",
      entriesWithTimes,
    );

    entriesWithTimes.forEach(({ entry, maxStoreForSeconds }) => {
      this.emitter.emit("store", entry, maxStoreForSeconds);
    });

    const results = await this.#dataStore.store(entriesWithTimes);

    // The results array is parallel to the input entries (see Store.store).
    results.forEach(({ relationshipToExistingStoredData }, i) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { entry } = entriesWithTimes[i]!;
      publishCacheStoreEntry({
        cache: this.name,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        resourceType: resourceTypes[i]!,
        resourceId: entry.id,
        vary: entry.vary,
        validators: entry.validators,
        relationshipToExistingStoredData,
      });
    });

    return results;
  }

  /**
   * Deletes all stored entries for resources with the given id (regardless of
   * variant). The id is classified against the registry first; a
   * classification failure rejects the call before touching the store.
   *
   * After `close()`, behaves like {@link Cache.store} (deletes are writes):
   * throws or silently no-ops per the `onStoreAfterClose` option.
   */
  public async delete(id: SpecOf<RT>["id"]): Promise<void> {
    this.classify(id);

    if (this.#closed) {
      if (this.#onStoreAfterClose === "throw") {
        this.#logger(
          "trace",
          "received delete request when closed and throwing",
        );
        throw new Error("Store has been closed...");
      }
      this.#logger(
        "trace",
        "received delete request when closed, so doing nothing",
      );
      return;
    }

    return this.#dataStore.delete(id);
  }

  public async close(timeout?: number) {
    this.#closed = true;
    return (
      this.#dataStore.close?.(timeout) ?? this.#dataStore[Symbol.asyncDispose]()
    );
  }

  public async [Symbol.asyncDispose]() {
    return this.close(60_000);
  }

  /**
   * Processes cache entries for a single request and returns the appropriate
   * CacheLookupResult. This is the core logic shared between get() and getMany().
   */
  #processCacheEntries<Id extends SpecOf<RT>["id"]>(
    entries: readonly Entry<SpecForId<SpecOf<RT>, Id>, Validators, Params>[],
    directives: ReadonlyDeep<ConsumerDirectives>,
    now: Date,
    context: { requestIndex: number },
  ): CacheLookupResult<SpecForId<SpecOf<RT>, Id>, Validators, Params> {
    const classifiedEntries = groupBy(entries, (it) =>
      entryUtils.classify(it, directives, now),
    );

    this.#logger("trace", "classified stored entries for request", {
      requestIndex: context.requestIndex,
      classifiedEntries,
    });

    const usableEntries =
      classifiedEntries[entryUtils.EntryClassification.Usable];

    if (usableEntries) {
      const res = {
        // Non-null assertion is safe because of lodash groupBy mechanics.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        usable: Cache.bestEntry(usableEntries)!,
        validatable: [],
      };

      this.#logger("trace", "chose/returned this data for request", {
        requestIndex: context.requestIndex,
        res,
      });
      return res;
    }

    const validatableEntries = entries.filter(entryUtils.isValidatable);

    const usableWhileRevalidateEntries =
      classifiedEntries[entryUtils.EntryClassification.UsableWhileRevalidate];

    if (usableWhileRevalidateEntries) {
      const res = {
        // Non-null assertion is safe because of lodash groupBy mechanics.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        usableWhileRevalidate: Cache.bestEntry(usableWhileRevalidateEntries)!,
        validatable: validatableEntries,
      };

      this.#logger("trace", "chose/returned this data for request", {
        requestIndex: context.requestIndex,
        res,
      });
      return res;
    }

    const usableIfErrorEntries =
      classifiedEntries[entryUtils.EntryClassification.UsableIfError];

    const res = {
      usableIfError: usableIfErrorEntries
        ? // Non-null assertion is safe because of lodash groupBy mechanics.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          Cache.bestEntry(usableIfErrorEntries)!
        : undefined,
      validatable: validatableEntries,
    };

    this.#logger("trace", "chose/returned this data for request", {
      requestIndex: context.requestIndex,
      res,
    });
    return res;
  }
}

/**
 * Calculates the maximum amount of time -- in seconds! -- that the backing
 * store may store the entry. It considers the producer's requested storeFor
 * time, and when the data will become definitively useless.
 *
 * @param entry The entry who's time-to-store should be calculated
 * @param at The date when the entry will be stored. This effects how long it
 *   should be stored for because, as entries get closer to the end of their
 *   freshness lifetime, the suggested storeFor time may go down (when it isn't
 *   dictated by the producer's directives).
 */
function calculateStoreFor(
  entry: Entry<CacheSpec, AnyValidators, AnyParams>,
  at: Date,
) {
  const producerStoreFor = entry.directives.storeFor;
  const requestedStoreFor =
    producerStoreFor !== undefined
      ? producerStoreFor - entry.initialAge
      : Infinity;

  return Math.max(
    0,
    Math.min(requestedStoreFor, entryUtils.potentiallyUsefulFor(entry, at)),
  );
}

/**
 * The one-entry registry {@link singleTypeCacheOptions} builds. Keyed by an
 * index signature, because the name is a runtime value the caller asked not to
 * think about. Nothing is lost by that: `SpecOf` of this registry is exactly
 * `CacheSpec<string, Content>`, so the id space and the content type stay
 * precise. The only imprecision is the NAME -- `classify()` returns `string`
 * on such a cache rather than the literal. Write the registry out by hand if
 * you want the literal.
 */
type SingleTypeRegistry<Content> = {
  readonly [name: string]: ResourceTypeSpec<string, Content>;
};

/**
 * Builds {@link CacheOptions} for a cache with exactly ONE resource type, so the
 * caller does not have to invent a name for that type or nest a one-entry
 * registry literal:
 *
 * ```ts
 * const cache = new Cache(singleTypeCacheOptions<Json>()({ store, name: "xyz-cache" }));
 * ```
 *
 * The resource type is named after the cache unless `resourceTypeName` says
 * otherwise. That name reaches diagnostics only -- it is never part of a store
 * key -- so naming it after the cache cannot invalidate entries, and it keeps
 * `resourceType` meaningful across caches instead of collapsing every
 * sole-type cache into one shared literal. Spread the result to add anything
 * else {@link CacheOptions} accepts.
 *
 * Curried for the same reason {@link resourceType} is: `Content` cannot be
 * inferred from anything, so it must be given explicitly, and TS has no partial
 * type-argument inference.
 *
 * ## The id space here is always `string`
 *
 * There is deliberately no way to narrow it. A narrower id space needs a real
 * runtime guard (see {@link soleResourceType} for why an asserted one is
 * unsound), and `resourceType` already expresses exactly that -- at which
 * point naming the entry is the smaller half of the job:
 *
 * ```ts
 * new Cache({
 *   store,
 *   name: "tickets",
 *   resourceTypes: {
 *     tickets: resourceType<Schema>()({ matches: idStartsWith("ticket:") }),
 *   },
 * });
 * ```
 *
 * A `validateId` option was tried here and dropped. It made the guard a second
 * inference site alongside `store`, and an untyped `new MemoryStore()` won --
 * silently collapsing the id space back to `string`, i.e. reintroducing the
 * asserted-but-unenforced narrowing this change exists to remove. Forcing the
 * guard to win (`NoInfer`) then made every caller spell out the store spec,
 * which is a worse common case in exchange for a rare one the two lines above
 * already serve.
 */
export function singleTypeCacheOptions<Content>(): <
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  options: Omit<
    CacheOptions<SingleTypeRegistry<Content>, Validators, Params>,
    "resourceTypes"
  > & {
    /** Defaults to the cache's own `name`. */
    resourceTypeName?: string;
  },
) => CacheOptions<SingleTypeRegistry<Content>, Validators, Params> {
  return ({ resourceTypeName, ...rest }) => ({
    ...rest,
    resourceTypes: {
      [resourceTypeName ?? rest.name]: soleResourceType<Content>(),
    },
  });
}
