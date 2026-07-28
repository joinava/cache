import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite from "node:sqlite";
import { describe, it } from "node:test";
import { isNonEmptyArray } from "type-party/runtime/nonempty.js";

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
const unmatchedParams = {
  format: "html",
  lang: "en",
} as NormalizedParams<TestParams>;
const missingFormatParams = { lang: "en" } as NormalizedParams<TestParams>;
const varyOnFormat = { format: "json" } as NormalizedVary<TestParams>;
const varyOnMissingFormat = { format: null } as NormalizedVary<TestParams>;
const varyOnLanguage = { lang: "en" } as NormalizedVary<TestParams>;
const emptyVary = {} as NormalizedVary<TestParams>;
const directives = { freshUntilAge: 60 } as NormalizedProducerDirectives;

describe("SqliteStore", () => {
  it("returns empty results for misses and empty getMany requests", async () => {
    await withTempStore(async ({ store }) => {
      await store.delete("missing");

      assert.deepEqual(await store.get("missing", matchingParams), []);
      assert.deepEqual(await store.getMany([] as const), []);
    });
  });

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
        const result = await reopened.get("id", matchingParams);

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

  it("keeps the newest birth date when one store call contains duplicate variants", async () => {
    await withTempStore(async ({ store }) => {
      await store.store([
        {
          entry: makeEntry("id", "oldest", varyOnFormat, {
            date: new Date("2024-01-01T00:00:00.000Z"),
          }),
          maxStoreForSeconds: 60,
        },
        {
          entry: makeEntry("id", "later-date-but-older-birth", varyOnFormat, {
            date: new Date("2024-01-01T00:00:10.000Z"),
            initialAge: 20,
          }),
          maxStoreForSeconds: 60,
        },
        {
          entry: makeEntry("id", "newest-birth", varyOnFormat, {
            date: new Date("2024-01-01T00:00:05.000Z"),
          }),
          maxStoreForSeconds: 60,
        },
      ]);

      const result = await store.get("id", matchingParams);

      assert.equal(result.length, 1);
      assert.deepEqual(result[0]?.content, { value: "newest-birth" });
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

      const result = await store.get("id", matchingParams);

      assert.equal(result.length, 1);
      assert.deepEqual(result[0]?.content, { value: "replacement" });
    });
  });

  it("deletes all variants for an id", async () => {
    await withTempStore(async ({ store }) => {
      await store.store([
        { entry: makeEntry("id", "first"), maxStoreForSeconds: 60 },
        {
          entry: makeEntry("id", "second", varyOnLanguage),
          maxStoreForSeconds: 60,
        },
        {
          entry: makeEntry("other", "other", {} as NormalizedVary<TestParams>),
          maxStoreForSeconds: 60,
        },
      ]);

      await store.delete("id");

      assert.deepEqual(await store.get("id", matchingParams), []);
      assert.equal((await store.get("other", matchingParams)).length, 1);
    });
  });

  it("treats delete of a missing id as a no-op", async () => {
    await withTempStore(async ({ store }) => {
      await store.store([
        { entry: makeEntry("id", "first"), maxStoreForSeconds: 60 },
      ]);

      await store.delete("missing");

      assert.equal((await store.get("id", matchingParams)).length, 1);
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
        (await store.get("id", matchingParams)).map(({ content }) => content),
        [{ value: "live" }],
      );
      await store.close();

      const reopened = new SqliteStore<TestSpec, {}, TestParams>({
        databasePath,
      });
      try {
        assert.deepEqual(
          (await reopened.get("id", matchingParams)).map(
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

        assert.deepEqual(await store.get("id", matchingParams), []);
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
          (await store.get("id", matchingParams)).map(({ content }) => content),
          [{ value: "forever" }],
        );
      },
      { fallbackDeleteAfter: Infinity },
    );
  });

  it("matches vary subsets exactly and can return multiple matching variants", async () => {
    await withTempStore(async ({ store }) => {
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
          entry: makeEntry("id", "missing-format", varyOnMissingFormat),
          maxStoreForSeconds: 60,
        },
      ]);

      assert.deepEqual(
        (await store.get("id", matchingParams))
          .map(({ content }) => content.value)
          .sort(),
        ["empty", "format", "lang"],
      );
      assert.deepEqual(
        (await store.get("id", missingFormatParams))
          .map(({ content }) => content.value)
          .sort(),
        ["empty", "lang", "missing-format"],
      );
      assert.deepEqual(
        (await store.get("id", unmatchedParams))
          .map(({ content }) => content.value)
          .sort(),
        ["empty", "lang"],
      );
    });
  });

  it("supports getMany order, duplicates, misses, and per-request params", async () => {
    await withTempStore(async ({ store }) => {
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
    });
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

      const result = await store.getMany(
        ids.map((id) => ({ id, params: matchingParams })),
      );

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
        (await store.get("user:1", matchingParams))[0]?.content,
        {
          kind: "user",
          name: "Ada",
        },
      );
      assert.deepEqual(
        (await store.get("posts:1", matchingParams))[0]?.content,
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

      await assert.rejects(
        async () => store.get("id", matchingParams),
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
          store.get("id", matchingParams, { signal: controller.signal }),
        /aborted|AbortError/i,
      );
      await assert.rejects(
        async () =>
          store.getMany([{ id: "id", params: matchingParams }] as const, {
            signal: controller.signal,
          }),
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
            (await store.get("id", matchingParams)).map(
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
        async () => store.get("id", matchingParams),
        /SqliteStore is closed/,
      );
      await assert.rejects(
        async () =>
          store.getMany([{ id: "id", params: matchingParams }] as const),
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
        async () => store.delete("id"),
        /SqliteStore is closed/,
      );
      await store.close();
    });
  });

  it("supports many concurrent writes to different ids", async () => {
    await withTempStore(
      async ({ store }) => {
        const ids = Array.from({ length: 40 }, (_, i) => `id:${i}`);

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
      },
      { readWorkerCount: 4 },
    );
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

      const result = await store.get("id", matchingParams);

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
        (await first.get("second", matchingParams))[0]?.content,
        {
          value: "from-second",
        },
      );
      assert.deepEqual(
        (await second.get("first", matchingParams))[0]?.content,
        {
          value: "from-first",
        },
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps get results valid while stores and deletes run concurrently", async () => {
    await withTempStore(
      async ({ store }) => {
        const seedBatch = Array.from({ length: 20 }, (_, i) => ({
          entry: makeEntry(`id:${i}`, `initial:${i}`),
          maxStoreForSeconds: 60,
        }));
        assert.ok(isNonEmptyArray(seedBatch));
        await store.store(seedBatch);

        const operations: Promise<unknown>[] = [];
        for (let i = 0; i < 20; i += 1) {
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

        for (let i = 0; i < 20; i += 1) {
          const id = `id:${i}`;
          for (const entry of await store.get(id, matchingParams)) {
            assert.equal(entry.id, id);
            assert.deepEqual(entry.vary, varyOnFormat);
          }
        }
      },
      { readWorkerCount: 4 },
    );
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
          (await reopened.get("id", matchingParams))[0]?.content,
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
