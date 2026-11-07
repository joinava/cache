import MemoryStore from "../src/stores/MemoryStore/MemoryStore.js";
import { naiveGetMany } from "../src/utils/utils.js";
import pg from "pg";
import { mock } from "node:test";

import fc from "fast-check";
import type { JSON } from "type-party";
import PostgresStore, {
  type PostgresStoreSupportedParams,
} from "../src/stores/PostgresStore/PostgresStore.js";
import {
  type AnyParams,
  type AnyValidators,
  type CacheSpec,
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
export function postgresStoreFixture() {
  try {
    const postgres = new pg.Pool({
      host: process.env["DATABASE_HOST"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
      port: Number(process.env["DATABASE_PORT"]!), // eslint-disable-line @typescript-eslint/no-non-null-assertion
      database: process.env["DATABASE_NAME"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
      user: process.env["DATABASE_USER"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
      password: process.env["DATABASE_PASSWORD"]!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
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

/** A bulk-only test Store backed by real MemoryStore reads and writes. */
export function bulkMemoryStore<
  Spec extends import("../src/types/index.js").CacheSpec =
    import("../src/types/index.js").CacheSpec,
>() {
  const memory = new MemoryStore<Spec>();
  return {
    async getMany<
      const Reqs extends
        readonly import("../src/types/index.js").StoreGetManyRequest<
          Spec,
          AnyParams
        >[],
    >(requests: Reqs, options?: { signal?: AbortSignal }) {
      return await naiveGetMany(memory, requests, 10, options);
    },
    store: memory.store.bind(memory),
    delete: memory.delete.bind(memory),
    close: memory.close.bind(memory),
    [Symbol.asyncDispose]: memory[Symbol.asyncDispose].bind(memory),
  };
}
