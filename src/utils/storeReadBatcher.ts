import { AsyncLocalStorage } from "node:async_hooks";
import DataLoader from "dataloader";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import type { AnyParams } from "../types/01_Params.js";
import type { AnyValidators } from "../types/02_Validators.js";
import type { EntryForId } from "../types/06_Normalization.js";
import type { StoreGetManyRequest } from "../types/06_Store.js";
import { raceWithSignal } from "./utils.js";

/** DataLoader options exposed by Cache; result caching is always disabled. */
export type ReadBatchOptions = Pick<
  DataLoader.Options<unknown, unknown>,
  "maxBatchSize" | "batchScheduleFn"
>;

/** Adapts per-request cancellation and cache shutdown to DataLoader. */
export class StoreReadBatcher<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> {
  readonly #loader: DataLoader<
    {
      request: StoreGetManyRequest<Spec, Params>;
      signal: AbortSignal | undefined;
      enqueuedAt: number;
    },
    EntryForId<Spec, Validators, Params, Spec["id"]>[]
  >;
  readonly #scheduled = new Set<() => void>();

  constructor(
    dispatch: (
      requests: readonly StoreGetManyRequest<Spec, Params>[],
      queueWaitTotalMs: number,
    ) => Promise<
      (EntryForId<Spec, Validators, Params, Spec["id"]>[] | Error)[]
    >,
    options: ReadBatchOptions,
  ) {
    this.#loader = new DataLoader(
      async (reads) => {
        const live = reads.filter(({ signal }) => !signal?.aborted);
        if (live.length === 0) return reads.map(() => []);
        const startedAt = performance.now();
        const results = await dispatch(
          live.map(({ request }) => request),
          live.reduce((sum, read) => sum + startedAt - read.enqueuedAt, 0),
        );
        // Results cover only live reads; DataLoader needs one slot for every
        // original load, including reads aborted before dispatch.
        const entriesByRead = new Map(
          live.map((read, index) => [read, results[index]!]),
        );
        return reads.map((read) => entriesByRead.get(read) ?? []);
      },
      {
        cache: false,
        maxBatchSize: options.maxBatchSize ?? 20,
        batchScheduleFn: (callback) => {
          // Bind the first reader's context even when close() forces dispatch
          // from a different context. The guard makes a later scheduled callback
          // harmless after flushNow(), and removes completed batches from the set.
          const dispatch = AsyncLocalStorage.bind(() => {
            if (this.#scheduled.delete(dispatch)) callback();
          });
          this.#scheduled.add(dispatch);
          if (options.batchScheduleFn) options.batchScheduleFn(dispatch);
          // DataLoader's Node scheduler: dispatch after Promise continuations.
          else void Promise.resolve().then(() => process.nextTick(dispatch));
        },
      },
    );
  }

  async read(
    request: StoreGetManyRequest<Spec, Params>,
    signal: AbortSignal | undefined,
  ) {
    signal?.throwIfAborted();
    return raceWithSignal(
      this.#loader.load({ request, signal, enqueuedAt: performance.now() }),
      signal,
    );
  }

  /** Start accepted reads before closing the store, without awaiting them. */
  flushNow(): void {
    for (const dispatch of this.#scheduled) dispatch();
  }
}
