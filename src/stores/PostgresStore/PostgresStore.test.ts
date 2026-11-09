import { throwIfAnyError, getMany, getOne } from "../../utils/utils.js";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import fc from "fast-check";
import {
  normalizeVary,
  normalizeProducerDirectives,
} from "../../utils/normalization.js";

import {
  postgresEnvironmentIsConfigured,
  postgresStoreFixture,
} from "../../../test/fixtures.js";
import type {
  AnyValidators,
  CacheSpec,
  Entry,
  NormalizedParams,
  NormalizedProducerDirectives,
  NormalizedVary,
  StoreEntryInput,
} from "../../types/index.js";
import PostgresStore, {
  type PostgresStoreSupportedParams,
} from "./PostgresStore.js";

type StringSpec = CacheSpec<string, string>;

const noParams =
  {} as unknown as NormalizedParams<PostgresStoreSupportedParams>;

function makeEntry(
  id: string,
): Entry<StringSpec, AnyValidators, PostgresStoreSupportedParams> {
  return {
    id,
    content: id,
    vary: {} as unknown as NormalizedVary<PostgresStoreSupportedParams>,
    validators: {},
    directives: { freshUntilAge: 60 } as NormalizedProducerDirectives,
    initialAge: 0,
    date: new Date("2024-01-01T00:00:00.000Z"),
  };
}

/**
 * Stores one entry per id, then runs `getMany` for those ids and returns its
 * result together with every statement that the `getMany` call sent.
 */
async function getManyStatements(ids: readonly string[]) {
  const fixture = postgresStoreFixture();
  const statements = () =>
    fixture.queryMock.mock.calls.map(({ arguments: [text, parameters] }) => ({
      text: String(text),
      parameterCount: Array.isArray(parameters as unknown)
        ? (parameters as unknown[]).length
        : 0,
    }));
  try {
    const store = fixture.postgresStore;
    await store.store(
      ids.map((id) => ({ entry: makeEntry(id), maxStoreForSeconds: 60 })),
    );

    const before = statements().length;
    const results = await getMany(
      store,
      ids.map((id) => ({ id, params: noParams })),
    ).then(throwIfAnyError);
    return { results, statements: statements().slice(before) };
  } finally {
    await fixture.cleanup();
  }
}

type Spec = CacheSpec<string, { value: number }>;
type Params = PostgresStoreSupportedParams;
type Input = StoreEntryInput<Spec, AnyValidators, Params>;
type Statement = { sql: string; parameters: readonly unknown[] };
const emptyVary = {} as NormalizedVary<Params>;
const directives = { freshUntilAge: 60 } as NormalizedProducerDirectives;
function input(id: string, value: number, date = new Date(1_000)): Input {
  const entry: Entry<Spec, AnyValidators, Params> = {
    id,
    content: { value },
    vary: emptyVary,
    directives,
    validators: { etag: String(value) },
    initialAge: 0,
    date,
  };
  return { entry, maxStoreForSeconds: 60 };
}
async function fixture() {
  const schema = `cache_bulk_${randomUUID().replaceAll("-", "")}`;
  const qualified = `"${schema}"."entries"`;
  const pool = new pg.Pool({
    host: process.env["DATABASE_HOST"],
    port: Number(process.env["DATABASE_PORT"]),
    user: process.env["DATABASE_USER"],
    password: process.env["DATABASE_PASSWORD"],
    database: process.env["DATABASE_NAME"],
    statement_timeout: 15_000,
  });
  const store = new PostgresStore<Spec, AnyValidators, Params>(pool, {
    schemaName: schema,
    tableName: "entries",
  });
  await getOne(store, {
    id: "initialize",
    params: {} as NormalizedParams<Params>,
  });
  return {
    store,
    pool,
    qualified,
    cleanup: async () => {
      await pool.query(`drop schema "${schema}" cascade`);
      await pool.end();
    },
  };
}
function observeQueries(
  beforeQuery?: (statement: Statement) => Promise<void> | undefined,
) {
  const statements: Statement[] = [];
  // oxlint-disable-next-line typescript-eslint/unbound-method -- Reflect.apply below restores each actual client as the receiver.
  const original = pg.Client.prototype.query;
  const query = mock.method(pg.Client.prototype, "query", function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const statement = {
      sql: String(args[0]),
      parameters: Array.isArray(args[1]) ? args[1] : [],
    };
    statements.push(statement);
    const pending = beforeQuery?.(statement);
    return pending === undefined
      ? Reflect.apply(original, this, args)
      : pending.then(() => Reflect.apply(original, this, args));
  } as typeof pg.Client.prototype.query);
  return { statements, restore: () => query.mock.restore() };
}
const postgresConfigured = [
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
  "DATABASE_NAME",
].every((key) => process.env[key] !== undefined);

describe(
  "PostgresStore.getMany",
  postgresEnvironmentIsConfigured()
    ? { timeout: 60_000 }
    : { skip: "Postgres environment variables are not configured" },
  () => {
    it("preserves successful chunks around a failed middle query without retries", async () => {
      const fixture = postgresStoreFixture();
      try {
        const store = fixture.postgresStore;
        await store.store(
          [0, 1000, 2000].map((index) => ({
            entry: makeEntry(`id:${index}`),
            maxStoreForSeconds: 60,
          })),
        );
        const before = fixture.queryMock.mock.callCount();
        const failure = new TypeError("middle query failed");
        fixture.queryMock.mock.mockImplementationOnce(() => {
          throw failure;
        }, before + 1);
        const results = await store.getMany(
          Array.from({ length: 2001 }, (_, index) => ({
            id: `id:${index}`,
            params: noParams,
          })),
        );
        const first = results[0];
        const last = results[2000];
        assert.ok(Array.isArray(first));
        assert.ok(Array.isArray(last));
        assert.equal(first[0]?.content, "id:0");
        assert.equal(last[0]?.content, "id:2000");
        assert.ok(results.slice(1000, 2000).every((slot) => slot === failure));
        assert.equal(fixture.queryMock.mock.callCount() - before, 3);
      } finally {
        await fixture.cleanup();
      }
    });

    it("invalidates a complete request when one stored variant cannot decode", async () => {
      const fixture = postgresStoreFixture();
      try {
        const store = fixture.postgresStore;
        await store.store(
          ["bad", "good"].map((id) => ({
            entry: makeEntry(id),
            maxStoreForSeconds: 60,
          })),
        );
        await fixture.postgres.query(
          `INSERT INTO "${fixture.schemaName}"."${fixture.tableName}" (resource_id, vary, entry) SELECT resource_id, '{"language":null}'::jsonb, jsonb_set(entry, '{vary}', '{"language":null}'::jsonb) FROM "${fixture.schemaName}"."${fixture.tableName}" WHERE resource_id = 'bad'`,
        );
        await fixture.postgres.query(
          `UPDATE "${fixture.schemaName}"."${fixture.tableName}" SET entry = jsonb_set(entry, '{date}', '"invalid-date"') WHERE resource_id = 'bad' AND vary = '{}'::jsonb`,
        );
        const result = await store.getMany([
          { id: "bad", params: noParams },
          { id: "good", params: noParams },
        ]);
        assert.ok(result[0] instanceof Error);
        assert.ok(Array.isArray(result[1]));
        assert.equal(result[1][0]?.content, "good");
      } finally {
        await fixture.cleanup();
      }
    });

    it("stops subsequent chunks after caller cancellation", async () => {
      const fixture = postgresStoreFixture();
      try {
        const store = fixture.postgresStore;
        await store.store([]);
        const controller = new AbortController();
        const reason = new Error("cancelled between chunks");
        const before = fixture.queryMock.mock.callCount();
        fixture.queryMock.mock.mockImplementationOnce(() => {
          controller.abort(reason);
          throw reason;
        }, before + 1);
        await assert.rejects(
          store.getMany(
            Array.from({ length: 2001 }, (_, index) => ({
              id: String(index),
              params: noParams,
            })),
            { signal: controller.signal },
          ),
          (error) => error === reason,
        );
        assert.equal(fixture.queryMock.mock.callCount() - before, 2);
      } finally {
        await fixture.cleanup();
      }
    });

    it("keeps query mocks isolated between fixture calls", async () => {
      const first = postgresStoreFixture();
      const second = postgresStoreFixture();
      try {
        await Promise.all(
          [first, second].map((fixture) =>
            fixture.postgresStore.store([
              { entry: makeEntry("a"), maxStoreForSeconds: 60 },
            ]),
          ),
        );
        assert.notEqual(first.queryMock, second.queryMock);
        first.queryMock.mock.resetCalls();
        second.queryMock.mock.resetCalls();
        await getMany(first.postgresStore, [
          { id: "a", params: noParams },
        ]).then(throwIfAnyError);
        assert.equal(first.queryMock.mock.callCount(), 1);
        assert.equal(second.queryMock.mock.callCount(), 0);
        const failure = new Error("first fixture only");
        first.queryMock.mock.mockImplementationOnce((async () => {
          throw failure;
        }) as unknown as typeof first.queryMock);
        const [failed, succeeded] = await Promise.allSettled([
          getMany(first.postgresStore, [{ id: "a", params: noParams }]).then(
            throwIfAnyError,
          ),
          getMany(second.postgresStore, [{ id: "a", params: noParams }]).then(
            throwIfAnyError,
          ),
        ]);
        assert.deepEqual(failed, { status: "rejected", reason: failure });
        assert.equal(succeeded.status, "fulfilled");
        assert.equal(first.queryMock.mock.callCount(), 2);
        assert.equal(second.queryMock.mock.callCount(), 1);
      } finally {
        await Promise.all([first.cleanup(), second.cleanup()]);
      }
    });

    it("records queries from multiple pool connections in one mock", async () => {
      const fixture = postgresStoreFixture();
      try {
        await fixture.postgresStore.store([
          { entry: makeEntry("a"), maxStoreForSeconds: 60 },
        ]);
        const first = await fixture.postgres.connect();
        const second = await fixture.postgres.connect();
        try {
          assert.notEqual(first, second);
          const before = fixture.queryMock.mock.callCount();
          const results = await Promise.all([
            first.query("select $1::text as value", ["first"]),
            second.query("select $1::text as value", ["second"]),
          ]);
          assert.deepEqual(
            results.map(({ rows }) => rows),
            [[{ value: "first" }], [{ value: "second" }]],
          );
          assert.equal(fixture.queryMock.mock.callCount() - before, 2);
          assert.deepEqual(
            fixture.queryMock.mock.calls
              .slice(before)
              .map(({ arguments: args }) => args[1]),
            [["first"], ["second"]],
          );
        } finally {
          first.release();
          second.release();
        }
      } finally {
        await fixture.cleanup();
      }
    });

    it("reads 25 ids with one select statement", async () => {
      const ids = Array.from({ length: 25 }, (_, i) => `id:${String(i)}`);

      const { results, statements } = await getManyStatements(ids);

      assert.equal(statements.length, 1);
      assert.match(statements[0]?.text ?? "", /^select r\.request_index/);
      assert.deepEqual(
        results.map((entries) => entries.map(({ content }) => content)),
        ids.map((id) => [id]),
      );
    });

    it("splits more than 1,000 requests into statements of at most 1,000 requests", async () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `id:${String(i)}`);

      const { results, statements } = await getManyStatements(ids);

      assert.deepEqual(
        statements.map(({ parameterCount }) => parameterCount),
        [3000, 3],
      );
      assert.deepEqual(
        results.map((entries) => entries.map(({ content }) => content)),
        ids.map((id) => [id]),
      );
    });

    it("keeps a separate result slot for every duplicate request", async () => {
      const { results, statements } = await getManyStatements([
        "a",
        "b",
        "a",
        "a",
      ]);

      assert.deepEqual(
        statements.map(({ parameterCount }) => parameterCount),
        [12],
      );
      assert.deepEqual(
        results.map((entries) => entries.map(({ content }) => content)),
        [["a"], ["b"], ["a"], ["a"]],
      );
    });

    it("filters each request's variants in SQL, preserving null-as-absence, duplicates, and misses", async () => {
      const fixture = postgresStoreFixture();
      const statements = () =>
        fixture.queryMock.mock.calls.map(({ arguments: [text] }) =>
          String(text),
        );
      try {
        const store = fixture.postgresStore;
        await store.store(
          [
            { ...makeEntry("a"), content: "any" },
            {
              ...makeEntry("a"),
              content: "json",
              vary: {
                format: "json",
              } as unknown as NormalizedVary<PostgresStoreSupportedParams>,
            },
            {
              ...makeEntry("a"),
              content: "absent",
              vary: {
                format: null,
              } as unknown as NormalizedVary<PostgresStoreSupportedParams>,
            },
            {
              ...makeEntry("a"),
              content: "html",
              vary: {
                format: "html",
              } as unknown as NormalizedVary<PostgresStoreSupportedParams>,
            },
          ].map((entry) => ({ entry, maxStoreForSeconds: 60 })),
        );
        const before = statements().length;
        const results = await getMany(store, [
          {
            id: "a",
            params: {
              format: "json",
            } as unknown as NormalizedParams<PostgresStoreSupportedParams>,
          },
          { id: "missing", params: noParams },
          { id: "a", params: noParams },
          {
            id: "a",
            params: {
              format: "json",
            } as unknown as NormalizedParams<PostgresStoreSupportedParams>,
          },
        ]).then(throwIfAnyError);
        assert.deepEqual(
          results.map((entries) =>
            entries
              .map(({ content }) => {
                assert.equal(typeof content, "string");
                return content as string;
              })
              .sort((a, b) => a.localeCompare(b)),
          ),
          [["any", "json"], [], ["absent", "any"], ["any", "json"]],
        );
        assert.equal(statements().length - before, 1);
        assert.match(statements()[before]!, /jsonb_each/);
        assert.match(statements()[before]!, /"r"\."params"/);
        for (const format of ["\ud800", "\u0000"]) {
          await assert.rejects(
            getMany(store, [
              { id: "a", params: noParams },
              {
                id: "a",
                params: {
                  format,
                } as unknown as NormalizedParams<PostgresStoreSupportedParams>,
              },
            ]).then(throwIfAnyError),
          );
        }
      } finally {
        await fixture.cleanup();
      }
    });

    it("matches empty vary for every supported param set without treating null-only vary as empty", async () => {
      const fixture = postgresStoreFixture();
      try {
        const store = fixture.postgresStore;
        await store.store(
          [
            { ...makeEntry("empty-vary"), content: "any" },
            {
              ...makeEntry("empty-vary"),
              content: "absent",
              vary: {
                format: null,
              } as unknown as NormalizedVary<PostgresStoreSupportedParams>,
            },
            {
              ...makeEntry("empty-vary"),
              content: "json",
              vary: {
                format: "json",
              } as unknown as NormalizedVary<PostgresStoreSupportedParams>,
            },
          ].map((entry) => ({ entry, maxStoreForSeconds: 60 })),
        );
        const requests = [
          {},
          { format: "json" },
          { format: "html" },
          { format: false },
          { format: 0 },
          { format: "" },
          { unrelated: "present" },
        ].map((params) => ({
          id: "empty-vary",
          params:
            params as unknown as NormalizedParams<PostgresStoreSupportedParams>,
        }));
        const expected = [
          ["absent", "any"],
          ["any", "json"],
          ["any"],
          ["any"],
          ["any"],
          ["any"],
          ["absent", "any"],
        ];
        const contents = (entries: readonly { content: unknown }[]) =>
          entries
            .map(({ content }) => {
              assert.equal(typeof content, "string");
              return content as string;
            })
            .sort((a, b) => a.localeCompare(b));
        assert.deepEqual(
          (await getMany(store, requests).then(throwIfAnyError)).map(contents),
          expected,
        );
        for (const [index, request] of requests.entries()) {
          assert.deepEqual(
            contents(
              await getOne(store, { id: request.id, params: request.params }),
            ),
            expected[index],
          );
        }
      } finally {
        await fixture.cleanup();
      }
    });

    it("keeps explicit empty slots for ID collisions among hits, misses, and duplicates", async () => {
      const fixture = postgresStoreFixture();
      try {
        const store = fixture.postgresStore;
        await store.store(
          ["�x", "hit"].map((id) => ({
            entry: makeEntry(id),
            maxStoreForSeconds: 60,
          })),
        );
        const ids = ["hit", "\ud800x", "missing", "�x", "\ud801x", "hit"];
        const results = await getMany(
          store,
          ids.map((id) => ({ id, params: noParams })),
        ).then(throwIfAnyError);
        assert.equal(results.length, ids.length);
        assert.ok(results.every(Array.isArray));
        assert.deepEqual(
          results.map((entries) => entries.map(({ id }) => id)),
          [["hit"], [], [], ["�x"], [], ["hit"]],
        );
      } finally {
        await fixture.cleanup();
      }
    });

    it("rejects with the abort reason when the signal aborts while the query runs", async () => {
      const controller = new AbortController();
      const reason = new Error("caller gave up");
      const fixture = postgresStoreFixture();
      try {
        const store = fixture.postgresStore;
        await store.store([{ entry: makeEntry("a"), maxStoreForSeconds: 60 }]);
        // Abort at the query boundary, before getMany receives its result.
        fixture.queryMock.mock.mockImplementationOnce((async () => {
          controller.abort(reason);
          return { rows: [] };
        }) as unknown as typeof fixture.queryMock);

        await assert.rejects(
          getMany(store, [{ id: "a", params: noParams }], {
            signal: controller.signal,
          }).then(throwIfAnyError),
          (error) => error === reason,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  },
);

describe(
  "PostgresStore bulk persistence",
  postgresConfigured ? {} : { skip: "Postgres is not configured" },
  () => {
    it("keeps the newest birth date among duplicate slots in one write", async (t) => {
      const { store, cleanup } = await fixture();
      t.after(cleanup);
      await store.store([
        input("duplicate", 1, new Date(1000)),
        input("duplicate", 3, new Date(3000)),
        input("duplicate", 2, new Date(2000)),
      ]);
      const entries = await getOne(store, {
        id: "duplicate",
        params: {} as NormalizedParams<Params>,
      });
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0]?.content, { value: 3 });
      assert.equal(entries[0]?.date.getTime(), 3000);
    });

    it("keeps the one-statement fast path for a small write", async () => {
      const f = await fixture();
      const observed = observeQueries();
      try {
        assert.deepEqual(await f.store.store([input("one", 1)]), [
          { relationshipToExistingStoredData: "is-new" },
        ]);
        assert.equal(observed.statements.length, 1);
        assert.match(observed.statements[0]!.sql, /^with "old"/i);
      } finally {
        observed.restore();
        await f.cleanup();
      }
    });

    it(
      "stores 23000 unique slots beyond the former bind limit with ordered duplicate metadata",
      { timeout: 30_000 },
      async () => {
        const f = await fixture();
        const observed = observeQueries();
        const entries = Array.from({ length: 23_000 }, (_, index) =>
          input(`id:${String(index).padStart(5, "0")}`, 1),
        );
        entries[0] = input(
          JSON.stringify(["visit", 'quote" and slash\\ and newline\n']),
          1,
        );
        entries.push(
          input("id:01000", 2, new Date(2_000)),
          input("id:01000", 0, new Date(0)),
        );
        try {
          const results = await f.store.store(entries.toReversed());
          assert.equal(results.length, entries.length);
          assert.deepEqual(results[0], {});
          assert.deepEqual(results[1], {
            relationshipToExistingStoredData: "is-new",
          });
          assert.deepEqual(results[entries.length - 1 - 1_000], {});
          assert.equal(
            results.filter(
              (result) => result.relationshipToExistingStoredData === "is-new",
            ).length,
            23_000,
          );
          const inserts = observed.statements.filter((statement) =>
            /^with "old"/i.test(statement.sql),
          );
          assert.equal(inserts.length, 23);
          assert.ok(
            inserts.every((statement) => statement.parameters.length <= 5_000),
          );
          const metadata = observed.statements.filter(
            (statement) =>
              /^select /i.test(statement.sql) &&
              statement.sql.includes("'validators'"),
          );
          assert.equal(metadata.length, 0);
          const rows = await f.pool.query<{ count: number }>(
            `select count(*)::int as count from ${f.qualified}`,
          );
          assert.equal(rows.rows[0]!.count, 23_000);
          const winner = await getOne(f.store, {
            id: "id:01000",
            params: {} as NormalizedParams<Params>,
          });
          assert.equal(winner[0]!.content.value, 2);
          const repeated = await f.store.store(entries.toReversed());
          assert.equal(
            repeated.filter(
              (result) =>
                result.relationshipToExistingStoredData === "unchanged",
            ).length,
            23_000,
          );
        } finally {
          observed.restore();
          await f.cleanup();
        }
      },
    );

    it("compares only each batch's slots when one id has variants across batches", async () => {
      const f = await fixture();
      const entries = Array.from({ length: 1_001 }, (_, index) => {
        const value = input("shared", 1);
        return {
          ...value,
          entry: {
            ...value.entry,
            vary: normalizeVary<Params>(
              (name) => name,
              (_name, item) => {
                assert.ok(typeof item === "number");
                return item;
              },
              { variant: index },
            ),
          },
        };
      });
      try {
        await f.store.store(entries);
        const results = await f.store.store(
          entries.map((value) => ({
            ...value,
            entry: { ...value.entry, validators: { etag: "2" } },
          })),
        );
        assert.equal(results.length, entries.length);
        assert.ok(
          results.every(
            (result) => result.relationshipToExistingStoredData === "changed",
          ),
        );
      } finally {
        await f.cleanup();
      }
    });

    it("rolls every batch back if a later batch fails", async () => {
      const f = await fixture();
      await f.store.store([input("id:00000", 1)]);
      await f.pool.query(
        `alter table ${f.qualified} add constraint reject_last check (resource_id <> 'zz:reject')`,
      );
      const observed = observeQueries();
      try {
        const entries = Array.from({ length: 1_500 }, (_, index) =>
          input(`id:${String(index).padStart(5, "0")}`, 2),
        );
        entries.push(input("zz:reject", 2));
        await assert.rejects(
          f.store.store(entries),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23514",
        );
        assert.equal(
          observed.statements.filter((statement) =>
            /^with "old"/i.test(statement.sql),
          ).length,
          2,
        );
        assert.ok(
          observed.statements.some((statement) =>
            /^rollback/i.test(statement.sql),
          ),
        );
        const rows = await f.pool.query<{
          resource_id: string;
          entry: { content: { value: number } };
        }>(`select resource_id, entry from ${f.qualified}`);
        assert.equal(rows.rows.length, 1);
        assert.equal(rows.rows[0]!.resource_id, "id:00000");
        assert.equal(rows.rows[0]!.entry.content.value, 1);
      } finally {
        observed.restore();
        await f.cleanup();
      }
    });

    it("compares each batch against its own pre-write metadata snapshot", async () => {
      const f = await fixture();
      const keys = Array.from(
        { length: 2_001 },
        (_, index) => `id:${String(index).padStart(5, "0")}`,
      );
      await f.store.store(keys.map((id) => input(id, 1)));
      const lateId = keys[1_500]!;
      const progress = { writes: 0, interfered: false };
      const observed = observeQueries((statement) => {
        if (/^with "old"/i.test(statement.sql)) {
          progress.writes += 1;
          if (progress.writes === 2) {
            return f.pool
              .query(
                `update ${f.qualified} set entry = $1::jsonb where resource_id = $2`,
                [JSON.stringify(input(lateId, 9).entry), lateId],
              )
              .then(() => {
                progress.interfered = true;
              });
          }
        }
        return undefined;
      });
      try {
        const results = await f.store.store(
          keys.map((id) => input(id, id === lateId ? 1 : 2)),
        );
        assert.equal(progress.interfered, true);
        assert.deepEqual(results[1_500], {
          relationshipToExistingStoredData: "changed",
        });
        assert.deepEqual(results[0], {
          relationshipToExistingStoredData: "changed",
        });
        const stored = await getOne(f.store, {
          id: lateId,
          params: {} as NormalizedParams<Params>,
        });
        assert.equal(stored[0]!.content.value, 1);
      } finally {
        observed.restore();
        await f.cleanup();
      }
    });

    it(
      "uses the legacy global UTF-16 lock order across concurrent old and batched writers",
      { timeout: 30_000 },
      async () => {
        const f = await fixture();
        const keys = [
          ...Array.from(
            { length: 2_001 },
            (_, index) => `id:${String(index).padStart(5, "0")}`,
          ),
          "id:\u{10000}",
          "id:\ue000",
        ];
        await f.store.store(keys.map((id) => input(id, 1)));
        const sortedKeys = keys.toSorted((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        const legacyParameters = sortedKeys.flatMap((id) => [
          id,
          "{}",
          JSON.stringify(input(id, 3).entry),
        ]);
        const legacySql = `insert into ${f.qualified} (resource_id, vary, entry) values ${sortedKeys.map((_id, index) => `($${3 * index + 1}, $${3 * index + 2}, $${3 * index + 3})`).join(",")} on conflict (resource_id, vary) do update set entry = excluded.entry`;
        const bothReady = Promise.withResolvers<void>();
        const state = { firstWrites: 0 };
        const observed = observeQueries((statement) => {
          if (
            (/^with "old"/i.test(statement.sql) ||
              /^insert into /i.test(statement.sql)) &&
            statement.sql.includes(f.qualified) &&
            state.firstWrites < 2
          ) {
            state.firstWrites += 1;
            if (state.firstWrites === 2) bothReady.resolve();
            return bothReady.promise;
          }
          return undefined;
        });
        try {
          await Promise.all([
            f.store.store(keys.toReversed().map((id) => input(id, 2))),
            f.pool.query(legacySql, legacyParameters),
          ]);
          const newWrites = observed.statements.filter(
            (statement) =>
              /^with "old"/i.test(statement.sql) &&
              statement.parameters.length > 0 &&
              JSON.parse(
                String(
                  statement.parameters[
                    (statement.parameters.length * 2) / 5 + 2
                  ],
                ),
              ).content.value === 2,
          );
          assert.deepEqual(
            newWrites.flatMap((statement) =>
              statement.parameters
                .slice((statement.parameters.length * 2) / 5)
                .filter((_parameter, index) => index % 3 === 0),
            ),
            sortedKeys,
          );
          const values = await f.pool.query<{ value: number }>(
            `select distinct (entry->'content'->>'value')::int as value from ${f.qualified}`,
          );
          assert.equal(values.rows.length, 1);
          assert.ok(values.rows[0]!.value === 2 || values.rows[0]!.value === 3);
        } finally {
          bothReady.resolve();
          observed.restore();
          await f.cleanup();
        }
      },
    );
  },
);

const concurrentEmptyVary = {} as NormalizedVary<{}>;
describe(
  "Postgres concurrent writes",
  postgresEnvironmentIsConfigured()
    ? {}
    : { skip: "Postgres is not configured" },
  () => {
    it("does not deadlock when concurrent store() calls hit overlapping slots in different orders", async (t) => {
      // Postgres processes a multi-row INSERT ... ON CONFLICT DO UPDATE's rows
      // in order, locking each conflicting row as it goes. If concurrent
      // store() calls could lock the same rows in DIFFERENT orders, each could
      // grab a row the other is waiting on, and Postgres would abort one with
      // a "deadlock detected" error (40P01) after deadlock_timeout. The store
      // must therefore order its rows deterministically, so concurrent calls
      // acquire locks in one global order and merely wait on each other. This
      // property drives concurrent same-slot batches in forward and reversed
      // input orders; without deterministic ordering it deadlocks reliably.
      const fixture = postgresStoreFixture();
      const store = fixture.postgresStore;
      t.after(() => fixture.cleanup());
      const write = (
        data: {
          id: string;
          vary: NormalizedVary<{}>;
          content: { i: number; padding: string };
          directives: { freshUntilAge: number };
        }[],
      ) =>
        store.store(
          data.map((entry) => ({
            entry: {
              ...entry,
              directives: normalizeProducerDirectives(entry.directives),
              validators: {},
              date: new Date(),
              initialAge: 0,
            },
            maxStoreForSeconds: 60,
          })),
        );

      await fc.assert(
        fc.asyncProperty(
          fc.record({
            runId: fc.uuid(),
            slotCount: fc.integer({ min: 60, max: 120 }),
          }),
          async ({ runId, slotCount }) => {
            const data = Array.from({ length: slotCount }, (_unused, i) => ({
              id: `${runId}:${String(i)}`,
              vary: concurrentEmptyVary,
              // A non-trivial payload keeps each row's processing from being
              // instantaneous, widening the window in which the concurrent
              // statements actually interleave.
              content: { i, padding: "x".repeat(2048) },
              directives: { freshUntilAge: 60 },
            }));

            // Seed the slots so the concurrent calls below take the
            // row-UPDATE (lock-then-wait) path on every slot.
            await write(data);

            const reversed = data.toReversed();
            const results = await Promise.allSettled([
              write(data),
              write(reversed),
              write(data),
              write(reversed),
            ]);
            // Surface the rejection reasons (e.g. "deadlock detected") in the
            // assertion diff, rather than an opaque `{ status: 'rejected' }`.
            const failures = results.flatMap((r) =>
              r.status === "rejected" ? [String(r.reason)] : [],
            );
            assert.deepEqual(failures, []);
          },
        ),
        // Each run is expensive (hundreds of rows across 5 statements), and a
        // single run of ~100 reversed-order rows already reproduces the
        // deadlock essentially every time when ordering is nondeterministic.
        // Skip shrinking: a deadlock is binary and shrinking would rerun many
        // ~1s deadlock_timeout cycles.
        { numRuns: 3, endOnFailure: true },
      );
    });
  },
);
