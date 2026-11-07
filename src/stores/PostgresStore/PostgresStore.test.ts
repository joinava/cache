import { throwIfAnyError, getMany, getOne } from "../../utils/utils.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
} from "../../types/index.js";
import type { PostgresStoreSupportedParams } from "./PostgresStore.js";

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
