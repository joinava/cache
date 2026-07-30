import { expect } from "chai";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { setTimeout as delay } from "timers/promises";

import {
  idStartsWith,
  MemoryStore,
  resourceType,
  type CacheFetchMessage,
  type CacheProduceMessage,
  type CacheReadMessage,
  type CacheStoreEntryMessage,
  type ResourceTypes,
  type SpecOf,
} from "../src/index.js";

/**
 * A MemoryStore whose Spec is pinned to the given registry's `SpecOf`. (A
 * bare `new MemoryStore()` held in a variable is typed over the wide default
 * `CacheSpec` and is NOT assignable to the `Store<SpecOf<RT>, ...>` that
 * `Cache`'s constructor requires for a narrow registry; passing the registry
 * value pins the store's Spec to exactly the required union.)
 */
export const memoryStoreFor = <RT extends ResourceTypes>(
  _registry: RT,
): MemoryStore<SpecOf<RT>> => new MemoryStore<SpecOf<RT>>();

/**
 * NOTE: there is deliberately no shared `makeHarness(registry, label)` here.
 * `CacheOptions.store` carries the store-covers-registry check as a conditional
 * type, and under an unresolved generic `RT` that conditional stays deferred --
 * so a generic factory cannot construct a `Cache` without a cast. Each suite's
 * own factory instantiates `Cache` at a concrete registry type, where the
 * conditional resolves and no cast is needed. That is what the per-suite
 * factories are buying.
 */

/**
 * The standard two-resource-type registry the acceptance suites classify
 * against: two disjoint prefixes, which is the minimum that makes
 * classification, per-type attribution, and partial coverage observable.
 */
export const TWO_TYPE_REGISTRY = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<string>()({ matches: idStartsWith("biz:") }),
} satisfies ResourceTypes;

/**
 * The sole-resource-type registry whose guard accepts every id -- the shape a
 * `singleTypeCacheOptions` cache with no `validateId` produces, and what most
 * of the monorepo's caches look like. Classification can never fail here.
 */
export const ACCEPT_ANY_REGISTRY = {
  visits: resourceType<string>()({
    matches: (id): id is string => typeof id === "string",
  }),
} satisfies ResourceTypes;

/**
 * Compile-time type equality. The two-function-wrapper form is what makes it
 * INVARIANT, so `Equal<string, any>` and `Equal<{a: string}, {a?: string}>`
 * are both `false` -- a mutually-assignable check would pass those and make
 * every fixture below a weaker gate than it reads as.
 */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/**
 * Asserts its type argument is `true` at COMPILE time; the runtime body is
 * empty. `expectType<Equal<A, B>>()` fails to typecheck when A and B differ,
 * which is the whole gate -- these fixtures pass trivially at runtime.
 */
export const expectType = <_T extends true>(): void => {};

/**
 * Shared helpers for the 2.0 acceptance suites (classification, channel
 * conformance, bypass skip-read, coverage). Written purely from the design
 * doc (docs/plans/2026-07-28-resource-type-registry-and-diagnostics.md, §6).
 *
 * The channel names below are intentionally spelled as string literals, NOT
 * imported from the package's exported constants: subscribing by the
 * documented literal names is itself part of the contract under test (a typo
 * in an implementation's channel name must fail these suites, not silently
 * follow it). The exported constants are separately asserted to equal these
 * literals in the channel-conformance suite.
 */
export const V2_CHANNEL_NAMES = {
  read: "@zingage/cache:read",
  fetch: "@zingage/cache:fetch",
  produce: "@zingage/cache:produce",
  storeEntry: "@zingage/cache:store-entry",
} as const;

export type CapturedMessage =
  | { channel: "read"; message: CacheReadMessage }
  | { channel: "fetch"; message: CacheFetchMessage }
  | { channel: "produce"; message: CacheProduceMessage }
  | { channel: "store-entry"; message: CacheStoreEntryMessage };

export type ChannelCapture = {
  read: CacheReadMessage[];
  fetch: CacheFetchMessage[];
  produce: CacheProduceMessage[];
  storeEntry: CacheStoreEntryMessage[];
  /** Every captured message, across channels, in arrival order. */
  all: CapturedMessage[];
  /** Unsubscribes all listeners. Always call (e.g. in `finally`). */
  stop: () => void;
};

/**
 * Subscribes to all four 2.0 diagnostics channels and collects the messages
 * attributed to `cacheName` (every documented message type carries a `cache`
 * field, so filtering on it isolates concurrently-running tests from each
 * other). Call `stop()` when done -- leaked subscribers poison other tests'
 * counts.
 */
export function captureChannels(cacheName: string): ChannelCapture {
  const read: CacheReadMessage[] = [];
  const fetch: CacheFetchMessage[] = [];
  const produce: CacheProduceMessage[] = [];
  const storeEntry: CacheStoreEntryMessage[] = [];
  const all: CapturedMessage[] = [];

  const isForThisCache = (msg: unknown): boolean =>
    typeof msg === "object" &&
    msg !== null &&
    (msg as { cache?: unknown }).cache === cacheName;

  // The subscribe() callbacks receive `unknown`; the cast below is the single
  // narrowing boundary for this untyped channel data. The suites then assert
  // the full payload shapes, so a message that doesn't actually match the
  // documented type fails loudly there.
  const collect =
    <M>(channel: CapturedMessage["channel"], bucket: M[]) =>
    (msg: unknown) => {
      if (!isForThisCache(msg)) return;
      const message = msg as M;
      bucket.push(message);
      all.push({ channel, message } as CapturedMessage);
    };

  const onRead = collect<CacheReadMessage>("read", read);
  const onFetch = collect<CacheFetchMessage>("fetch", fetch);
  const onProduce = collect<CacheProduceMessage>("produce", produce);
  const onStoreEntry = collect<CacheStoreEntryMessage>(
    "store-entry",
    storeEntry,
  );

  subscribe(V2_CHANNEL_NAMES.read, onRead);
  subscribe(V2_CHANNEL_NAMES.fetch, onFetch);
  subscribe(V2_CHANNEL_NAMES.produce, onProduce);
  subscribe(V2_CHANNEL_NAMES.storeEntry, onStoreEntry);

  return {
    read,
    fetch,
    produce,
    storeEntry,
    all,
    stop: () => {
      unsubscribe(V2_CHANNEL_NAMES.read, onRead);
      unsubscribe(V2_CHANNEL_NAMES.fetch, onFetch);
      unsubscribe(V2_CHANNEL_NAMES.produce, onProduce);
      unsubscribe(V2_CHANNEL_NAMES.storeEntry, onStoreEntry);
    },
  };
}

let cacheNameCounter = 0;

/**
 * A per-test-unique cache name. Uniqueness is what lets `captureChannels`
 * attribute messages to exactly one test even when other tests' background
 * work (SWR revalidations, fire-and-forget stores) settles late.
 */
export function uniqueCacheName(label: string): string {
  cacheNameCounter += 1;
  return `${label}-${cacheNameCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Awaits a promise (or a thunk producing one) that MUST reject, returning the
 * rejection reason. The thunk form also tolerates implementations that throw
 * synchronously instead of rejecting. Throws if no failure occurs.
 */
export async function expectRejection(
  input: Promise<unknown> | (() => unknown),
): Promise<unknown> {
  let value: unknown;
  try {
    value = await (typeof input === "function" ? input() : input);
  } catch (reason) {
    return reason;
  }
  throw new Error(
    `expected rejection, but got resolution with: ${JSON.stringify(value) ?? String(value)}`,
  );
}

/**
 * Calls a function that MUST throw synchronously, returning what it threw.
 */
export function expectSyncThrow(fn: () => unknown): unknown {
  let value: unknown;
  try {
    value = fn();
  } catch (thrown) {
    return thrown;
  }
  throw new Error(
    `expected a synchronous throw, but the call returned: ${JSON.stringify(value) ?? String(value)}`,
  );
}

/**
 * Polls until `pred()` is true, for awaiting background settlements (SWR
 * revalidations, fire-and-forget stores) without fixed-length sleeps.
 */
export async function waitUntil(
  pred: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${description}`);
    }
    await delay(5);
  }
}

export const byResourceId = (
  a: { resourceId: string },
  b: { resourceId: string },
): number => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);

/** Copies then sorts by `resourceId`, for order-insensitive message asserts. */
export const sortByResourceId = <T extends { resourceId: string }>(
  messages: readonly T[],
): T[] => [...messages].sort(byResourceId);

/**
 * Asserts a fetch message on the producer-path branch of the discriminated
 * union, where `directivesImpliedBypass` is REQUIRED. The deep-equal is over
 * the whole message, so extra/missing fields fail too.
 */
export function expectProducerPathFetch(
  msg: CacheFetchMessage | undefined,
  expected: {
    cache: string;
    resourceType: string;
    resourceId: string;
    collapsed: boolean;
    disposition: "served-from-producer" | "producer-error" | "aborted";
    directivesImpliedBypass: boolean;
  },
): void {
  if (msg === undefined) {
    throw new Error("expected a producer-path fetch message, got none");
  }
  expect(msg).to.deep.equal(expected);
}

/**
 * Asserts a fetch message on the cache-read-path branch of the union. There
 * `directivesImpliedBypass` is typed `?: false`, and cache-read dispositions
 * omit the key entirely rather than publishing it as `false`.
 */
export function expectCachePathFetch(
  msg: CacheFetchMessage | undefined,
  expected: {
    cache: string;
    resourceType: string;
    resourceId: string;
    collapsed: boolean;
    disposition:
      | "served-from-cache"
      | "served-stale-while-revalidating"
      | "served-stale-after-error";
  },
): void {
  if (msg === undefined) {
    throw new Error("expected a cache-path fetch message, got none");
  }
  expect(msg).to.not.have.property("directivesImpliedBypass");
  expect(msg).to.deep.equal(expected);
}

/**
 * Asserts a produce message. `durationMs` can't be deep-equaled, so it's
 * bound-checked (a finite number, >= `minDurationMs`); everything else is
 * deep-equaled. `requests` are compared order-insensitively (batch order
 * within one bulk invocation isn't documented).
 *
 * `collapsedCallerCount` is the initiator plus every rider, and counts
 * ATTACHMENT rather than settlement dependence: a lone caller reports 1, one
 * rider makes 2, and a background revalidation with no waiting foreground
 * caller reports 1.
 */
export function expectProduceMessage(
  msg: CacheProduceMessage | undefined,
  expected: {
    cache: string;
    trigger: "miss" | "revalidation" | "bypass";
    requests: readonly { resourceType: string; resourceId: string }[];
    collapsedCallerCount: number;
    outcome: "success" | "error";
    minDurationMs?: number;
  },
): void {
  if (msg === undefined) {
    throw new Error("expected a produce message, got none");
  }
  const { durationMs, requests, ...rest } = msg;
  expect(durationMs).to.be.a("number");
  expect(Number.isFinite(durationMs)).to.equal(true);
  expect(durationMs).to.be.at.least(expected.minDurationMs ?? 0);
  expect(sortByResourceId(requests)).to.deep.equal(
    sortByResourceId(expected.requests),
  );
  expect(rest).to.deep.equal({
    cache: expected.cache,
    trigger: expected.trigger,
    collapsedCallerCount: expected.collapsedCallerCount,
    outcome: expected.outcome,
  });
}
