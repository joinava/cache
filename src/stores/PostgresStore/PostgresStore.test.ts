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
    fixture.queryMocks
      .flatMap((query) => query.mock.calls)
      .map(({ arguments: [text, parameters] }) => ({
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
    const results = await store.getMany(
      ids.map((id) => ({ id, params: noParams })),
    );
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
        fixture.queryMocks
          .flatMap((query) => query.mock.calls)
          .map(({ arguments: [text] }) => String(text));
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
        const results = await store.getMany([
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
        ]);
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
            store.getMany([
              { id: "a", params: noParams },
              {
                id: "a",
                params: {
                  format,
                } as unknown as NormalizedParams<PostgresStoreSupportedParams>,
              },
            ]),
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
          (await store.getMany(requests)).map(contents),
          expected,
        );
        for (const [index, request] of requests.entries()) {
          assert.deepEqual(
            contents(await store.get(request.id, request.params)),
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
        const results = await store.getMany(
          ids.map((id) => ({ id, params: noParams })),
        );
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
        for (const query of fixture.queryMocks) {
          // Hold the store at its query boundary, then abort before the
          // query resolves; getMany must reject after awaiting that result.
          query.mock.mockImplementationOnce((async () => {
            controller.abort(reason);
            return { rows: [] };
          }) as unknown as typeof query);
        }

        await assert.rejects(
          store.getMany([{ id: "a", params: noParams }], {
            signal: controller.signal,
          }),
          (error) => error === reason,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  },
);
