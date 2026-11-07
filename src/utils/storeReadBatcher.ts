import { AsyncLocalStorage } from "node:async_hooks";
import DataLoader from "dataloader";
import { cacheReadBatchChannel } from "../diagnostics.js";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import type { AnyParams } from "../types/01_Params.js";
import type { AnyValidators } from "../types/02_Validators.js";
import type { EntryForId } from "../types/06_Normalization.js";
import type { Store, StoreGetManyRequest } from "../types/06_Store.js";
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
    store: Store<Spec, Validators, Params>,
    options: ReadBatchOptions,
    cache: string,
  ) {
    this.#loader = new DataLoader(
      async (reads) => {
        const live = reads.filter(({ signal }) => !signal?.aborted);
        if (live.length === 0) return reads.map(() => []);
        // Let a rejection propagate: DataLoader rejects every load in this
        // batch, while per-entry errors reject only their own loads.
        const results = await observeStoreRead(
          {
            cache,
            operation: "getMany",
            requestCount: live.length,
            queueWaitTotalMs: (startedAt) =>
              live.reduce(
                (total, read) => total + startedAt - read.enqueuedAt,
                0,
              ),
          },
          async () => {
            const results = await store.getMany(
              live.map(({ request }) => request),
            );
            if (results.length !== live.length) {
              throw new Error(
                `store.getMany() returned ${results.length} results for ${live.length} requests; it must return one result per request`,
              );
            }
            return results;
          },
          summarizeStoreReadResults,
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
        maxBatchSize: options.maxBatchSize ?? 50,
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

/** Observe an actual Store invocation without including caller classification. */
export async function observeStoreRead<Result>(
  context: {
    cache: string;
    operation: "get" | "getMany";
    requestCount: number;
    signal?: AbortSignal | undefined;
    queueWaitTotalMs?: (startedAt: number) => number;
  },
  read: () => Promise<Result>,
  summarize: (result: Result) => {
    entryCount: number;
    failedRequestCount: number;
  },
): Promise<Result> {
  if (!cacheReadBatchChannel.hasSubscribers) return await read();
  const startedAt = performance.now();
  const queueWaitTotalMs = context.queueWaitTotalMs?.(startedAt) ?? 0;
  const publish = (
    outcome: "success" | "failure" | "cancelled",
    entryCount: number,
    failedRequestCount: number,
  ) => {
    cacheReadBatchChannel.publish({
      cache: context.cache,
      operation: context.operation,
      outcome,
      requestCount: context.requestCount,
      entryCount,
      failedRequestCount,
      durationMs: performance.now() - startedAt,
      queueWaitTotalMs,
    });
  };
  try {
    const result = await read();
    const summary = summarize(result);
    publish(
      summary.failedRequestCount === 0 ? "success" : "failure",
      summary.entryCount,
      summary.failedRequestCount,
    );
    return result;
  } catch (error) {
    const cancelled = context.signal?.aborted === true;
    publish(
      cancelled ? "cancelled" : "failure",
      0,
      cancelled ? 0 : context.requestCount,
    );
    throw error;
  }
}

/** Count returned entries without traversing or serializing their values. */
export function summarizeStoreReadResults(
  results: readonly (readonly unknown[] | Error)[],
): {
  entryCount: number;
  failedRequestCount: number;
} {
  return results.reduce(
    (counts, entries) => {
      if (entries instanceof Error) counts.failedRequestCount += 1;
      else counts.entryCount += entries.length;
      return counts;
    },
    { entryCount: 0, failedRequestCount: 0 },
  );
}
