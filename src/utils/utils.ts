import { default as debug } from "debug";

import pLimit from "p-limit";
import type { Entry, NormalizedParams } from "../types/06_Normalization.js";
import type { Store } from "../types/06_Store.js";
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
 * A naive implementation of the `getMany` method that uses the store's `get`
 * method to fulfill all requests with limited parallelism.
 *
 * This implementation is provided as a default fallback for stores that don't
 * implement their own optimized `getMany` method. It calls `store.get` for each
 * request with up to 10 concurrent operations to improve performance.
 *
 * @param store The store instance to use for retrieving entries
 * @param requests Array of requests, each containing an id and params
 * @param maxConcurrency Maximum number of concurrent requests (default: 10)
 * @returns A promise that resolves to a Map of ids to Entry arrays
 */
export async function naiveGetMany<
  T,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string,
>(
  store: Store<T, Validators, Params, Id>,
  requests: readonly {
    readonly id: Id;
    readonly params: Readonly<NormalizedParams<Params>>;
  }[],
  maxConcurrency = 10,
): Promise<Array<Entry<T, Validators, Params, Id>[]>> {
  const limit = pLimit(maxConcurrency);

  // Process all requests with controlled concurrency
  const promises = requests.map(async (request) => {
    return limit(async () => store.get(request.id, request.params));
  });

  return Promise.all(promises);
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
