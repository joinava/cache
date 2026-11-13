import type { CacheSpec } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  Entry,
  NormalizedParams,
  NormalizedVary,
  ProducerResultResource,
  Vary,
} from "../types/index.js";
import { normalizeProducerResultResource } from "../utils/normalization.js";
import { calculateStoreFor } from "../utils/normalizedProducerResultResourceHelpers.js";
import { variantMatchesRequest } from "../utils/varyHelpers.js";

type PendingEntry<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  readonly id: Spec["id"];
  readonly writtenAt: Date;
  readonly entry: Entry<Spec, Validators, Params>;
  readonly stored: Promise<void>;
};

/**
 * The producer wrappers' overlay of entries whose `cache.store()` is still in
 * flight.
 *
 * ## Why it exists
 *
 * A wrapper fires `cache.store()` after the producer resolves WITHOUT awaiting
 * it, so the caller gets its value as soon as the producer has it rather than
 * after a round trip to the backing store. Request collapsing covers callers
 * that arrive while the producer is running, but nothing covered the window
 * between the producer resolving and the store's write landing: a caller that
 * arrived in that window read the store, found nothing, and ran the producer
 * again. Against an in-memory store the window is a few microtasks; against a
 * worker-backed or networked store it is the store's write latency, which is
 * long enough that a plain sequential repeat (`await f(x); await f(x)`) paid
 * for the producer twice.
 *
 * This overlay closes that window: every entry handed to `cache.store()` is
 * held here until that store call settles. `CacheWithPendingResources` takes a
 * snapshot of the overlay before each Store read, keeps it across the read,
 * and merges it with the stored candidates. Both sources use the
 * same freshness classification and selection rules.
 *
 * The overlay models an idealized store that retains every eligible pending
 * entry, including duplicates within one write. The backing store may retain
 * fewer entries because of eviction, capacity, or per-slot deduplication.
 * Selection therefore need not equal a lookup after the write completes.
 *
 * ## What it does NOT do
 *
 * - It never serves an entry whose directives prohibit retention (`storeFor: 0`, or
 *   an entry already past every usefulness bound), so a producer that asked
 *   for its response not to be stored is not silently memoized for one call.
 * - It never outlives the write. An entry leaves the overlay when its store
 *   call settles, on SUCCESS (the store may now answer for it) and on FAILURE
 *   alike. A failed write is forgotten, not pinned: the next caller reads the
 *   store, misses, and runs the producer again, exactly as if the overlay
 *   did not exist. An already-running lookup can retain its own snapshot
 *   after settlement; its persistence promise still reports the write result.
 * - It is per wrapper instance and in-process. Two wrappers over the same
 *   cache do not share it, and neither does another process.
 *
 * Variants are honored: an entry only matches a request whose (normalized)
 * params agree with the entry's `vary`, by the same rule the stores apply.
 *
 * @internal
 */
export class PendingResources<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> {
  /**
   * Pending entries by resource id. A `Set` (not a single slot) because one
   * id can have several variants in flight, and one variant can be written
   * twice while earlier work remains pending, after the joining age limit expires
   * or requests differ. Cache lookup rules select among matching entries.
   */
  readonly #byId = new Map<
    Spec["id"],
    Set<PendingEntry<Spec, Validators, Params>>
  >();

  readonly #normalizeVary: (vary: Vary<Params>) => NormalizedVary<Params>;

  constructor(normalizeVary: (vary: Vary<Params>) => NormalizedVary<Params>) {
    this.#normalizeVary = normalizeVary;
  }

  /**
   * Holds `resources` in the overlay until `stored` settles, then drops them
   * (whether it resolved or rejected -- see the class docs). `stored`'s
   * rejection is observed here but not swallowed for other holders of the
   * promise: the wrapper still attaches its own logging handlers.
   *
   * Retain raw resources and their write-time date. Normalize a resource only
   * on its first pending lookup, and reuse that normalized entry afterward.
   * A resource without a `date` gets `now`, not the lookup time, so lazy
   * normalization never resets its age.
   * Cleanup uses the raw ID, so unread resources never need normalization.
   */
  track(
    resources: readonly ProducerResultResource<Spec, Validators, Params>[],
    stored: Promise<void>,
    now: Date,
  ): void {
    const normalizeVary = this.#normalizeVary;
    const tracked = resources.map((resource) => {
      let normalizedEntry: Entry<Spec, Validators, Params>;
      return {
        id: resource.id,
        writtenAt: now,
        stored,
        get entry(): Entry<Spec, Validators, Params> {
          normalizedEntry ??= normalizeProducerResultResource(
            normalizeVary,
            resource,
            now,
          );
          return normalizedEntry;
        },
      };
    });
    if (tracked.length === 0) {
      return;
    }

    tracked.forEach((pendingEntry) => {
      const { id } = pendingEntry;
      const pending = this.#byId.get(id);
      if (pending === undefined) {
        this.#byId.set(id, new Set([pendingEntry]));
      } else {
        pending.add(pendingEntry);
      }
    });

    const untrack = () => {
      tracked.forEach((pendingEntry) => {
        const { id } = pendingEntry;
        const pending = this.#byId.get(id);
        if (pending === undefined) {
          return;
        }
        pending.delete(pendingEntry);
        if (pending.size === 0) {
          this.#byId.delete(id);
        }
      });
    };
    // `.then(f, f)` rather than `.finally(f)`: the latter would re-reject and
    // create an unhandled rejection of its own when the store fails.
    void stored.then(untrack, untrack);
  }

  has(id: Spec["id"]): boolean {
    return this.#byId.has(id);
  }

  /** Return variant-matching records; Cache owns freshness and entry selection. */
  matching(
    id: Spec["id"],
    normalizedParams: Readonly<NormalizedParams<Params>>,
  ): readonly PendingEntry<Spec, Validators, Params>[] {
    return [...(this.#byId.get(id) ?? [])].filter(
      ({ entry, writtenAt }) =>
        calculateStoreFor(entry, writtenAt) > 0 &&
        variantMatchesRequest(entry.vary, normalizedParams),
    );
  }
}
