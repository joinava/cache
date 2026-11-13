import MemoryStore from "../src/stores/MemoryStore/MemoryStore.js";
import { readStoreObserved } from "../src/utils/utils.js";
import pg from "pg";
import { mock } from "node:test";
import Cache from "../src/cache/Cache.js";
import type { BatchOptions } from "@zingage/scheduling";
import wrapProducer from "../src/wrapProducer/wrapProducer.js";

import fc from "fast-check";
import type { JSON } from "type-party";
import PostgresStore, {
  type PostgresStoreSupportedParams,
} from "../src/stores/PostgresStore/PostgresStore.js";
import {
  type AnyParams,
  type AnyValidators,
  type CacheSpec,
  type Store,
  type StoreGetManyRequest,
  type NormalizedVary,
  type ProducerDirectives,
} from "../src/types/index.js";
import { normalizeProducerResultResource } from "../src/utils/normalization.js";
import {
  classify,
  EntryClassification,
  isFresh,
} from "../src/utils/normalizedProducerResultResourceHelpers.js";
import { ConsumerDirectivesArb } from "./arbitraries/03_ConsumerRequest.js";
import { NormalizedProducerDirectivesArb } from "./arbitraries/06_Normalization.js";
import { PositiveNumberArb } from "./arbitraries/utils.js";
import {
  ACCEPT_ANY_REGISTRY,
  freshFor100,
  uniqueCacheName,
} from "./v2AcceptanceHelpers.js";

// If a resource's initialAge is too big, its implicit birthdate will be older
// than the oldest date JS can represent. That's not remotely an issue in
// practice [JS's oldest date is ~272,000 years ago], but it has to be guarded
// against in these property based tests by capping initial age.
export const MAX_INITIAL_AGE = 999999999999;

const UniqueIdArb = fc
  .tuple(fc.uuid(), fc.integer(), fc.string())
  .map(([id, id2, id3]) => `${id}-${id2}-${id3}`);

// Any date in the past, when an entry could've been produced.
export const ProducedAtArb = fc.date({ noInvalidDate: true, max: new Date() });

// NB: uses `isFresh`, so obviously don't use this to test `isFresh`!
export const FreshEntryArb = (minFreshSecondsLeft: number = 0) =>
  fc
    .tuple(
      NormalizedProducerDirectivesArb,
      fc.oneof(PositiveNumberArb, fc.constant(0)),
      ProducedAtArb,
    )
    .filter(([{ freshUntilAge }, initialAge, producedAt]) =>
      isFresh(
        dummyEntryData({ freshUntilAge }, initialAge, undefined, producedAt),
        new Date(Date.now() + minFreshSecondsLeft * 1000),
      ),
    )
    .chain(([dirs, initialAge, producedAt]) =>
      UniqueIdArb.map((id) => ({
        ...dummyEntryData(dirs, initialAge, undefined, producedAt),
        id,
      })),
    );

export const StaleEntryArb = fc.oneof(
  // Make the entry stale by setting initialAge to be greater than freshUntilAge
  // This ensures that (producedAt + initialAge) > (producedAt + freshUntilAge)
  // meaning the entry was fresh until some point in the past
  fc.tuple(NormalizedProducerDirectivesArb, UniqueIdArb).map(([dirs, id]) => {
    const initialAge = Math.min(
      MAX_INITIAL_AGE,
      Math.max(0, dirs.freshUntilAge) + 10,
    );
    return { ...dummyEntryData(dirs, initialAge), id };
  }),
  // OR, make the entry stale by indicating that it was produced longer in the
  // past than the freshUntilAge.
  fc
    .tuple(
      PositiveNumberArb,
      fc.date({ noInvalidDate: true, max: new Date() }),
      UniqueIdArb,
    )
    .map(([freshUntilAge, pastDate, id]) => {
      const producedAtDateGuaranteeingStaleness = new Date(
        pastDate.valueOf() - (freshUntilAge + 1) * 1000,
      );

      return {
        ...dummyEntryData(
          { freshUntilAge },
          0,
          undefined,
          producedAtDateGuaranteeingStaleness,
        ),
        id,
      };
    }),
);

export const UsableEntryArb = fc
  .tuple(fc.oneof(FreshEntryArb(), StaleEntryArb), ConsumerDirectivesArb)
  .filter(
    ([entry, consumerDirs]) =>
      // Make it still usable in a second at least
      classify(entry, consumerDirs, new Date(Date.now() + 1000)) ===
      EntryClassification.Usable,
  )
  .map(([entry, consumerDirs]) => ({ entry, consumerDirs }));

export const UsableWhileRevalidateEntryArb = fc
  .tuple(StaleEntryArb, ConsumerDirectivesArb)
  .filter(([entry, consumerDirs]) => {
    // make sure it's usable while revalidate now _and_ in a second, to give us
    // some buffer room from maxStale[0] and maxStale[2]
    const resultNow = classify(entry, consumerDirs, new Date());
    return (
      resultNow === EntryClassification.UsableWhileRevalidate &&
      resultNow === classify(entry, consumerDirs, new Date(Date.now() + 1000))
    );
  })
  .map(([entry, consumerDirs]) => ({ entry, consumerDirs }));

export const UsableIfErrorEntryArb = fc
  .tuple(StaleEntryArb, ConsumerDirectivesArb)
  .filter(([entry, consumerDirs]) => {
    const resultNow = classify(entry, consumerDirs, new Date());
    return (
      resultNow === EntryClassification.UsableIfError &&
      resultNow === classify(entry, consumerDirs, new Date(Date.now() + 1000))
    );
  })
  .map(([entry, consumerDirs]) => ({ entry, consumerDirs }));

export const UnusableEntryArb = fc
  .tuple(fc.oneof(StaleEntryArb, FreshEntryArb(5)), ConsumerDirectivesArb)
  .filter(
    ([entry, consumerDirs]) =>
      classify(entry, consumerDirs, new Date()) ===
      EntryClassification.Unusable,
  )
  .map(([entry, consumerDirs]) => ({ entry, consumerDirs }));

export function dummyEntryData(
  directives: ProducerDirectives = { freshUntilAge: 1 },
  initialAge: number = 0,
  validators: object = {},
  producedAt: Date = new Date(),
) {
  return normalizeProducerResultResource(
    (it) => it as NormalizedVary<AnyParams>,
    {
      id: "dummy",
      vary: {},
      content: "Dummy content!",
      validators,
      directives,
      initialAge,
      date: producedAt,
    },
  );
}

/**
 * Whether the environment names a test Postgres database. Suites that need one
 * skip themselves when it does not; `pnpm test:docker` provides one.
 */
export function postgresEnvironmentIsConfigured(): boolean {
  return [
    "DATABASE_HOST",
    "DATABASE_PORT",
    "DATABASE_NAME",
    "DATABASE_USER",
    "DATABASE_PASSWORD",
  ].every(
    (key) => typeof process.env[key] === "string" && process.env[key] !== "",
  );
}

/** Exposes one query mock for all connections belonging to this pool. */
export function postgresStoreFixture(
  options: { statementTimeoutMs?: number } = {},
) {
  try {
    const postgres = new pg.Pool({
      host: process.env["DATABASE_HOST"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
      port: Number(process.env["DATABASE_PORT"]!), // eslint-disable-line @typescript-eslint/no-non-null-assertion
      database: process.env["DATABASE_NAME"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
      user: process.env["DATABASE_USER"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
      password: process.env["DATABASE_PASSWORD"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
      ...(options.statementTimeoutMs === undefined
        ? {}
        : { statement_timeout: options.statementTimeoutMs }),
    });
    // Keep the receiver: pg's query method uses `this` to reach the active
    // connection. Each fixture creates its own mock, shared only by that pool's clients.
    // eslint-disable-next-line typescript-eslint/unbound-method -- Installed as client.query below; mock.fn preserves the receiver.
    const queryMock = mock.fn(pg.Client.prototype.query);
    postgres.on("connect", (client) => {
      client.query = queryMock;
    });
    // Use a new schema AND table name for each store instance so that tests
    // (and test files, which node runs in parallel) can't interfere with each
    // other: cleanup drops the whole schema, so a schema shared across
    // fixtures would let one suite's cleanup destroy another suite's
    // still-in-use tables mid-run.
    const schemaName = `cache_test_${Math.random()}`.replace(/\./g, "_");
    const tableName = `cache-test-${Math.random()}`.replace(/\./g, "_");
    const postgresStore = new PostgresStore<
      CacheSpec<string, JSON>,
      AnyValidators,
      PostgresStoreSupportedParams
    >(postgres, {
      schemaName,
      tableName,
    });

    return {
      postgres,
      postgresStore,
      queryMock,
      schemaName,
      tableName,
      async cleanup() {
        // eslint-disable-next-line no-console
        console.log("Cleaning up postgres store");
        await postgresStore[Symbol.asyncDispose]();
        await postgres.query(`drop schema "${schemaName}" cascade`);
        await postgres.end();
      },
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    throw error;
  }
}

/**
 * A Store that implements only getMany (MemoryStore implements only get). A
 * Cache batches reads only for Stores with getMany, so tests of readBatching,
 * autoBatch, and the read-store `getMany` operation use this Store. Its
 * getMany fans out to MemoryStore.get, so a slot can hold an Error.
 */
export function bulkMemoryStore<Spec extends CacheSpec = CacheSpec>() {
  const memory = new MemoryStore<Spec>();
  return {
    async getMany<
      const Reqs extends readonly StoreGetManyRequest<Spec, AnyParams>[],
    >(requests: Reqs, options?: { signal?: AbortSignal }) {
      return await readStoreObserved(memory, requests, options);
    },
    store: memory.store.bind(memory),
    delete: memory.delete.bind(memory),
    close: memory.close.bind(memory),
  };
}

/**
 * Reads a known set straight from a Store, through either read primitive.
 * Tests use it to check Store behavior below the Cache. The package does not
 * export it, because applications read through a Cache.
 */
export async function getMany<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  const Reqs extends readonly StoreGetManyRequest<Spec, Params>[],
>(
  store: Store<Spec, Validators, Params>,
  requests: Reqs,
  options?: { signal?: AbortSignal },
) {
  return await readStoreObserved(store, requests, options);
}

/** Reads one request straight from a Store. An Error slot rejects the call. */
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
  const [result] = await getMany(store, [request] as const, options);
  if (result instanceof Error) throw result;
  return result;
}

/** A content type for tests that store string content under any id. */
export type Spec = CacheSpec<string, string>;

/** A consumer request with no directives. */
export const lookup = (id: string, params: Record<string, string> = {}) => ({
  id,
  params,
  directives: {},
});

// A read that never settles would otherwise hang the run (node:test waits for
// a pending test forever), so each suite fails after a bound instead.
export const suiteOptions = { timeout: 20_000 };

type BulkMemoryStore = ReturnType<typeof bulkMemoryStore<Spec>>;

/**
 * A bulkMemoryStore whose getMany calls are spied on.
 * - `beforeGetMany` runs before each read, so a test can hold a read open.
 * - `slotErrors` replaces the result slot of each listed id with its Error.
 */
export function spiedStore(
  options: {
    beforeGetMany?: (
      requests: Parameters<BulkMemoryStore["getMany"]>[0],
    ) => Promise<void>;
    slotErrors?: Readonly<Record<string, Error>>;
  } = {},
) {
  const store = bulkMemoryStore<Spec>();
  const getMany = store.getMany.bind(store);
  const getManySpy = mock.method(
    store,
    "getMany",
    async (...args: Parameters<typeof getMany>) => {
      await options.beforeGetMany?.(args[0]);
      const results = await getMany(...args);
      const { slotErrors } = options;
      if (slotErrors === undefined) return results;
      return results.map((slot, index) => {
        const failure = slotErrors[args[0][index]!.id];
        return failure ?? slot;
      }) as typeof results;
    },
  );
  return {
    store,
    /** The number of requests in each `getMany` call, in call order. */
    getManyRequestCounts: () =>
      getManySpy.mock.calls.map(({ arguments: [requests] }) => requests.length),
  };
}

/**
 * A Cache over `store` that accepts any id, with a unique name so that
 * captureChannels sees only this test's messages. A getMany Store gets the
 * default read batching.
 */
export const cacheOver = (
  store: BulkMemoryStore | MemoryStore<Spec> = new MemoryStore<Spec>(),
  options: {
    name?: string;
    readBatching?: BatchOptions;
  } = {},
) =>
  new Cache({
    store,
    name: uniqueCacheName(options.name ?? "cache"),
    resourceTypes: ACCEPT_ANY_REGISTRY,
    ...(options.readBatching && { readBatching: options.readBatching }),
  });

/**
 * A cache and a wrapProducer client whose produceMany records the ids of each
 * call and echoes each id as fresh content. Both close after the test, also
 * when an assertion fails.
 */
export async function recordingClient(
  t: { after: (fn: () => Promise<void>) => void },
  options: {
    name?: string;
    store?: BulkMemoryStore | MemoryStore<Spec>;
    readBatching?: { maxBatchSize: number };
    producerBatching?: BatchOptions;
    seed?: Parameters<ReturnType<typeof cacheOver>["store"]>[0];
    content?: (id: string) => string;
    onProduce?: (ids: readonly string[]) => Promise<void>;
  } = {},
) {
  const cache = cacheOver(options.store, options);
  if (options.seed) await cache.store(options.seed);
  const calls: string[][] = [];
  const client = wrapProducer({
    cache,
    ...(options.producerBatching && {
      producerBatching: options.producerBatching,
    }),
    produceMany: async (requests) => {
      const ids = requests.map(({ id }) => id);
      calls.push(ids);
      await options.onProduce?.(ids);
      return ids.map((id) => ({
        content: options.content?.(id) ?? id,
        directives: freshFor100,
      }));
    },
  });
  t.after(async () => {
    await client.close();
    await cache.close();
  });
  return { cache, client, calls };
}
