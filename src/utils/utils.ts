import { TimeSliceBudget, timeSlicedForEach } from "@zingage/scheduling";
import { default as debug } from "debug";
import { maxBy } from "es-toolkit";

import pLimit from "p-limit";
import type { CacheSpec, SpecForId } from "../types/00_CacheSpec.js";
import type { Entry, NormalizedParams } from "../types/06_Normalization.js";
import type {
  Store,
  SingleStoreReader,
  StoreGetManyRequest,
  StoreGetManyResult,
} from "../types/06_Store.js";
import type { AnyParams, AnyValidators } from "../types/index.js";
import { components, type Logger } from "../types/index.js";
export type { JsonOf } from "type-party";
export { jsonParse, jsonStringify } from "type-party/runtime/json.js";

export const defaultLoggersByComponent = Object.fromEntries(
  components.map(
    (name) =>
      [
        name,
        (() => {
          const debugLogger = debug(`@zingage/cache:${name}`);
          return (_, level, message, data) => {
            debugLogger(`(${level}) ${message} %O`, data);
          };
        })(),
      ] as const,
  ),
) satisfies Record<string, Logger> as {
  [K in (typeof components)[number]]: Logger;
};

/**
 * Preserves a type's tupleness during a map operation.
 */
export function mapTuple<T extends readonly unknown[], U>(
  arr: T,
  fn: (it: T[number]) => U,
) {
  return arr.map(fn) as { [K in keyof T]: U };
}

export function assertUnreachable(_it: never): never {
  throw new Error("Expected this code to never be reached.");
}

/**
 * Races a promise against an AbortSignal. If the signal is already aborted or
 * becomes aborted before the promise settles, the returned promise rejects with
 * the signal's reason. The original promise is NOT cancelled (it continues
 * running); this only controls the caller's observation of the result.
 */
export function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;

  if (signal.aborted) {
    // Prevent unhandled rejection on the underlying promise, as callers are
    // supposed to only have to handle rejection of the returned promise from
    // this fn.
    promise.catch(() => {});
    throw signal.reason;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Faster, more-type-safe version of lodash's zip, just for pairs.
 * If the arrays are not the same length, the longer one will be truncated!
 * (That's what allows us to not have `undefined` in the result type.)
 */
export const zip2 = <T, U>(a: readonly T[], b: readonly U[]): [T, U][] => {
  const res = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    res.push([a[i], b[i]] as [T, U]);
  }

  return res;
};

/**
 * Groups the items by `groupBy` and keeps, per group, the (first) item that
 * maximizes `maxBy`. Group order follows first appearance in `items` (i.e.,
 * `Map.groupBy` insertion order).
 *
 * All stores use this to dedupe a `store()` call's entries per (id, vary)
 * slot, keeping the entry with the newest birth date, so that the in-call
 * "winner" is the same across every store implementation.
 */
export function keepMaxPerGroup<T>(opts: {
  items: readonly T[];
  groupBy: (item: T) => string;
  maxBy: (item: T) => number;
}): T[] {
  return Map.groupBy(opts.items, opts.groupBy)
    .values()
    .map((group) =>
      // Non-null assertions are safe because the group cannot be empty,
      // or it wouldn't have an entry in the Map.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      group.length > 1 ? maxBy(group, opts.maxBy)! : group[0]!,
    )
    .toArray();
}

/** Cooperative equivalent of keepMaxPerGroup for bulk store paths. */
export async function keepMaxPerGroupCooperatively<T>(opts: {
  items: readonly T[];
  groupBy: (item: T) => string;
  maxBy: (item: T) => number;
}): Promise<T[]> {
  const winners = new Map<string, { item: T; max: number }>();
  await timeSlicedForEach(opts.items, (item) => {
    const key = opts.groupBy(item);
    const max = opts.maxBy(item);
    const previous = winners.get(key);
    if (!previous || max > previous.max) winners.set(key, { item, max });
  });
  const result: T[] = [];
  await timeSlicedForEach(winners.values(), ({ item }) => {
    result.push(item);
  });
  return result;
}

/** Package-detected invalid contracts must not become operational slot errors. */
export class CacheContractError extends Error {
  override readonly name: string = "CacheContractError";
}

export function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Cache operation failed", { cause: error });
}

/** Check capability presence before any dispatch. */
export function assertStoreReader(store: {
  get?: unknown;
  getMany?: unknown;
}): void {
  const single = typeof store.get === "function";
  const bulk = typeof store.getMany === "function";
  if (
    single === bulk ||
    (!single && store.get !== undefined) ||
    (!bulk && store.getMany !== undefined)
  ) {
    throw new CacheContractError(
      "A Store must declare exactly one of get or getMany",
    );
  }
}

/** One actual primitive call, before operational failures become positional slots. */
export type StoreReadObservation = {
  operation: "get" | "getMany";
  requestCount: number;
  failedRequestCount: number;
  entryCount: number;
  durationMs: number;
  outcome: "success" | "failure" | "cancelled";
};

/** Read a known set without accumulating independent calls. */
export async function getMany<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  const Reqs extends readonly StoreGetManyRequest<Spec, Params>[],
>(
  store: Store<Spec, Validators, Params>,
  requests: Reqs,
  options?: { signal?: AbortSignal },
): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
  return await readStoreObserved(store, requests, options);
}

export async function readStoreObserved<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  const Reqs extends readonly StoreGetManyRequest<Spec, Params>[],
>(
  store: Store<Spec, Validators, Params>,
  requests: Reqs,
  options?: { signal?: AbortSignal },
  observe?: (event: StoreReadObservation) => void,
): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
  assertStoreReader(store);
  options?.signal?.throwIfAborted();
  if (requests.length === 0)
    return [] as StoreGetManyResult<Spec, Reqs, Validators, Params>;
  if (store.getMany === undefined)
    return readSingleStore(store, requests, 10, options, observe);
  const startedAt = observe === undefined ? 0 : performance.now();
  let results: StoreGetManyResult<Spec, Reqs, Validators, Params>;
  try {
    results = await store.getMany(requests, options);
    if (
      !Array.isArray(results) ||
      results.length !== requests.length ||
      Array.from(results).some(
        (slot) => !(slot instanceof Error) && !Array.isArray(slot),
      )
    ) {
      throw new CacheContractError(
        "Store.getMany must return one entry array or Error per request",
      );
    }
    observe?.({
      operation: "getMany",
      requestCount: requests.length,
      failedRequestCount: results.filter((slot) => slot instanceof Error)
        .length,
      entryCount: results.reduce(
        (total, slot) => total + (slot instanceof Error ? 0 : slot.length),
        0,
      ),
      durationMs: performance.now() - startedAt,
      outcome: results.some((slot) => slot instanceof Error)
        ? "failure"
        : "success",
    });
  } catch (failure) {
    observe?.({
      operation: "getMany",
      requestCount: requests.length,
      failedRequestCount: options?.signal?.aborted ? 0 : requests.length,
      entryCount: 0,
      durationMs: performance.now() - startedAt,
      outcome: options?.signal?.aborted ? "cancelled" : "failure",
    });
    options?.signal?.throwIfAborted();
    if (failure instanceof CacheContractError) throw failure;
    const error = asError(failure);
    return requests.map(() => error) as StoreGetManyResult<
      Spec,
      Reqs,
      Validators,
      Params
    >;
  }
  options?.signal?.throwIfAborted();
  return results;
}

/** Read one request through either primitive. Error slots reject this call. */
export async function getOne<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends Spec["id"],
>(
  store: Store<Spec, Validators, Params>,
  request: StoreGetManyRequest<Spec, NoInfer<Params>> & { readonly id: Id },
  options?: { signal?: AbortSignal },
) {
  const results = await getMany(store, [request] as const, options);
  const result = results[0];
  if (result instanceof Error) throw result;
  return result;
}

/** Reject the first Error in request order after all results have settled. */
export function throwIfAnyError<const Results extends readonly unknown[]>(
  results: Results,
): { [K in keyof Results]: Exclude<Results[K], Error> } {
  const failure = results.find((result) => result instanceof Error);
  if (failure instanceof Error) throw failure;
  return results as { [K in keyof Results]: Exclude<Results[K], Error> };
}

/**
 * A naive implementation of the `getMany` method that uses the store's `get`
 * method to fulfill all requests with limited parallelism.
 *
 * This implementation is provided as a default fallback for stores that don't
 * implement their own optimized `getMany` method. It calls `store.get` for each
 * request with up to 10 concurrent operations to improve performance.
 * Each failed read becomes an Error in its request slot while other reads
 * continue. Existing Error objects keep their identity. Non-Error rejections
 * are wrapped with their original cause. Request order and duplicate slots
 * are preserved. Caller cancellation still rejects the operation rather than
 * becoming a partial read failure.
 *
 * @param store The store instance to use for retrieving entries
 * @param requests Array of requests, each containing an id and params
 * @param maxConcurrency Maximum number of concurrent requests (default: 10)
 * @returns A promise that resolves to a tuple-typed array, where each output
 *  slot holds matching entries or an Error for the corresponding request, with
 *  content narrowed to the spec variants compatible with that request's id.
 */
export async function naiveGetMany<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  const Reqs extends readonly {
    readonly id: Spec["id"];
    readonly params: Readonly<NormalizedParams<Params>>;
  }[],
>(
  store: SingleStoreReader<Spec, Validators, Params>,
  requests: Reqs,
  maxConcurrency = 10,
  options?: { signal?: AbortSignal },
): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
  return await readSingleStore(store, requests, maxConcurrency, options);
}

async function readSingleStore<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  const Reqs extends readonly {
    readonly id: Spec["id"];
    readonly params: Readonly<NormalizedParams<Params>>;
  }[],
>(
  store: SingleStoreReader<Spec, Validators, Params>,
  requests: Reqs,
  maxConcurrency = 10,
  options?: { signal?: AbortSignal },
  observe?: (event: StoreReadObservation) => void,
): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
  options?.signal?.throwIfAborted();

  const limit = pLimit(maxConcurrency);
  const budget = new TimeSliceBudget();

  // Process all requests with controlled concurrency.
  const promises = requests.map(async (request) =>
    limit(async () => {
      options?.signal?.throwIfAborted();
      const pendingYield = budget.yieldIfNeeded();
      if (pendingYield !== undefined) await pendingYield;
      options?.signal?.throwIfAborted();
      const startedAt = observe === undefined ? 0 : performance.now();
      try {
        const invocation = budget.measure(() => ({
          promise: store.get(request, options),
        }));
        const entries = await invocation.promise;
        if (!Array.isArray(entries))
          throw new CacheContractError("Store.get must return an entry array");
        observe?.({
          operation: "get",
          requestCount: 1,
          failedRequestCount: 0,
          entryCount: entries.length,
          durationMs: performance.now() - startedAt,
          outcome: "success",
        });
        return entries;
      } catch (error) {
        observe?.({
          operation: "get",
          requestCount: 1,
          failedRequestCount: options?.signal?.aborted ? 0 : 1,
          entryCount: 0,
          durationMs: performance.now() - startedAt,
          outcome: options?.signal?.aborted ? "cancelled" : "failure",
        });
        options?.signal?.throwIfAborted();
        if (error instanceof CacheContractError) throw error;
        return asError(error);
      }
    }),
  );

  // Wait for every dispatched read before releasing lifecycle ownership.
  const settled = await Promise.allSettled(promises);
  options?.signal?.throwIfAborted();
  const res = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  return res satisfies (
    | Entry<SpecForId<Spec, Spec["id"]>, Validators, Params>[]
    | Error
  )[] as {
    -readonly [K in keyof Reqs]:
      | Entry<SpecForId<Spec, Reqs[K]["id"]>, Validators, Params>[]
      | Error;
  };
}

// Highly incomplete code for interoperating with raw HTTP responses,
// by doing all the necessary header parsing and age inference.
// import { FullResponse } from 'request-promise-native'
// import { ProducerResult } from './types'
//
// function httpProducerResult<T extends FullResponse>(
//   resp: T,
//   fetchTimeMs: number,
// ): ProducerResult<T, { etag: string }, string> {
//   const { vary } = resp.headers.vary;
//   const varyHeaders = Array.isArray(vary) ? vary : vary ? [vary] : [];
//   const varyHeadersNormalized = varyHeaders.map((it) => it.trim());

//   return {
//     id: resp.request.uri.href,
//     // In proper HTTP, method (not just uri) is part of the cache key;
//     // we simulate that by treating method as a param name that's always varied on
//     vary: {
//       method: resp.request.method,
//       ...Object.fromEntries(
//         varyHeadersNormalized.map((header) => [
//           header,
//           resp.request.hasHeader(header)
//             ? resp.request.getHeader(header)
//             : null,
//         ]),
//       ),
//     },
//     content: resp,
//     // TODO, parse cache-control or expires w/ Date; use heuristics if missing.
//     maxAge: 100000000000,
//     validate: resp.headers.etag ? { etag: String(resp.headers.etag) } : {},
//     initialAge: Math.round((resp.headers.age || 0) + fetchTimeMs * 1000),
//   };
// }
