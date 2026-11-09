import { getOne, throwIfAnyError, getMany } from "../../utils/utils.js";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite from "node:sqlite";
import { describe, it } from "node:test";

import type {
  CacheSpec,
  Entry,
  NormalizedParams,
  NormalizedProducerDirectives,
  NormalizedVary,
} from "../../types/index.js";
import SqliteStore from "./SqliteStore.js";

type TestContent = {
  value: string;
  nested?: { count: number; labels: string[] };
};
type TestSpec = CacheSpec<string, TestContent>;
type HeterogeneousSpec =
  | CacheSpec<`user:${string}`, { kind: "user"; name: string }>
  | CacheSpec<`posts:${string}`, { kind: "posts"; count: number }>;
type TestParams = { format?: string; lang?: string; audience?: string };

type _SqliteStoreRejectsObjectParams = SqliteStore<
  TestSpec,
  {},
  // @ts-expect-error SqliteStore intentionally supports primitive params only.
  { filter?: { tag: string } }
>;

const matchingParams = {
  format: "json",
  lang: "en",
} as NormalizedParams<TestParams>;
const varyOnFormat = { format: "json" } as NormalizedVary<TestParams>;
const varyOnLanguage = { lang: "en" } as NormalizedVary<TestParams>;
const emptyVary = {} as NormalizedVary<TestParams>;
const directives = { freshUntilAge: 60 } as NormalizedProducerDirectives;

describe("SqliteStore", () => {
  it("roundtrips stored entries through a reopened database", async () => {
    await withTempStore(async ({ databasePath }) => {
      const store = new SqliteStore<TestSpec, {}, TestParams>({ databasePath });
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

      await store.store([{ entry, maxStoreForSeconds: 60 }]);
      await store.close();

      const reopened = new SqliteStore<TestSpec, {}, TestParams>({
        databasePath,
      });
      try {
        const result = await getOne(reopened, {
          id: "id",
          params: matchingParams,
        });

        assert.equal(result.length, 1);
        assert.deepEqual(result[0]?.content, entry.content);
        assert.deepEqual(result[0]?.vary, entry.vary);
        assert.deepEqual(result[0]?.validators, entry.validators);
        assert.deepEqual(result[0]?.directives, entry.directives);
        assert.equal(result[0]?.initialAge, entry.initialAge);
        assert.equal(result[0]?.date.getTime(), entry.date.getTime());
      } finally {
        await reopened.close();
      }
    });
  });

  it("replaces an existing variant on later store calls", async () => {
    await withTempStore(async ({ store }) => {
      await store.store([
        { entry: makeEntry("id", "first"), maxStoreForSeconds: 60 },
      ]);
      await store.store([
        {
          entry: makeEntry("id", "replacement", varyOnFormat, {
            date: new Date("2023-01-01T00:00:00.000Z"),
          }),
          maxStoreForSeconds: 60,
        },
      ]);

      const result = await getOne(store, { id: "id", params: matchingParams });

      assert.equal(result.length, 1);
      assert.deepEqual(result[0]?.content, { value: "replacement" });
    });
  });

  it("ignores expired entries and keeps unexpired entries", async () => {
    await withTempStore(async ({ databasePath, store }) => {
      await store.store([
        { entry: makeEntry("id", "expired"), maxStoreForSeconds: -1 },
        {
          entry: makeEntry("id", "live", varyOnLanguage),
          maxStoreForSeconds: 60,
        },
      ]);

      assert.deepEqual(
        (await getOne(store, { id: "id", params: matchingParams })).map(
          ({ content }) => content,
        ),
        [{ value: "live" }],
      );
      await store.close();

      const reopened = new SqliteStore<TestSpec, {}, TestParams>({
        databasePath,
      });
      try {
        assert.deepEqual(
          (await getOne(reopened, { id: "id", params: matchingParams })).map(
            ({ content }) => content,
          ),
          [{ value: "live" }],
        );
      } finally {
        await reopened.close();
      }
    });
  });

  it("uses fallbackDeleteAfter for entries stored forever", async () => {
    await withTempStore(
      async ({ store }) => {
        await store.store([
          {
            entry: makeEntry("id", "fallback-expired"),
            maxStoreForSeconds: Infinity,
          },
        ]);

        assert.deepEqual(
          await getOne(store, { id: "id", params: matchingParams }),
          [],
        );
      },
      { fallbackDeleteAfter: -1 },
    );
  });

  it("can keep entries stored forever when the fallback is also Infinity", async () => {
    await withTempStore(
      async ({ store }) => {
        await store.store([
          {
            entry: makeEntry("id", "forever"),
            maxStoreForSeconds: Infinity,
          },
        ]);

        assert.deepEqual(
          (await getOne(store, { id: "id", params: matchingParams })).map(
            ({ content }) => content,
          ),
          [{ value: "forever" }],
        );
      },
      { fallbackDeleteAfter: Infinity },
    );
  });

  it("chunks large getMany batches across SQLite variable limits", async () => {
    await withTempStore(async ({ store }) => {
      const requestCount = 33_000;
      const ids = Array.from({ length: requestCount }, (_, i) => `id:${i}`);
      await store.store([
        { entry: makeEntry("id:0", "first"), maxStoreForSeconds: 60 },
        {
          entry: makeEntry(`id:${requestCount - 1}`, "last"),
          maxStoreForSeconds: 60,
        },
      ]);

      const result = await getMany(
        store,
        ids.map((id) => ({ id, params: matchingParams })),
      ).then(throwIfAnyError);

      assert.equal(result.length, requestCount);
      assert.deepEqual(result[0]?.[0]?.content, { value: "first" });
      assert.deepEqual(result.at(-1)?.[0]?.content, { value: "last" });
    });
  });

  it("narrows heterogeneous cache specs at runtime by requested id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cache-sqlite-store-"));
    const databasePath = join(directory, "cache.sqlite");
    const store = new SqliteStore<HeterogeneousSpec, {}, TestParams>({
      databasePath,
    });

    try {
      await store.store([
        {
          entry: {
            ...makeEntry("user:1", "unused", emptyVary),
            id: "user:1",
            content: { kind: "user", name: "Ada" },
          },
          maxStoreForSeconds: 60,
        },
        {
          entry: {
            ...makeEntry("posts:1", "unused", emptyVary),
            id: "posts:1",
            content: { kind: "posts", count: 3 },
          },
          maxStoreForSeconds: 60,
        },
      ]);

      assert.deepEqual(
        (await getOne(store, { id: "user:1", params: matchingParams }))[0]
          ?.content,
        {
          kind: "user",
          name: "Ada",
        },
      );
      assert.deepEqual(
        (await getOne(store, { id: "posts:1", params: matchingParams }))[0]
          ?.content,
        {
          kind: "posts",
          count: 3,
        },
      );
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails clearly for a non-SQLite database file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cache-sqlite-store-"));
    const databasePath = join(directory, "cache.sqlite");

    try {
      await writeFile(databasePath, "not sqlite", "utf8");
      const store = new SqliteStore<TestSpec, {}, TestParams>({ databasePath });

      const failed = await getMany(store, [
        { id: "first", params: matchingParams },
        { id: "second", params: matchingParams },
      ]);
      assert.ok(failed[0] instanceof Error);
      assert.equal(failed[1], failed[0]);
      await assert.rejects(
        async () => getOne(store, { id: "id", params: matchingParams }),
        /file is not a database|database disk image is malformed|SqliteStore/i,
      );
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors already-aborted signals for get and getMany", async () => {
    await withTempStore(async ({ store }) => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () =>
          getOne(
            store,
            { id: "id", params: matchingParams },
            { signal: controller.signal },
          ),
        /aborted|AbortError/i,
      );
      await assert.rejects(
        async () =>
          getMany(store, [{ id: "id", params: matchingParams }] as const, {
            signal: controller.signal,
          }).then(throwIfAnyError),
        /aborted|AbortError/i,
      );
    });
  });

  it("does not need writer access to return unexpired reads", async () => {
    await withTempStore(
      async ({ databasePath, store }) => {
        await store.store([
          { entry: makeEntry("id", "live"), maxStoreForSeconds: 60 },
        ]);

        const locker = new sqlite.DatabaseSync(databasePath, { timeout: 0 });
        try {
          locker.exec("BEGIN IMMEDIATE");

          assert.deepEqual(
            (await getOne(store, { id: "id", params: matchingParams })).map(
              ({ content }) => content,
            ),
            [{ value: "live" }],
          );
        } finally {
          locker.exec("ROLLBACK");
          locker.close();
        }
      },
      { busyTimeoutMs: 25 },
    );
  });

  it("rejects all public operations after close", async () => {
    await withTempStore(async ({ store }) => {
      await store.close();

      await assert.rejects(
        async () => getOne(store, { id: "id", params: matchingParams }),
        /SqliteStore is closed/,
      );
      await assert.rejects(
        async () =>
          getMany(store, [{ id: "id", params: matchingParams }] as const).then(
            throwIfAnyError,
          ),
        /SqliteStore is closed/,
      );
      await assert.rejects(
        async () =>
          store.store([
            { entry: makeEntry("id", "closed"), maxStoreForSeconds: 60 },
          ]),
        /SqliteStore is closed/,
      );
      await assert.rejects(
        async () => store.store([]),
        /SqliteStore is closed/,
      );
      await assert.rejects(
        async () => store.delete("id"),
        /SqliteStore is closed/,
      );
      await store.close();
    });
  });

  it("keeps coherent last-writer-wins state for concurrent writes to one variant", async () => {
    await withTempStore(async ({ store }) => {
      const writes = Array.from({ length: 20 }, (_, i) =>
        store.store([
          {
            entry: makeEntry("id", `value:${i}`, varyOnFormat),
            maxStoreForSeconds: 60,
          },
        ]),
      );

      await Promise.all(writes);

      const result = await getOne(store, { id: "id", params: matchingParams });

      assert.equal(result.length, 1);
      assert.match(result[0]?.content.value ?? "", /^value:\d+$/);
    });
  });

  it("supports multiple store instances writing to the same database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cache-sqlite-store-"));
    const databasePath = join(directory, "cache.sqlite");
    const first = new SqliteStore<TestSpec, {}, TestParams>({
      databasePath,
      readWorkerCount: 2,
    });
    const second = new SqliteStore<TestSpec, {}, TestParams>({
      databasePath,
      readWorkerCount: 2,
    });

    try {
      await Promise.all([
        first.store([
          { entry: makeEntry("first", "from-first"), maxStoreForSeconds: 60 },
        ]),
        second.store([
          { entry: makeEntry("second", "from-second"), maxStoreForSeconds: 60 },
        ]),
      ]);

      assert.deepEqual(
        (await getOne(first, { id: "second", params: matchingParams }))[0]
          ?.content,
        {
          value: "from-second",
        },
      );
      assert.deepEqual(
        (await getOne(second, { id: "first", params: matchingParams }))[0]
          ?.content,
        {
          value: "from-first",
        },
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves a portable database artifact after close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cache-sqlite-store-"));
    const databasePath = join(directory, "cache.sqlite");
    const store = new SqliteStore<TestSpec, {}, TestParams>({ databasePath });

    try {
      await store.store([
        { entry: makeEntry("id", "artifact"), maxStoreForSeconds: 60 },
      ]);
      await store.close();

      assert.deepEqual(
        (await readdir(directory)).filter(
          (filename) => filename !== "cache.sqlite",
        ),
        [],
      );

      const reopened = new SqliteStore<TestSpec, {}, TestParams>({
        databasePath,
      });
      try {
        assert.deepEqual(
          (await getOne(reopened, { id: "id", params: matchingParams }))[0]
            ?.content,
          {
            value: "artifact",
          },
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("preserves successful SQLite chunks around a failed middle chunk", async () => {
  await withTempStore(
    async ({ store, databasePath }) => {
      await store.store(
        [0, 900, 1800].map((index) => ({
          entry: makeEntry(`id:${index}`, String(index)),
          maxStoreForSeconds: 60,
        })),
      );
      // Initialize the one reader before replacing its read relation with a faulting view.
      await store.getMany([{ id: "warm", params: matchingParams }]);
      const db = new sqlite.DatabaseSync(databasePath);
      try {
        db.exec(`ALTER TABLE cache_entries RENAME TO cache_source;
        CREATE VIEW cache_entries AS SELECT resource_id, variant_key, vary,
          CASE WHEN resource_id = 'id:900' THEN json('{') ELSE entry END AS entry,
          expires_at FROM cache_source;`);
        const requests = Array.from({ length: 1801 }, (_, index) => ({
          id: `id:${index}`,
          params: matchingParams,
        }));
        const results = await store.getMany(requests);
        assert.equal(results.length, requests.length);
        const first = results[0];
        const last = results[1800];
        assert.ok(Array.isArray(first));
        assert.ok(Array.isArray(last));
        assert.equal(first[0]?.content.value, "0");
        assert.equal(last[0]?.content.value, "1800");
        assert.ok(
          results.slice(900, 1800).every((slot) => slot instanceof Error),
        );
        assert.equal(results[900], results[1799]);
      } finally {
        db.exec(
          "DROP VIEW cache_entries; ALTER TABLE cache_source RENAME TO cache_entries;",
        );
        db.close();
      }
    },
    { readWorkerCount: 1 },
  );
});

it("fails complete SQLite request slots for malformed variants and entry decoding", async () => {
  await withTempStore(async ({ store, databasePath }) => {
    await store.store([
      { entry: makeEntry("vary-bad", "bad"), maxStoreForSeconds: 60 },
      { entry: makeEntry("entry-bad", "bad"), maxStoreForSeconds: 60 },
      {
        entry: makeEntry("entry-bad", "valid-other-variant", emptyVary),
        maxStoreForSeconds: 60,
      },
      { entry: makeEntry("good", "good"), maxStoreForSeconds: 60 },
    ]);
    const db = new sqlite.DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE cache_entries SET vary = ? WHERE resource_id = ?").run(
        "{",
        "vary-bad",
      );
      db.prepare(
        "UPDATE cache_entries SET entry = ? WHERE resource_id = ? AND vary != '{}'",
      ).run("{", "entry-bad");
      const result = await store.getMany(
        ["vary-bad", "entry-bad", "good"].map((id) => ({
          id,
          params: matchingParams,
        })),
      );
      assert.ok(result[0] instanceof Error);
      assert.ok(result[1] instanceof Error);
      assert.ok(Array.isArray(result[2]));
      assert.equal(result[2][0]?.content.value, "good");
    } finally {
      db.close();
    }
  });
});

async function withTempStore(
  test: (context: {
    databasePath: string;
    store: SqliteStore<TestSpec, {}, TestParams>;
  }) => Promise<void>,
  opts?: {
    busyTimeoutMs?: number;
    fallbackDeleteAfter?: number;
    readWorkerCount?: number;
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "cache-sqlite-store-"));
  const databasePath = join(directory, "cache.sqlite");
  const store = new SqliteStore<TestSpec, {}, TestParams>({
    databasePath,
    ...(opts?.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: opts.busyTimeoutMs }),
    ...(opts?.fallbackDeleteAfter === undefined
      ? {}
      : { fallbackDeleteAfter: opts.fallbackDeleteAfter }),
    ...(opts?.readWorkerCount === undefined
      ? {}
      : { readWorkerCount: opts.readWorkerCount }),
  });

  try {
    await test({ databasePath, store });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
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
): Entry<TestSpec, {}, TestParams> {
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
