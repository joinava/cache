import { mock } from "node:test";
import { bulkMemoryStore } from "./fixtures.js";
import { uniqueCacheName, ACCEPT_ANY_REGISTRY } from "./v2AcceptanceHelpers.js";
import Cache from "../src/Cache.js";
import type { CacheSpec } from "../src/types/00_CacheSpec.js";

export type Spec = CacheSpec<string, string>;

/**
 * A MemoryStore whose reads are spied on. `beforeGetMany` runs inside every
 * `getMany` call before the store reads, so a test can hold a batch's query
 * open.
 */
export function spiedStore(options?: { beforeGetMany?: () => Promise<void> }) {
  const store = bulkMemoryStore<Spec>();
  const getMany = store.getMany.bind(store);
  const getManySpy = mock.method(
    store,
    "getMany",
    async (...args: Parameters<typeof getMany>) => {
      await options?.beforeGetMany?.();
      return getMany(...args);
    },
  );
  return {
    store,
    /** The number of requests in each `getMany` call, in call order. */
    getManyRequestCounts: () =>
      getManySpy.mock.calls.map(({ arguments: [requests] }) => requests.length),
  };
}

export const batchedCacheOver = (
  store: ReturnType<typeof bulkMemoryStore<Spec>>,
) =>
  new Cache({
    store,
    name: uniqueCacheName("batch-reads"),
    resourceTypes: ACCEPT_ANY_REGISTRY,
  });

export const lookup = (id: string, params: Record<string, string> = {}) => ({
  id,
  params,
  directives: {},
});

// A read that never settles would otherwise hang the run (node:test waits for
// a pending test forever), so each suite fails after a bound instead.
export const suiteOptions = { timeout: 20_000 };
