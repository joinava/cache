import fc from "fast-check";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { NormalizedProducerDirectivesArb } from "../../test/arbitraries/06_Normalization.js";
import { postgresStoreFixture } from "../../test/fixtures.js";
import type {
  AnyValidators,
  CacheSpec,
  Entry,
  NormalizedParams,
  NormalizedProducerDirectives,
  NormalizedVary,
  Store,
} from "../types/index.js";
import MemoryStore from "./MemoryStore/MemoryStore.js";
import type { PostgresStoreSupportedParams } from "./PostgresStore/PostgresStore.js";
import SqliteStore from "./SqliteStore/SqliteStore.js";

type TestContent = {
  value: string;
  nested?: { count: number; labels: string[] };
};
type TestSpec = CacheSpec<string, TestContent>;
type TestParams = PostgresStoreSupportedParams & {
  format?: string;
  lang?: string;
  audience?: string;
};
type TestStore = Store<TestSpec, AnyValidators, TestParams>;

type StoreFixture = {
  store: TestStore;
  cleanup: () => Promise<void>;
};

const matchingParams = {
  format: "json",
  lang: "en",
  audience: "public",
} as NormalizedParams<TestParams>;
const unmatchedParams = {
  format: "html",
  lang: "en",
  audience: "public",
} as NormalizedParams<TestParams>;
const missingFormatParams = {
  lang: "en",
  audience: "public",
} as NormalizedParams<TestParams>;

const emptyVary = {} as NormalizedVary<TestParams>;
const varyOnFormat = { format: "json" } as NormalizedVary<TestParams>;
const varyOnLanguage = { lang: "en" } as NormalizedVary<TestParams>;
const varyOnAudience = { audience: "public" } as NormalizedVary<TestParams>;
const varyOnMissingFormat = { format: null } as NormalizedVary<TestParams>;
const directives = { freshUntilAge: 60 } as NormalizedProducerDirectives;

describe("Store conformance", () => {
  describe("MemoryStore", () => {
    defineStoreConformance(async () => {
      const store = new MemoryStore<TestSpec, AnyValidators, TestParams>();
      return {
        store,
        cleanup: async () => store.close(),
      };
    });
  });

  describe("SqliteStore", () => {
    defineStoreConformance(async () => {
      const directory = await mkdtemp(join(tmpdir(), "cache-sqlite-store-"));
      const store = new SqliteStore<TestSpec, AnyValidators, TestParams>({
        databasePath: join(directory, "cache.sqlite"),
        readWorkerCount: 2,
      });

      return {
        store,
        cleanup: async () => {
          await store.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    });
  });

  describe(
    "PostgresStore",
    postgresEnvironmentIsConfigured()
      ? {}
      : { skip: "Postgres environment variables are not configured" },
    () => {
      defineStoreConformance(async () => {
        const fixture = postgresStoreFixture();
        return {
          store: fixture.postgresStore as unknown as TestStore,
          cleanup: async () => fixture.cleanup(),
        };
      });
    },
  );
});

function defineStoreConformance(createFixture: () => Promise<StoreFixture>) {
  it("returns empty results for misses and empty getMany requests", async () => {
    await withStore(createFixture, async (store) => {
      await store.store([]);
      await store.delete("missing");

      assert.deepEqual(await store.get("missing", matchingParams), []);
      assert.deepEqual(await store.getMany([] as const), []);
    });
  });

  it("roundtrips stored entry data without mutating input", async () => {
    await withStore(createFixture, async (store) => {
      const entry = makeEntry("id", "first", varyOnFormat, {
        content: { value: "first", nested: { count: 2, labels: ["a", "b"] } },
        validators: { etag: "abc" },
        directives: {
          freshUntilAge: 60,
          maxStale: {
            withoutRevalidation: 10,
            whileRevalidate: 20,
            ifError: 30,
          },
        } as NormalizedProducerDirectives,
      });
      const originalEntry = snapshotEntry(entry);

      await store.store([{ entry, maxStoreForSeconds: 60 }]);
      const result = await store.get("id", matchingParams);

      assert.deepEqual(snapshotEntry(entry), originalEntry);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0]?.content, entry.content);
      assert.deepEqual(result[0]?.vary, entry.vary);
      assert.deepEqual(result[0]?.validators, entry.validators);
      assert.deepEqual(result[0]?.directives, entry.directives);
      assert.equal(result[0]?.initialAge, entry.initialAge);
      assert.equal(result[0]?.date.getTime(), entry.date.getTime());
    });
  });

  it("roundtrips any storable normalized entry identically", async () => {
    await withStore(createFixture, async (store) => {
      // Both `fc.record` and `fc.dictionary` produce null-prototype objects,
      // which are not `assert.deepEqual` to the regular-prototype objects that
      // `JSON.parse` returns. Recursively reparent so JSON-based stores can
      // roundtrip the input unchanged.
      const reparent = <T>(value: T): T => {
        if (Array.isArray(value)) return value.map(reparent) as unknown as T;
        if (value && typeof value === "object" && !(value instanceof Date)) {
          return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, reparent(v)]),
          ) as T;
        }
        return value;
      };

      // Generate a NormalizedVary made of primitive (string|number|boolean)
      // values or null, matching what PostgresStore/SqliteStore can store. The
      // request params we build below from this vary are then guaranteed to
      // match the variant.
      const primitiveParamValueArb = fc.oneof(
        fc.string(),
        fc.integer(),
        fc.boolean(),
      );

      const varyArb = fc
        .dictionary(
          fc.string({ minLength: 1 }),
          fc.oneof(primitiveParamValueArb, fc.constant(null)),
        )
        .map((d) => reparent({ ...d }) as NormalizedVary<TestParams>);

      const contentArb = fc
        .tuple(
          fc.string(),
          fc.option(
            fc.record({
              count: fc.integer(),
              labels: fc.array(fc.string()),
            }),
            { nil: undefined },
          ),
        )
        .map(([value, nested]): TestContent =>
          nested !== undefined
            ? { value, nested: reparent(nested) }
            : { value },
        );

      const validatorsArb = fc
        .dictionary(fc.string({ minLength: 1 }), fc.string())
        .map((d) => ({ ...d }) as Record<string, string>);

      const entryArb: fc.Arbitrary<Entry<TestSpec, AnyValidators, TestParams>> =
        fc.record({
          // Use a unique id per generated entry to avoid runs colliding.
          id: fc.uuid(),
          vary: varyArb,
          content: contentArb,
          initialAge: fc.nat(),
          // fc.date() can produce Invalid Date; filter those out since they
          // don't roundtrip meaningfully through any serialization.
          date: fc.date().filter((d) => !Number.isNaN(d.getTime())),
          directives: NormalizedProducerDirectivesArb.map(reparent),
          validators: validatorsArb,
        });

      await fc.assert(
        fc.asyncProperty(entryArb, async (entry) => {
          // Build request params that will exactly match this entry's variant:
          // include every non-null vary entry as a param with the same value;
          // omit keys whose vary value is null.
          const params = Object.fromEntries(
            Object.entries(entry.vary).filter(([, v]) => v !== null),
          ) as NormalizedParams<TestParams>;

          await store.delete(entry.id);
          await store.store([{ entry, maxStoreForSeconds: Infinity }]);
          const result = await store.get(entry.id, params);

          assert.equal(result.length, 1, "expected exactly one matching entry");
          const got = result[0];
          assert.ok(got);
          assert.equal(got.id, entry.id);
          assert.deepEqual(got.vary, entry.vary);
          assert.deepEqual(got.content, entry.content);
          assert.deepEqual(got.validators, entry.validators);
          assert.deepEqual(got.directives, entry.directives);
          assert.equal(got.initialAge, entry.initialAge);
          assert.equal(got.date.getTime(), entry.date.getTime());

          await store.delete(entry.id);
        }),
        { numRuns: 100 },
      );
    });
  });

  it("roundtrips Infinity values in directives as Infinity", async () => {
    await withStore(createFixture, async (store) => {
      const entry = makeEntry("id", "infinite", varyOnFormat, {
        directives: {
          freshUntilAge: Infinity,
          storeFor: Infinity,
          maxStale: {
            withoutRevalidation: Infinity,
            whileRevalidate: Infinity,
            ifError: Infinity,
          },
        } as NormalizedProducerDirectives,
      });

      await store.store([{ entry, maxStoreForSeconds: 60 }]);
      const result = await store.get("id", matchingParams);

      assert.equal(result.length, 1);
      assert.equal(result[0]?.directives.freshUntilAge, Infinity);
      assert.equal(result[0]?.directives.storeFor, Infinity);
      assert.equal(result[0]?.directives.maxStale?.withoutRevalidation, Infinity);
      assert.equal(result[0]?.directives.maxStale?.whileRevalidate, Infinity);
      assert.equal(result[0]?.directives.maxStale?.ifError, Infinity);
    });
  });

  it("only returns entries matching the requested id", async () => {
    await withStore(createFixture, async (store) => {
      await store.store([
        { entry: makeEntry("id", "wanted"), maxStoreForSeconds: 60 },
        { entry: makeEntry("other", "unwanted"), maxStoreForSeconds: 60 },
      ]);

      const result = await store.get("id", matchingParams);

      assert.deepEqual(
        result.map(({ id, content }) => [id, content.value]),
        [["id", "wanted"]],
      );
    });
  });

  it("matches vary subsets exactly and can return multiple matching variants", async () => {
    await withStore(createFixture, async (store) => {
      await store.store([
        { entry: makeEntry("id", "empty", emptyVary), maxStoreForSeconds: 60 },
        {
          entry: makeEntry("id", "format", varyOnFormat),
          maxStoreForSeconds: 60,
        },
        {
          entry: makeEntry("id", "lang", varyOnLanguage),
          maxStoreForSeconds: 60,
        },
        {
          entry: makeEntry("id", "audience", varyOnAudience),
          maxStoreForSeconds: 60,
        },
      ]);

      assert.deepEqual(
        (await store.get("id", matchingParams))
          .map(({ content }) => content.value)
          .sort(),
        ["audience", "empty", "format", "lang"],
      );
      assert.deepEqual(
        (await store.get("id", unmatchedParams))
          .map(({ content }) => content.value)
          .sort(),
        ["audience", "empty", "lang"],
      );
    });
  });

  it("matches null vary values against missing params", async () => {
    await withStore(createFixture, async (store) => {
      await store.store([
        { entry: makeEntry("id", "empty", emptyVary), maxStoreForSeconds: 60 },
        {
          entry: makeEntry("id", "missing-format", varyOnMissingFormat),
          maxStoreForSeconds: 60,
        },
      ]);

      assert.deepEqual(
        (await store.get("id", missingFormatParams))
          .map(({ content }) => content.value)
          .sort(),
        ["empty", "missing-format"],
      );
      assert.deepEqual(
        (await store.get("id", matchingParams)).map(
          ({ content }) => content.value,
        ),
        ["empty"],
      );
    });
  });

  it("preserves getMany order, duplicate requests, misses, and per-request params", async () => {
    await withStore(createFixture, async (store) => {
      await store.store([
        { entry: makeEntry("one", "one-json"), maxStoreForSeconds: 60 },
        {
          entry: makeEntry("one", "one-any", emptyVary),
          maxStoreForSeconds: 60,
        },
        { entry: makeEntry("two", "two-json"), maxStoreForSeconds: 60 },
      ]);

      const result = await store.getMany([
        { id: "one", params: matchingParams },
        { id: "missing", params: matchingParams },
        { id: "two", params: unmatchedParams },
        { id: "one", params: unmatchedParams },
        { id: "one", params: matchingParams },
      ] as const);

      assert.deepEqual(result[0].map(({ content }) => content.value).sort(), [
        "one-any",
        "one-json",
      ]);
      assert.deepEqual(result[1], []);
      assert.deepEqual(result[2], []);
      assert.deepEqual(
        result[3].map(({ content }) => content.value),
        ["one-any"],
      );
      assert.deepEqual(result[4].map(({ content }) => content.value).sort(), [
        "one-any",
        "one-json",
      ]);
    });
  });

  it("deletes all variants for an id and leaves other ids alone", async () => {
    await withStore(createFixture, async (store) => {
      await store.store([
        {
          entry: makeEntry("id", "format", varyOnFormat),
          maxStoreForSeconds: 60,
        },
        {
          entry: makeEntry("id", "lang", varyOnLanguage),
          maxStoreForSeconds: 60,
        },
        {
          entry: makeEntry("other", "other", emptyVary),
          maxStoreForSeconds: 60,
        },
      ]);

      await store.delete("id");

      assert.deepEqual(await store.get("id", matchingParams), []);
      assert.deepEqual((await store.get("other", matchingParams))[0]?.content, {
        value: "other",
      });
    });
  });

  it("treats delete of a missing id as a no-op", async () => {
    await withStore(createFixture, async (store) => {
      await store.store([
        { entry: makeEntry("id", "first"), maxStoreForSeconds: 60 },
      ]);

      await store.delete("missing");

      assert.equal((await store.get("id", matchingParams)).length, 1);
    });
  });

  it("supports concurrent stores to different ids", async () => {
    await withStore(createFixture, async (store) => {
      const ids = Array.from({ length: 20 }, (_, i) => `id:${i}`);

      await Promise.all(
        ids.map(async (id, i) =>
          store.store([
            {
              entry: makeEntry(id, `value:${i}`),
              maxStoreForSeconds: 60,
            },
          ]),
        ),
      );

      const result = await store.getMany(
        ids.map((id) => ({ id, params: matchingParams })),
      );

      assert.deepEqual(
        result
          .flatMap((entries) => entries.map(({ content }) => content.value))
          .sort(),
        ids.map((_, i) => `value:${i}`).sort(),
      );
    });
  });

  it("keeps returned entries valid while stores and deletes overlap", async () => {
    await withStore(createFixture, async (store) => {
      await store.store(
        Array.from({ length: 12 }, (_, i) => ({
          entry: makeEntry(`id:${i}`, `initial:${i}`),
          maxStoreForSeconds: 60,
        })),
      );

      const operations: Promise<unknown>[] = [];
      for (let i = 0; i < 12; i += 1) {
        const id = `id:${i}`;
        operations.push(
          store.store([
            {
              entry: makeEntry(id, `updated:${i}`),
              maxStoreForSeconds: 60,
            },
          ]),
          store.get(id, matchingParams).then((entries) => {
            for (const entry of entries) {
              assert.equal(entry.id, id);
              assert.deepEqual(entry.vary, varyOnFormat);
            }
          }),
        );
        if (i % 3 === 0) {
          operations.push(store.delete(id));
        }
      }

      await Promise.all(operations);
    });
  });
}

async function withStore(
  createFixture: () => Promise<StoreFixture>,
  test: (store: TestStore) => Promise<void>,
) {
  const { store, cleanup } = await createFixture();
  try {
    await test(store);
  } finally {
    await cleanup();
  }
}

function makeEntry(
  id: string,
  value: string,
  vary: NormalizedVary<TestParams> = varyOnFormat,
  opts?: {
    content?: TestContent;
    date?: Date;
    directives?: NormalizedProducerDirectives;
    initialAge?: number;
    validators?: Record<string, string>;
  },
): Entry<TestSpec, AnyValidators, TestParams> {
  return {
    id,
    content: opts?.content ?? { value },
    vary,
    validators: opts?.validators ?? {},
    directives: opts?.directives ?? directives,
    initialAge: opts?.initialAge ?? 0,
    date: opts?.date ?? new Date("2024-01-01T00:00:00.000Z"),
  };
}

function snapshotEntry(entry: Entry<TestSpec, AnyValidators, TestParams>) {
  return {
    ...entry,
    date: entry.date.toISOString(),
  };
}

function postgresEnvironmentIsConfigured(): boolean {
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
