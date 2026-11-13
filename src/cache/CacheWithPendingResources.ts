import type { PublicInterface } from "type-party";
import type { ReadonlyDeep } from "type-fest";

import type Cache from "./Cache.js";
import type { ReadOptions } from "./Cache.js";
import type { SpecForId } from "../types/00_CacheSpec.js";
import type {
  ResourceTypeName,
  ResourceTypes,
  SpecOf,
} from "../types/00_ResourceTypes.js";
import type {
  AnyParams,
  AnyValidators,
  Logger,
  NormalizedParams,
  NormalizedVary,
  ProducerResultResource,
  ReadonlyConsumerRequest,
  Vary,
} from "../types/index.js";
import {
  classifyCacheEntries,
  mergeCacheLookups,
  type CacheLookupResult,
} from "../utils/cacheHelpers.js";
import { PendingPromisesTracker } from "../scheduling/pendingPromisesTracker.js";
import { normalizeParams, normalizeVary } from "../utils/normalization.js";
import { asError } from "../utils/utils.js";
import { PendingResources } from "./pendingResources.js";

/**
 * Stands in for a {@link Cache} inside one producer client. Reads merge the
 * Store's candidates with the resources that this instance is still writing,
 * and writes are tracked until they settle. The client then needs no plain
 * `Cache`.
 *
 * ## Why it exists
 *
 * A producer client starts `store()` after the producer resolves, and does not
 * await it, so the caller gets its value without a Store round trip. Without
 * this overlay, a call that arrives after the producer resolves but before the
 * write lands reads the Store, misses, and runs the producer again. See
 * {@link PendingResources} for the overlay's rules.
 *
 * ## Read order
 *
 * Each read takes its pending snapshot synchronously, BEFORE it starts the
 * Store read. A write can land, and leave the overlay, while the Store read is
 * running. If the snapshot came after the read, a call could then miss in both
 * places and run the producer again. The snapshot is classified at snapshot
 * time, like the Store's candidates are classified at read time.
 *
 * ## Every read also reaches the Store
 *
 * The overlay adds candidates; it never answers a request alone. `get` and
 * `getUnbatched` read the Store for every request, also when a pending entry
 * already matches, because the Store can hold a better candidate:
 *
 * - a newer persisted entry, from another client or process, which wins
 *   under the canonical selection rules;
 * - a fresh `usable` entry where the pending one is only usable while
 *   revalidating or on error;
 * - more `validatable` entries.
 *
 * Each read also emits its `read` diagnostics message. Skipping the read when
 * the pending lookup has a fresh `usable` entry would be correct for the
 * caller's directives, but a newer persisted entry would then lose. That saves
 * a round trip only while a write is in flight, so this class does not do it.
 *
 * ## Scope
 *
 * One instance per producer client: two clients over the same cache do not
 * share pending writes. It does not own the underlying cache, which other
 * clients may share, so it has {@link drain} instead of a `close`.
 *
 * TODO: Move this overlay into `Cache`, so that every client of one cache,
 * and direct `Cache.get` callers, share one set of pending writes. A pending
 * write is a fact about the cache, not about one client: today a client can
 * miss a write that a sibling client has in flight, and run its producer
 * again. `Cache.store` would track the write, `Cache.get` and
 * `Cache.getUnbatched` would merge the pending entries, and `Cache.close`
 * already drains writes. This class would then reduce to a pass-through, or
 * go away. The `PendingResources` docs, which say two wrappers do not share
 * the overlay, would change too.
 *
 * @internal
 */
export class CacheWithPendingResources<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> {
  readonly #cache: PublicInterface<Cache<RT, Validators, Params>>;
  readonly #logger: Logger;
  readonly #pending: PendingResources<SpecOf<RT>, Validators, Params>;
  /** Writes that {@link drain} waits for. Each one leaves when it settles. */
  readonly #writes = new PendingPromisesTracker();
  /**
   * The write behind each pending entry that a read returned. Filled at
   * snapshot time, because the overlay drops an entry once its write settles,
   * and a caller may ask after that. Weak, so an entry that nobody holds any
   * longer drops out on its own.
   */
  readonly #writeByEntry = new WeakMap<object, Promise<void>>();

  constructor(
    cache: PublicInterface<Cache<RT, Validators, Params>>,
    logger: Logger,
  ) {
    this.#cache = cache;
    this.#logger = logger;
    this.#pending = new PendingResources((vary) => this.normalizeVary(vary));
  }

  get name(): string {
    return this.#cache.name;
  }

  get closed(): boolean {
    return this.#cache.closed;
  }

  classify(id: string): ResourceTypeName<RT> {
    return this.#cache.classify(id);
  }

  normalizeParams(
    params: ReadonlyDeep<Partial<Params>>,
  ): NormalizedParams<Params> {
    return normalizeParams(
      this.#cache.normalizeParamName,
      this.#cache.normalizeParamValue,
      params,
    );
  }

  normalizeVary(vary: Vary<Params>): NormalizedVary<Params> {
    return normalizeVary(
      this.#cache.normalizeParamName,
      this.#cache.normalizeParamValue,
      vary,
    );
  }

  /**
   * Like {@link Cache.get}, with this instance's pending resources merged in.
   * It reads the Store even when a pending entry matches (see "Every read also
   * reaches the Store"). Rejects without reading the Store if the request's
   * parameters cannot be normalized for the pending match.
   */
  async get(
    request: ReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>,
    options?: ReadOptions,
  ): Promise<LookupFor<RT, Validators, Params>> {
    options?.signal?.throwIfAborted();
    // Synchronous, so it runs before the Store read starts (see "Read order").
    const pending = this.#pendingLookup(request);
    const stored = await this.#cache.get(request, options);
    // Stored candidates precede pending candidates. The canonical selector
    // chooses the later pending candidate when birth dates are equal.
    return mergeCacheLookups([stored, pending]);
  }

  /**
   * Like {@link Cache.getUnbatched}, with this instance's pending resources
   * merged in. Every request whose snapshot succeeds is read from the Store,
   * also when a pending entry matches (see "Every read also reaches the
   * Store"). A request whose parameters cannot be normalized for the pending
   * match gets that error in its slot and is left out of the Store call.
   */
  async getUnbatched(
    requests: readonly ReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>[],
    options?: ReadOptions,
  ): Promise<(LookupFor<RT, Validators, Params> | Error)[]> {
    options?.signal?.throwIfAborted();
    // All snapshots precede the one Store read (see "Read order").
    const pending = requests.map((request) => {
      try {
        return this.#pendingLookup(request);
      } catch (error) {
        return asError(error);
      }
    });
    const readIndexes = pending.flatMap((lookup, index) =>
      lookup instanceof Error ? [] : [index],
    );
    const stored: readonly (LookupFor<RT, Validators, Params> | Error)[] =
      readIndexes.length === 0
        ? []
        : await this.#cache.getUnbatched(
            readIndexes.map((index) => requests[index]!),
            options,
          );
    const storedByIndex = new Map(
      readIndexes.map((requestIndex, readIndex) => [
        requestIndex,
        stored[readIndex]!,
      ]),
    );

    return pending.map((lookup, index) => {
      if (lookup instanceof Error) return lookup;
      const storedLookup = storedByIndex.get(index)!;
      return storedLookup instanceof Error
        ? storedLookup
        : mergeCacheLookups([storedLookup, lookup]);
    });
  }

  /**
   * Starts writing `resources` and holds them in the overlay until the write
   * settles. A resource without a `date` gets one write time, which both the
   * Store and the overlay use, so the two agree on its age. A caller that
   * builds its own entry from a resource should set `date` itself. Returns
   * the write, which never rejects unobserved: a failure is logged here.
   */
  store(
    resources: readonly ProducerResultResource<
      SpecOf<RT>,
      Validators,
      Params
    >[],
  ): Promise<void> {
    const now = new Date();
    const dated = resources.map((resource) => ({
      ...resource,
      date: resource.date ?? now,
    }));
    const stored =
      dated.length === 0
        ? Promise.resolve()
        : Promise.try(() => this.#cache.store(dated)).then(() => {});

    void this.#writes
      .track(stored)
      .catch((error: unknown) =>
        this.#logger(
          "wrap-producer",
          "trace",
          "error storing producer's response",
          error,
        ),
      );
    this.#pending.track(dated, stored, now);
    return stored;
  }

  /**
   * The unfinished write behind an entry that this instance's `get` or
   * `getUnbatched` returned from the overlay. `undefined` for an entry that
   * came from the Store, which is already persisted.
   */
  writeFor(entry: object): Promise<void> | undefined {
    return this.#writeByEntry.get(entry);
  }

  /**
   * Waits for every write started so far. Leaves the underlying cache open,
   * because other clients may share it.
   */
  async drain(): Promise<void> {
    await this.#writes.drain();
  }

  /**
   * The pending candidates for one request, classified now. Throws if the
   * request's parameters cannot be normalized. Records each candidate's write
   * for {@link writeFor}.
   */
  #pendingLookup(
    request: ReadonlyConsumerRequest<Params, SpecOf<RT>["id"]>,
  ): LookupFor<RT, Validators, Params> {
    const pending =
      !this.#cache.closed && this.#pending.has(request.id)
        ? this.#pending.matching(
            request.id,
            this.normalizeParams(request.params),
          )
        : [];
    pending.forEach(({ entry, stored }) => {
      this.#writeByEntry.set(entry, stored);
    });
    return classifyCacheEntries(
      pending.map(({ entry }) => entry),
      request.directives,
      new Date(),
    ).result;
  }
}

/** A lookup result over the whole registry, as the producer client reads it. */
export type LookupFor<
  RT extends ResourceTypes,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = CacheLookupResult<
  SpecForId<SpecOf<RT>, SpecOf<RT>["id"]>,
  Validators,
  Params
>;
