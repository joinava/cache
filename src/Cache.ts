import { groupBy, sortBy, sumBy } from "es-toolkit";
import { EventEmitter } from "events";
import type { InvariantOf, ReadonlyDeep } from "type-fest";
import { isNonEmptyArray, mapNonEmpty } from "type-party/runtime/nonempty.js";
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
  type SpecForId,
  type Store,
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

type OnRequestAfterClose = "throw" | "return-nothing";

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
 * The cache is parameterized over a {@link CacheSpec}, which pairs each `id`
 * type with the corresponding `content` type. In the simple case, all ids
 * return the same kind of content, and `Spec` can stay as the default. To
 * support multiple id-to-content mappings within a single cache, pass a union
 * of CacheSpecs; the cache's get/store/getMany methods will then narrow the
 * content type based on the id of each request, and reject mismatched
 * (id, content) pairs at compile time.
 *
 * TODO: support the concept of warnings.
 * See https://tools.ietf.org/html/rfc7234#section-5.5
 */
export default class Cache<
  Spec extends CacheSpec = CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  in out Params extends AnyParams = AnyParams,
> {
  readonly #logger: Bind1<Logger, "cache">;
  readonly #dataStore: Store<Spec, Validators, Params>;
  #closed = false;
  readonly #onGetAfterClose: OnRequestAfterClose;
  readonly #onStoreAfterClose: OnRequestAfterClose;

  public readonly emitter = new EventEmitter();
  public readonly normalizeParamName: NormalizeParamName<Params>;
  public readonly normalizeParamValue: NormalizeParamValue<Params>;

  /**
   * @param dataStore The backing store that will actually hold cache entries.
   */
  constructor(
    // note: the Store interface should _already_ be invariant in its Params,
    // but TS's underlying handling of functions as always bivariant (which the
    // compiler tries to hide/override in some cases under strictFunctionTypes,
    // but this doesn't apply to class methods; see
    // https://www.typescriptlang.org/tsconfig/#strictFunctionTypes) means that
    // we have to use `InvariantOf<Params>` explicitly to get the type errors we
    // want.
    dataStore: Store<Spec, Validators, InvariantOf<Params>>,
    options: {
      logger?: Logger;
      onGetAfterClose?: OnRequestAfterClose;
      onStoreAfterClose?: OnRequestAfterClose;
      normalizeParamName?: NormalizeParamName<Params>;
      normalizeParamValue?: NormalizeParamValue<Params>;
    } = {},
  ) {
    const unboundLogger = options.logger ?? defaultLoggersByComponent.cache;
    this.#logger = unboundLogger.bind(null, "cache");
    this.#dataStore = dataStore;
    this.#onGetAfterClose = options.onGetAfterClose ?? "throw";
    this.#onStoreAfterClose = options.onStoreAfterClose ?? "throw";
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
   */
  public async get<Id extends Spec["id"]>(
    req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
    options?: { signal?: AbortSignal },
  ): Promise<CacheLookupResult<SpecForId<Spec, Id>, Validators, Params>> {
    options?.signal?.throwIfAborted();

    if (this.#closed) {
      if (this.#onGetAfterClose === "throw") {
        this.#logger("trace", "received request when closed and throwing");
        throw new Error("Store has been closed...");
      }
      this.#logger(
        "trace",
        "received request when closed, so returning no entries",
      );
      return {
        validatable: [],
      };
    }

    const { id, params, directives } = req;
    const now = new Date();
    const normalizedParams = this.normalizeParams(params);

    this.#logger("trace", "received request", { id, params, normalizedParams });
    this.#logger("trace", "requested entries from the store");

    const cacheEntries = await this.#dataStore.get(
      id satisfies ReadonlyDeep<Id> as Id,
      normalizedParams,
      options,
    );

    return this.#processCacheEntries(cacheEntries, directives, now, {
      requestIndex: 0,
    });
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
   * @param requests Array of consumer requests to process
   * @returns Promise that resolves to an array of CacheLookupResult objects in
   * the same order as the input requests
   */
  public async getMany<
    const Reqs extends readonly ReadonlyDeep<
      ConsumerRequest<Params, Spec["id"]>
    >[],
  >(
    requests: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<{
    -readonly [K in keyof Reqs]: CacheLookupResult<
      SpecForId<Spec, Reqs[K]["id"]>,
      Validators,
      Params
    >;
  }> {
    options?.signal?.throwIfAborted();

    if (!isNonEmptyArray(requests)) {
      return [] as {
        -readonly [K in keyof Reqs]: CacheLookupResult<
          SpecForId<Spec, Reqs[K]["id"]>,
          Validators,
          Params
        >;
      };
    }

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

      return mapNonEmpty(requests, () => ({ validatable: [] }));
    }

    const now = new Date();

    // Prepare requests for the store's getMany method
    this.#logger("trace", "received getMany request", {
      requestCount: requests.length,
      requests: requests.map((r) => ({ id: r.id, params: r.params })),
    });
    this.#logger("trace", "requested entries from the store via getMany");

    // Use the store's optimized getMany method
    const cacheEntriesForRequests = await this.#dataStore.getMany(
      mapNonEmpty(requests, (req) => ({
        id: req.id,
        params: this.normalizeParams(req.params),
      })),
      options,
    );

    if (cacheEntriesForRequests.length !== requests.length) {
      throw new Error(
        `Store.getMany contract violation: expected one result array per request ` +
          `(expected ${requests.length}, received ${cacheEntriesForRequests.length})`,
      );
    }

    this.#logger("trace", "received entries from the store via getMany", {
      resultCount: sumBy(cacheEntriesForRequests, (it) => it.length),
    });

    // Process each request and return results in the same order
    return mapNonEmpty(requests, (req, i) =>
      this.#processCacheEntries(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        cacheEntriesForRequests[i]!,
        req.directives,
        now,
        { requestIndex: i },
      ),
    );
  }

  /**
   * Stores ProducerResultResources that it assumes were _just now_ retrieved
   * from the producer. If the result wasn't retrieved just now, its retrieval
   * time can be specified.
   *
   * The (id, content) pairs in `data` are checked against the cache's `Spec`
   * at compile time, so a `Story[]` cannot be stored under a `story:...` id,
   * etc.
   */
  public async store(
    data: readonly ProducerResultResource<Spec, Validators, Params>[],
  ) {
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
      return;
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

    return this.#dataStore.store(entriesWithTimes);
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
  #processCacheEntries<Id extends Spec["id"]>(
    entries: readonly Entry<SpecForId<Spec, Id>, Validators, Params>[],
    directives: ReadonlyDeep<ConsumerDirectives>,
    now: Date,
    context: { requestIndex: number },
  ): CacheLookupResult<SpecForId<Spec, Id>, Validators, Params> {
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
