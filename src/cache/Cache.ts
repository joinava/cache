import { sumBy } from "es-toolkit";
import { isNonEmptyArray, mapNonEmpty } from "type-party/runtime/nonempty.js";
import type { ReadonlyDeep } from "type-fest";
import type { PickEach } from "type-party";
import {
  type CacheReadMessage,
  cacheReadStoreChannel,
  cacheStoreEntryChannel,
  publishCacheRead,
  readOutcomeOf,
  publishCacheStoreEntry,
} from "../diagnostics.js";
import type { ReadonlyConsumerRequest } from "../types/03_ConsumerRequest.js";
import {
  type Entry,
  type NormalizeParamName,
  type NormalizeParamValue,
} from "../types/06_Normalization.js";
import {
  type AnyParams,
  type AnyParamValue,
  type AnyValidators,
  type CacheSpec,
  type ConsumerDirectives,
  type Logger,
  type ProducerResultResource,
  type ResourceTypeName,
  type ResourceTypes,
  type SpecForId,
  type SpecOf,
  type Store,
  type StoreEntryResult,
  type StoreGetManyRequest,
  type Vary,
} from "../types/index.js";
import {
  AmbiguousResourceTypeError,
  classifyIdAgainst,
  resourceTypesEntries,
  UnclassifiableIdError,
  type ResourceTypesEntries,
} from "../resourceTypeClassification.js";
import { type Bind1 } from "../types/utils.js";
import {
  normalizeParams,
  normalizeProducerResultResource,
  normalizeVary,
} from "../utils/normalization.js";
import * as entryUtils from "../utils/normalizedProducerResultResourceHelpers.js";
import {
  classifyCacheEntries,
  type CacheLookupResult,
} from "../utils/cacheHelpers.js";
import type { CacheOptions } from "./CacheOptions.js";
import { Batcher } from "../scheduling/batcher.js";
import { PendingPromisesTracker } from "../scheduling/pendingPromisesTracker.js";
import {
  readStoreObserved,
  raceWithSignal,
  assertUnreachable,
  defaultLoggersByComponent,
  timeSlicedMapNonEmpty,
} from "../utils/utils.js";

/**
 * The default `readBatching.maxBatchSize`. It is larger than the producer
 * default (`DEFAULT_PRODUCER_BATCH_SIZE`, 20), because a wrapped `getMany` sends one `Cache.get` per item,
 * and every automatic batch is its own concurrent Store call: a 1,000-item
 * set makes 10 Store calls at 100, and 50 at 20. It stays well below a full
 * Postgres chunk (1,000 requests), because stored entries can be large and
 * one call returns every matching payload.
 */
const DEFAULT_READ_BATCH_SIZE = 100;

/** Options for {@link Cache.get} and {@link Cache.getUnbatched}. */
export type ReadOptions = { signal?: AbortSignal | undefined };

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
 * the get/getUnbatched/store methods narrow the content type based on the id of
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
  StoreSupportedTypes extends CacheSpec = SpecOf<RT>,
> {
  readonly #logger: Bind1<Logger, "cache">;
  /**
   * The Store, typed over this cache's own spec. See the constructor for why
   * that view of a wider Store is sound.
   */
  readonly #dataStore: Store<SpecOf<RT>, Validators, Params>;
  /**
   * Batches the reads of `get`. Set iff the Store has getMany. A get-only
   * Store reads each request directly. Reads never share work (see the Store
   * read in get), so a batcher is all that reads need.
   */
  readonly #readBatcher:
    | Batcher<
        StoreGetManyRequest<SpecOf<RT>, Params>,
        Entry<SpecOf<RT>, Validators, Params>[]
      >
    | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  /**
   * Accepted operations that can still reach the Store. close() waits for
   * them, then closes the Store. So one tracked operation must cover
   * every step of a public call that ends in a Store call, including steps
   * such as normalization that run before the call starts. Each public call
   * tracks itself, except batched reads: the read batcher tracks its own
   * dispatches, and close() drains it first.
   */
  readonly #operations = new PendingPromisesTracker();
  readonly #onGetAfterClose: "throw" | "act-empty";
  readonly #onStoreAfterClose: "throw" | "no-op";
  readonly #resourceTypeEntries: ResourceTypesEntries<RT>;

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
   * a bare-`RT` member, wrapping a cache built over a narrowed one-entry
   * registry would collapse `RT` to its constraint (producer `req.id` would
   * become plain `string`).
   */
  public readonly resourceTypes: RT;

  public readonly normalizeParamName: NormalizeParamName<Params>;
  public readonly normalizeParamValue: NormalizeParamValue<Params>;

  constructor(
    options: CacheOptions<RT, Validators, Params, StoreSupportedTypes>,
  ) {
    const unboundLogger = options.logger ?? defaultLoggersByComponent.cache;
    this.#logger = unboundLogger.bind(null, "cache");
    // SAFETY: `CoveringStore` already checked that the Store supports at least
    // `SpecOf<RT>`. The Store's spec may be wider, and `Store` is invariant in
    // it, so TS cannot see the narrower view as assignable. The view is sound
    // because the cache only ever sends the Store ids and entries of its own
    // spec, and a Store returns only entries for the ids it was asked for.
    this.#dataStore = options.store as unknown as Store<
      SpecOf<RT>,
      Validators,
      Params
    >;
    this.#readBatcher =
      this.#dataStore.getMany === undefined
        ? undefined
        : new Batcher({
            maxBatchSize: DEFAULT_READ_BATCH_SIZE,
            ...options.readBatching,
            ...(options.logger ? { logger: options.logger } : {}),
            dispatch: (reads, { autoBatched }) =>
              this.#readStore(
                reads.map(({ input }) => input),
                undefined,
                {
                  autoBatched,
                  queueWaitTotalMs: reads.reduce(
                    (sum, read) => sum + read.queueWaitMs,
                    0,
                  ),
                },
              ),
          });
    this.#onGetAfterClose = options.onGetAfterClose ?? "throw";
    this.#onStoreAfterClose = options.onStoreAfterClose ?? "throw";
    this.name = options.name;
    this.resourceTypes = options.resourceTypes;
    this.#resourceTypeEntries = resourceTypesEntries(options.resourceTypes);
    this.normalizeParamName = options.normalizeParamName ?? ((it) => it);
    this.normalizeParamValue =
      options.normalizeParamValue ??
      (<K extends keyof Params>(_name: K, v: AnyParamValue) =>
        v as Params[K] & AnyParamValue);
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
   * Classification runs on every get/getUnbatched request id, every stored entry
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
    const classification = classifyIdAgainst(this.#resourceTypeEntries, id);
    switch (classification.matched) {
      case "one": {
        return classification.name;
      }
      case "none": {
        throw new UnclassifiableIdError({
          cacheName: this.name,
          id,
          cause: classification.cause,
        });
      }
      case "many": {
        throw new AmbiguousResourceTypeError({
          cacheName: this.name,
          id,
          matchedResourceTypes: classification.names,
        });
      }
      default: {
        return assertUnreachable(classification);
      }
    }
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
   *
   * A bulk-capable Store accumulates reads from many `get` calls into shared
   * Store calls. Use {@link Cache.getUnbatched} to send a known set as one
   * Store call instead.
   *
   * This is a hot path. A wrapped client's `getMany` calls `get` once per
   * item, in a loop, and lets the read scheduler batch the Store calls. So
   * `get` keeps per-call work small: one request, no per-call arrays, and no
   * time slicing or awaits beyond the Store read. That is why it does not
   * share `getUnbatched`'s pipeline. The two share their per-request steps
   * instead: the closed-cache check, the `read` messages, and the lookup.
   *
   * If Store.getMany returns an Error in this request's slot, only this caller
   * rejects. Other callers in the automatic batch retain their hits or misses.
   * A rejected store promise rejects every non-cancelled caller in the batch.
   */
  public async get<Id extends SpecOf<RT>["id"]>(
    req: ReadonlyConsumerRequest<Params, Id>,
    options?: ReadOptions,
  ): Promise<CacheLookupResult<SpecForId<SpecOf<RT>, Id>, Validators, Params>> {
    options?.signal?.throwIfAborted();
    // Classify up front: a classification failure rejects before we touch the
    // store.
    const resourceType = this.classify(req.id);

    const target: ReadTarget = { resourceType, id: req.id, requestIndex: 0 };
    const readStartedAt = performance.now();

    if (this.#actEmptyBecauseClosed("get")) {
      this.#publishRead(target, readStartedAt, { found: "none" });
      return { validatable: [] };
    }

    const now = new Date();
    this.#logger("trace", "received get request", {
      id: req.id,
      params: req.params,
    });

    const storeRequest = {
      id: req.id,
      params: this.normalizeParams(req.params),
    };

    // Unlike producer invocations, store reads are NOT collapsed: N concurrent
    // identical requests get N separate lookup results. A point read is cheap
    // next to the producer calls collapsing exists to protect.
    //
    // Read batching does not change that. It batches the QUERY only: the
    // accumulated reads share one `store.getMany()` call, but each request
    // still gets its own slot of that call's result, and the code below still
    // classifies it against this call's own `now`. Requests share one query,
    // never one result.
    //
    // Worth knowing if that ever changes: reads must not reuse results across
    // a time window the way producer invocations do. A lookup result is a
    // freshness decision evaluated at a specific `now`, so replaying one
    // serves decisions computed against a stale clock. Only a PENDING-only
    // promise share is sound, which bounds the skew to the read's own
    // duration.
    const read =
      this.#readBatcher === undefined
        ? // The batcher tracks its own dispatches (`close` drains it), so only
          // this direct read needs tracking here.
          this.#operations
            .run(() => this.#readStore([storeRequest] as const, options))
            .then(([entries]) => {
              if (entries instanceof Error) throw entries;
              return entries;
            })
        : this.#readBatcher.enqueue([
            {
              input: storeRequest,
              ...(options?.signal ? { signal: options.signal } : {}),
            },
          ])[0]!.result;

    const cacheEntries = await raceWithSignal(read, options?.signal).catch(
      (error: unknown) => {
        this.#publishReadFailed([target], readStartedAt, error, options);
        throw error;
      },
    );

    this.#logger("trace", "received entries from the store", {
      resultCount: cacheEntries.length,
    });

    // The batcher is not typed per id, so the entries are narrowed here. The
    // Store returns only entries for the requested id.
    return this.#lookup(
      cacheEntries as Entry<SpecForId<SpecOf<RT>, Id>, Validators, Params>[],
      req.directives,
      now,
      target,
      readStartedAt,
    );
  }

  /**
   * Read a known set as one Store call, sent promptly. The call never joins
   * the automatic accumulation that {@link Cache.get} uses, and the batch
   * limit does not split it. A Store without `getMany` reads each request
   * with `get` instead.
   *
   * Preserves positional successes and operational errors. Cancellation and
   * invalid contracts reject the complete public call.
   *
   * The result is a tuple typed per-request: each output slot's content type
   * is narrowed to the spec variants compatible with the corresponding input
   * request's id. A slot holds an Error when the read failed for that request.
   *
   * Emits one `read` diagnostics message PER request: the lookup result on
   * success, or `found: "read-failed"` with the error for a failed request. An
   * *aborted* read emits nothing. All request ids are classified up front, so
   * a classification failure rejects the whole call before touching the store,
   * emitting nothing.
   *
   * @param requests Array of consumer requests to process
   * @returns Promise that resolves to one CacheLookupResult or Error per
   * request, in the same order as the input requests
   */
  public async getUnbatched<
    const Reqs extends readonly ReadonlyConsumerRequest<
      Params,
      SpecOf<RT>["id"]
    >[],
  >(
    requests: Reqs,
    options?: ReadOptions,
  ): Promise<GetUnbatchedResults<Reqs, RT, Validators, Params>> {
    options?.signal?.throwIfAborted();
    if (!isNonEmptyArray(requests)) {
      return [] as GetUnbatchedResults<Reqs, RT, Validators, Params>;
    }

    // Classify every request id up front: a classification failure rejects
    // the whole operation before we touch the store.
    const targets: readonly ReadTarget[] = mapNonEmpty(
      requests,
      (req, requestIndex): ReadTarget => ({
        resourceType: this.classify(req.id),
        id: req.id,
        requestIndex,
      }),
    );
    const readStartedAt = performance.now();

    if (this.#actEmptyBecauseClosed("getUnbatched")) {
      return mapNonEmpty(requests, (_req, i) => {
        this.#publishRead(targets[i]!, readStartedAt, { found: "none" });
        return { validatable: [] };
      }) as GetUnbatchedResults<Reqs, RT, Validators, Params>;
    }

    const now = new Date();
    this.#logger("trace", "received getUnbatched request", {
      requestCount: requests.length,
      requests: requests.map((r) => ({ id: r.id, params: r.params })),
    });
    this.#logger("trace", "requested entries from the store");

    // Store requests retain separate slots, even when their IDs are equal.
    // Freshness belongs to each logical read, never to shared physical work.
    //
    // The call is accepted, so close() must wait for its read. Normalization
    // can yield to the event loop before the read starts, so one tracked
    // operation covers normalization and the read.
    const storeRead = this.#operations.run(async () =>
      this.#readStore(
        await timeSlicedMapNonEmpty(requests, (req) => ({
          id: req.id,
          params: this.normalizeParams(req.params),
        })),
        options,
      ),
    );

    const cacheEntriesForRequests = await raceWithSignal(
      storeRead,
      options?.signal,
    ).catch((error: unknown) => {
      // One message PER REQUEST, not one per call, before the error
      // propagates: the channel is one-message-per-lookup, so subscribers can
      // use it as a total denominator. A failed known-set read is N lookups
      // that all failed together. One message for the set would make a
      // subscriber's per-id read counts disagree with the successful path.
      this.#publishReadFailed(targets, readStartedAt, error, options);
      throw error;
    });

    this.#logger("trace", "received entries from the store", {
      resultCount: sumBy(cacheEntriesForRequests, (it) =>
        it instanceof Error ? 0 : it.length,
      ),
    });

    // Classifying entries is synchronous, so yield between requests to keep a
    // large known set from blocking the event loop.
    return await timeSlicedMapNonEmpty(requests, (req, i) => {
      const cacheEntries = cacheEntriesForRequests[i]!;
      const target = targets[i]!;
      if (cacheEntries instanceof Error) {
        this.#publishRead(target, readStartedAt, {
          found: "read-failed",
          error: cacheEntries,
        });
        return cacheEntries;
      }

      return this.#lookup(
        cacheEntries,
        req.directives,
        now,
        target,
        readStartedAt,
      );
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
    return await this.#operations.run(() => this.#store(data));
  }

  async #store(
    data: readonly ProducerResultResource<SpecOf<RT>, Validators, Params>[],
  ): Promise<readonly StoreEntryResult[]> {
    // Classify all entry ids up front -- any failure rejects before we
    // normalize, emit events, or persist anything.
    const resourceTypes = data.map((it) => this.classify(it.id));

    if (this.#actEmptyBecauseClosed("store")) return [];

    const now = new Date();
    const entriesWithTimes = data.map((it) => {
      const entry = normalizeProducerResultResource(
        this.normalizeVary,
        it,
        now,
      );
      return {
        entry,
        maxStoreForSeconds: entryUtils.calculateStoreFor(entry, now),
      };
    });

    this.#logger(
      "trace",
      "storing the following entries with (possibly inferred) storeFor times",
      entriesWithTimes,
    );

    // `store()` already tracks this whole method, so close() waits for it.
    const results = await this.#dataStore.store(entriesWithTimes);

    // The results array is parallel to the input entries (see Store.store).
    // One message PER ENTRY -- primary plus every supplemental -- so this is
    // the package's other O(entries) diagnostics payload, and `publish` would
    // discard each message without preventing its construction. Hence the
    // subscriber test around the whole loop rather than inside it.
    if (cacheStoreEntryChannel.hasSubscribers) {
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
    }

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

    if (this.#actEmptyBecauseClosed("delete")) return;

    return this.#operations.run(() => this.#dataStore.delete(id));
  }

  /**
   * Applies the after-close policy to one operation. Returns false while the
   * cache is open. After close, it throws under the `"throw"` policy, and
   * otherwise returns true: the caller then acts empty, so a read finds
   * nothing and a write does nothing. Reads follow `onGetAfterClose`; stores
   * and deletes follow `onStoreAfterClose`.
   */
  #actEmptyBecauseClosed(
    operation: "get" | "getUnbatched" | "store" | "delete",
  ): boolean {
    if (!this.#closed) return false;

    const isRead = operation === "get" || operation === "getUnbatched";
    const policy = isRead ? this.#onGetAfterClose : this.#onStoreAfterClose;
    if (policy === "throw") {
      this.#logger(
        "trace",
        `received ${operation} request when closed and throwing`,
      );
      throw new Error("Store has been closed...");
    }

    this.#logger(
      "trace",
      `received ${operation} request when closed, so ${isRead ? "returning no entries" : "doing nothing"}`,
    );
    return true;
  }

  /** Whether close has started; pending-write overlays must not bypass closure. */
  public get closed(): boolean {
    return this.#closed;
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;

    this.#closed = true;
    // A batched read that `get()` accepted before this call still runs. The
    // batcher's close sends the queued ones synchronously, and waits for
    // every read it accepted.
    const readsClosed = this.#readBatcher?.close();
    this.#closePromise = (async () => {
      await readsClosed;
      await this.#operations.drain();
      await this.#dataStore.close();
    })();

    return this.#closePromise;
  }

  public async [Symbol.asyncDispose]() {
    return this.close();
  }

  #readStore<
    const Requests extends readonly StoreGetManyRequest<SpecOf<RT>, Params>[],
  >(
    requests: Requests,
    options?: ReadOptions,
    batch?: { autoBatched: boolean; queueWaitTotalMs: number },
  ) {
    const observed = cacheReadStoreChannel.hasSubscribers;
    return readStoreObserved(
      this.#dataStore,
      requests,
      options,
      observed
        ? (event) => {
            cacheReadStoreChannel.publish({
              cache: this.name,
              operation: event.operation,
              autoBatched: batch?.autoBatched ?? false,
              outcome: event.outcome,
              requestCount: event.requestCount,
              failedRequestCount: event.failedRequestCount,
              entryCount: event.entryCount,
              durationMs: event.durationMs,
              queueWaitTotalMs: batch?.queueWaitTotalMs ?? 0,
            });
          }
        : undefined,
    );
  }

  /**
   * Turns one request's stored entries into its CacheLookupResult, and
   * publishes the request's `read` message. Shared entry helpers own
   * classification and selection, including the selected entry. This method
   * adds request-scoped logging for get() and getUnbatched(). Pending-write
   * lookups use the same helpers, so they cannot drift from the cache's
   * selection rules.
   */
  #lookup<Spec extends CacheSpec>(
    entries: readonly Entry<Spec, Validators, Params>[],
    directives: ReadonlyDeep<ConsumerDirectives>,
    now: Date,
    target: ReadTarget,
    readStartedAt: number,
  ): CacheLookupResult<Spec, Validators, Params> {
    const { result, classifiedEntries } = classifyCacheEntries(
      entries,
      directives,
      now,
    );
    this.#logger("trace", "classified stored entries for request", {
      requestIndex: target.requestIndex,
      classifiedEntries,
    });
    this.#logger("trace", "chose/returned this data for request", {
      requestIndex: target.requestIndex,
      res: result,
    });
    this.#publishRead(target, readStartedAt, readOutcomeOf(result));
    return result;
  }

  /** Publishes one request's `read` message. */
  #publishRead(
    target: ReadTarget,
    readStartedAt: number,
    outcome: PickEach<CacheReadMessage, "found" | "vary" | "error">,
  ): void {
    publishCacheRead({
      cache: this.name,
      resourceType: target.resourceType,
      resourceId: target.id,
      durationMs: performance.now() - readStartedAt,
      ...outcome,
    });
  }

  /**
   * Publishes `found: "read-failed"` for each request of a failed Store read.
   * An *aborted* read is not a failed read: the caller cancelled, and aborts
   * already emit nothing (the `throwIfAborted` at the top of each read method
   * rejects before any message), so staying silent keeps that consistent
   * instead of inflating read-failure rates with client cancellations.
   */
  #publishReadFailed(
    targets: readonly ReadTarget[],
    readStartedAt: number,
    error: unknown,
    options: ReadOptions | undefined,
  ): void {
    if (options?.signal?.aborted === true) return;

    targets.forEach((target) => {
      this.#publishRead(target, readStartedAt, { found: "read-failed", error });
    });
  }
}

/** One request of a read, as its `read` message and trace logs name it. */
type ReadTarget = {
  readonly resourceType: string;
  readonly id: string;
  readonly requestIndex: number;
};

/**
 * {@link Cache.getUnbatched}'s return type: one {@link CacheLookupResult} per
 * request, each narrowed to the spec variants its own request's id selects.
 * Named because the signature and both early returns (empty input, closed
 * cache) spell it.
 */
export type GetUnbatchedResults<
  Reqs extends readonly { id: string }[],
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  -readonly [K in keyof Reqs]:
    | Error
    | CacheLookupResult<
        SpecForId<SpecOf<RT>, Extract<Reqs[K]["id"], SpecOf<RT>["id"]>>,
        Validators,
        Params
      >;
};
