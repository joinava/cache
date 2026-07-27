import type { CacheSpec } from "./00_CacheSpec.js";
import type { AnyParams } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";
import type {
  Entry,
  EntryForId,
  NormalizedParams,
} from "./06_Normalization.js";

/**
 * NB: The store shouldn't mutate its input here at all, but we can't use
 * ReadonlyDeep on each entry because TS can't prove, when the cache invokes
 * store(), that the content type `T` is assignable to `ReadonlyDeep<T>` for
 * all `T` (even though we know it clearly should be).
 */
export type StoreEntryInput<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  readonly entry: Entry<Spec, Validators, Params>;
  readonly maxStoreForSeconds: number;
};

/**
 * Describes how a stored entry's value relates to what was already stored for
 * the same slot, based solely on the entry's `validators`.
 *
 * - "is-new":    the (id, vary) slot held no live entries when this entry was
 *                stored (nothing to compare against).
 * - "unchanged": the slot was non-empty and the entry's validators deep-equal
 *                the validators of the currently-stored entry with the NEWEST
 *                birth date (see entryUtils.birthDate) for that slot.
 * - "changed":   the slot was non-empty and the entry's validators do NOT
 *                deep-equal that newest-birth-date entry's validators.
 *
 * The comparison is a structural, order-independent deep-equality over the
 * whole opaque `validators` object; no validator key is privileged.
 *
 * "Live" is defined by the store's own read semantics: if a store physically
 * holds records that it would not return in response to a `get` (e.g.,
 * records it considers expired but has not yet vacuumed), those records must
 * NOT be considered for the purposes of this flag -- an incoming entry whose
 * slot holds only such records is "is-new".
 *
 * When multiple stored entries share the newest birth date but differ in
 * validators (not reachable by any current store, which keep <= 1 entry per
 * slot), which one is treated as the reference is implementation-defined.
 */
export type StoreEntryRelationship = "unchanged" | "changed" | "is-new";

export type StoreEntryResult = {
  /**
   * Omitted when the store did not perform the check, OR when the incoming
   * entry has empty validators (no validators => nothing to compare on).
   */
  readonly relationshipToExistingStoredData?: StoreEntryRelationship;
};

/**
 * This interfaces defines the methods that must be supported by "stores",
 * which are instances responsible for actually storing/querying cache entries
 * (on disk, in memory, in a database, etc). The type params have the same
 * meanings as in the ProducerResult type.
 *
 * `Spec` is the union of cache key shapes the store can hold; see
 * {@link CacheSpec}. The `get`/`getMany` methods are generic over the
 * specific id of an incoming request so that the returned entries' content
 * types are narrowed to those compatible with that id.
 */
export type Store<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  in out Params extends AnyParams,
> = {
  /**
   * This method returns stored cache entries -- regardless of whether they're
   * fresh -- that are associated with the provided `id` and for which the
   * `vary` value of the entry is _a subset_ of the parameters in `params`. In
   * other words, entries for which the ids match and the request contained at
   * least all the same params with the same values as the producer indicated
   * the entry varies on. This is the primary method called to find cache
   * entries that could satisfy a consumer's request.
   *
   * Stores aren't required to return every matching entry that's ever been
   * passed to them for storage (e.g., because stores may have to evict entries
   * from time to time), but all the returned entries must match per above.
   *
   * Note: one could imagine this method only receiving the resource `id`, and
   * being tasked only with returning all entries matching that `id`; then, the
   * `Cache` class would filter down those entries to the ones that match the
   * incoming request's parameters, in the same way the `Cache` class determines
   * which returned entries satisfy the request's `ConsumerDirectives`. However,
   * structuring the code that way would've precluded Store implementations from
   * using the request params to optimize their implementations -- e.g., by
   * pushing some filters derived from the request params into the queries the
   * Store issues to the underlying db, to avoid having to transfer irrelevant
   * variants' entries over the network at all or keep them in JS memory.
   *
   * Therefore, this design gives stores a higher performance ceiling -- but the
   * cost is that store implementations have to make sure that they don't return
   * entries whose variants are incompatible with the incoming params. Doing
   * that in a way that's more performant than simply fetching stored entries by
   * resource `id` and then filtering them in memory turns out to be quite hard
   * in most cases. So, stores that don't care about this last bit of
   * performance (and are confident they won't have to deal with a huge number
   * of variants per resource), can simply fetch all entries by resource id and
   * then use the exported {@link variantMatchesRequest} function to provide all
   * the logic for filtering down those entries in memory before returning them.
   *
   * @param id The id of the resource whose cache entries should be returned.
   * @param params The request parameters, with both the names and values of the
   *   params normalized.
   */
  get<Id extends Spec["id"]>(
    id: Id,
    params: Readonly<NormalizedParams<Params>>,
    options?: { signal?: AbortSignal },
  ): Promise<EntryForId<Spec, Validators, Params, Id>[]>;

  /**
   * This method returns stored cache entries for multiple resources in a single
   * operation. It takes an array of requests, each containing an `id` and
   * `params`, and returns an array whose elements are arrays of matching
   * entries for each request.
   *
   * This method follows the same matching logic as the `get` method: entries
   * are returned if their `vary` value is a subset of the provided params.
   * Stores may optimize this operation by batching queries or using bulk
   * operations when possible.
   *
   * The returned arrays' element types are narrowed per-request: each output
   * slot's entries are typed against the spec variants compatible with the
   * corresponding input request's id.
   *
   * @param requests Array of requests, each containing an id and params for the
   *   resource whose cache entries should be returned.
   */
  getMany<const Reqs extends readonly StoreGetManyRequest<Spec, Params>[]>(
    requests: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>>;

  /**
   * This method stores a list of cache entries. This method's return promise
   * should reject if storage fails, but specific errors are not currently
   * defined.
   */
  store(
    entries: readonly StoreEntryInput<Spec, Validators, Params>[],
  ): Promise<readonly StoreEntryResult[]>;

  /**
   * Deletes all stored entries for resources with the given id.
   * Used to support cache invalidation, which usually requires deleting all of
   * a resource's cached entries, regardless of variant. For example, in HTTP a
   * `POST /x` request has to invalidate all stored variants of `GET /x`,
   * whether they had `Content-Language: en-US` or `Content-Language: de-DE`.
   */
  delete(id: Spec["id"]): Promise<void>;

  /**
   * This method should lead the store to free any resources that it's managing,
   * in preparation for a graceful shutdown. The promise it returns should
   * resolve when those resources have been freed. If the store owns a database
   * connection, closing that is part of this function's responsibility; however,
   * if the store has a db client/connection passed in, it's up to the caller to
   * manage that.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Same as Symbol.asyncDispose, but with a timeout. If you implement both this
   * and Symbol.asyncDispose, Symbol.asyncDispose should simply call close with
   * a default timeout.
   */
  close?(timeout?: number): Promise<void>;
};

/**
 * The shape of a single request passed to {@link Store.getMany}.
 *
 * Exposed as a named type to keep the `getMany` signature readable and to make
 * it easy for store implementations to type their own helpers.
 *
 * Note: this type is intentionally NOT distributive over `Spec`. The id in a
 * single request can be any of the ids supported by the cache; the per-id
 * narrowing of returned content is done by the generic `Reqs` parameter on
 * the `Store.getMany` signature, which uses each request's literal `id` to
 * pick the matching `Spec` variant.
 */
export type StoreGetManyRequest<
  Spec extends CacheSpec,
  Params extends AnyParams,
> = {
  readonly id: Spec["id"];
  readonly params: Readonly<NormalizedParams<Params>>;
};

export type StoreGetManyResult<
  Spec extends CacheSpec,
  Reqs extends readonly { id: Spec["id"] }[],
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  -readonly [K in keyof Reqs]: EntryForId<
    Spec,
    Validators,
    Params,
    Reqs[K]["id"]
  >[];
};
