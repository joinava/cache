import { expect } from "chai";
import fc from "fast-check";
import { after, before, describe, it, mock } from "node:test";
import { makeTestWithFixture } from "test-with-fixture";

import { setTimeout as delay } from "timers/promises";
import { dummyEntryData, postgresStoreFixture } from "../test/fixtures.js";
import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import type PostgresStore from "./stores/PostgresStore/PostgresStore.js";
import type { CacheSpec } from "./types/00_CacheSpec.js";
import { type JSON } from "./types/utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("Cache", { concurrency: true }, () => {
  let memoryStore: MemoryStore<CacheSpec<string, JSON>, any, any>,
    postgresStore: PostgresStore<CacheSpec<string, JSON>, any, any>,
    postgresCleanup: () => Promise<void>;

  before(async () => {
    memoryStore = new MemoryStore();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    ({ postgresStore, cleanup: postgresCleanup } = postgresStoreFixture());
  });

  after(async () => {
    // eslint-disable-next-line no-console
    console.info(
      "Waiting for any redis cleanup tasks to finish before closing Redis connection...",
    );

    await Promise.all([memoryStore[Symbol.asyncDispose](), postgresCleanup()]);
  });

  // The value returned when there's no cached response at all for the resource
  // (or id + params pair in the event of a cached response with a varyKeys),
  // or if there are some cached responses but they aren't usable in any way
  // (i.e., are expired, have no validation info, and are outside any
  // stale-if-error or stale-while-revalidate windows that may exist).
  const noCachedResponsesResult = {
    usableIfError: undefined,
    validatable: [],
  };

  const emptyVary = {};
  const storeContentGenerators = {
    memory: (it: JSON = [String(Math.random())]) => it,
    postgres: (it: JSON = Math.random()) => ({ "hello!": it }),
  };

  const randomURI = () =>
    `https://example.com/${String(Date.now() * Math.random())}`;

  Object.entries(storeContentGenerators).forEach(
    ([storeName, contentGenerator]) => {
      describe(`getting/storing from ${storeName} store`, () => {
        const testWithCache = makeTestWithFixture(it, () => {
          let store;
          switch (storeName) {
            case "postgres":
              store = postgresStore;
              break;
            case "memory":
              store = memoryStore;
              break;
            default:
              throw new Error(`Unknown store: ${storeName}`);
          }
          return { cache: new Cache(store) };
        });

        describe("totally-uncached responses", () => {
          testWithCache(
            "should return an object with no responses",
            async ({ cache }) => {
              const res = await cache.get({
                id: "https://example.com/not-cached",
                params: {},
                directives: {},
              });
              expect(res).to.deep.eq(
                noCachedResponsesResult,
                "No cache entry found",
              );
            },
          );
        });

        describe("expired responses w/o etag", () => {
          describe("without a staleWhileRevalidate period", () => {
            testWithCache(
              "should return an object with no responses",
              async ({ cache }) => {
                const id = randomURI();
                const content = contentGenerator();
                await cache.store([
                  {
                    id,
                    vary: emptyVary,
                    content,
                    directives: { freshUntilAge: 0.01 }, // 10ms
                  },
                ]);

                return delay(20).then(async () => {
                  expect(
                    await cache.get({ id, params: {}, directives: {} }),
                  ).to.deep.eq(noCachedResponsesResult, "No cache entry found");
                });
              },
            );
          });

          describe("with an expired staleWhileRevalidate period", () => {
            testWithCache(
              "should return an object with no responses",
              async ({ cache }) => {
                const uri = randomURI();
                const content = contentGenerator();
                await cache.store([
                  {
                    id: uri,
                    vary: emptyVary,
                    content,
                    directives: {
                      freshUntilAge: 0.01,
                      maxStale: {
                        withoutRevalidation: 0,
                        whileRevalidate: 0.01,
                        ifError: 0.01,
                      },
                    },
                  },
                ]);

                return delay(50).then(async () => {
                  expect(
                    await cache.get({
                      id: uri,
                      params: { "Random-header": "true" },
                      directives: {},
                    }),
                  ).to.deep.eq(noCachedResponsesResult, "No cache entry found");
                });
              },
            );
          });

          describe("with an in-progress staleWhileRevalidate period", () => {
            testWithCache(
              "should return content and an indication that refetch is needed",
              async ({ cache }) => {
                const uri = randomURI();
                const content = contentGenerator();
                await cache.store([
                  {
                    id: uri,
                    vary: { accept: "text/html" },
                    content,
                    directives: {
                      freshUntilAge: 0.01,
                      maxStale: {
                        withoutRevalidation: 0,
                        whileRevalidate: 1,
                        ifError: 1,
                      },
                    },
                  },
                ]);

                return delay(20).then(async () => {
                  const res = await cache.get({
                    id: uri,
                    params: { accept: "text/html" },
                    directives: {},
                  });

                  expect(res.usable).to.eq(undefined);
                  expect(res.usableIfError).to.eq(undefined);
                  expect(res.validatable).to.deep.eq([]);
                  expect(res.usableWhileRevalidate).to.deep.include({
                    content,
                  });
                });
              },
            );
          });
        });

        describe("expired entries w/ etag", () => {
          describe("without a staleWhileRevalidate period", () => {
            testWithCache(
              "should return content w/ indication that it's usable _only_ for validation requests",
              async ({ cache }) => {
                const uri = randomURI();
                const content = contentGenerator();
                await cache.store([
                  {
                    id: uri,
                    ...emptyVary,
                    content,
                    directives: { freshUntilAge: 0.02 },
                    validators: { etag: "w/11111" },
                  },
                ]);

                return delay(40).then(async () => {
                  const res = await cache.get({
                    id: uri,
                    params: {},
                    directives: {},
                  });
                  expect(res.usable).to.eq(undefined);
                  expect(res.usableIfError).to.eq(undefined);
                  expect(res.usableWhileRevalidate).to.eq(undefined);
                  expect(res.validatable).to.have.lengthOf(1);
                  expect(res.validatable[0]).to.deep.include({
                    content,
                    validators: { etag: "w/11111" },
                  });
                });
              },
            );
          });

          describe("with an expired staleWhileRevalidate period", () => {
            testWithCache(
              "should return content w/ indication that it's usable _only_ for validation requests",
              async ({ cache }) => {
                const uri = randomURI();
                const content = contentGenerator();
                await cache.store([
                  {
                    id: uri,
                    ...emptyVary,
                    content,
                    directives: {
                      freshUntilAge: 0.01,
                      maxStale: {
                        withoutRevalidation: 0,
                        whileRevalidate: 0.02,
                        ifError: 0.02,
                      },
                    },
                    validators: { etag: "w/11111" },
                  },
                ]);

                return delay(40).then(async () => {
                  const res = await cache.get({
                    id: uri,
                    params: {},
                    directives: {},
                  });
                  expect(res.usable).to.eq(undefined);
                  expect(res.usableIfError).to.eq(undefined);
                  expect(res.usableWhileRevalidate).to.eq(undefined);
                  expect(res.validatable).to.have.lengthOf(1);
                  expect(res.validatable[0]).to.deep.include({
                    content,
                    validators: { etag: "w/11111" },
                  });
                });
              },
            );
          });

          describe("with an in-progress staleWhileRefresh period", () => {
            testWithCache(
              "should return a usableWhileRevalidate response, with same as usable for validation",
              async ({ cache }) => {
                const uri = randomURI();
                const content = contentGenerator();
                await cache.store([
                  {
                    id: uri,
                    ...emptyVary,
                    content,
                    directives: {
                      freshUntilAge: 0.01,
                      maxStale: {
                        withoutRevalidation: 0,
                        whileRevalidate: 0.6,
                        ifError: 0.6,
                      },
                    },
                    validators: { etag: "w/11111" },
                  },
                ]);

                return delay(15).then(async () => {
                  const res = await cache.get({
                    id: uri,
                    params: {},
                    directives: {},
                  });

                  expect(res.usable).to.eq(undefined);
                  expect(res.usableIfError).to.eq(undefined);
                  expect(res.usableWhileRevalidate).to.deep.include({
                    content,
                    validators: { etag: "w/11111" },
                  });
                  expect(res.validatable).to.deep.eq([
                    res.usableWhileRevalidate,
                  ]);
                });
              },
            );
          });
        });

        describe("fresh, usable entries", () => {
          testWithCache(
            "should return content + indicate it's fresh",
            async ({ cache }) => {
              const uris = [randomURI(), randomURI(), randomURI()] as const;
              await cache.store([
                {
                  id: uris[0],
                  ...emptyVary,
                  content: contentGenerator(["0"]),
                  directives: { freshUntilAge: 100 },
                },
                {
                  id: uris[1],
                  ...emptyVary,
                  content: contentGenerator(["1"]),
                  directives: { freshUntilAge: 50 },
                  validators: { etag: "TestTag" },
                },
                {
                  id: uris[2],
                  ...emptyVary,
                  content: contentGenerator(["2"]),
                  directives: {
                    freshUntilAge: 10,
                    maxStale: {
                      withoutRevalidation: 0,
                      whileRevalidate: 200,
                      ifError: 200,
                    },
                  },
                  validators: { etag: "TestTag" },
                },
              ]);

              const results = await Promise.all([
                cache.get({ id: uris[0], params: {}, directives: {} }),
                cache.get({ id: uris[1], params: {}, directives: {} }),
                cache.get({ id: uris[2], params: {}, directives: {} }),
              ]);

              results.forEach((result, i) => {
                expect(result.usable).to.deep.include({
                  content: contentGenerator([String(i)]),
                });
                expect(result.usableIfError).to.eq(undefined);
                expect(result.usableWhileRevalidate).to.eq(undefined);
                expect(result.validatable).to.deep.eq([]);
              });
            },
          );
        });

        describe("vary", () => {
          testWithCache(
            "should not return entries that have unmatching params",
            async ({ cache }) => {
              await cache.store([
                {
                  ...dummyEntryData(),
                  id: "hello",
                  content: contentGenerator(),
                  vary: { john: "smith" },
                },
              ]);

              const result = await cache.get({
                id: "hello",
                params: { john: "taylor" },
                directives: {},
              });
              expect(result.usableIfError).to.eq(undefined);
              expect(result.validatable).to.deep.eq([]);
            },
          );
        });
      });
    },
  );

  describe("PostgresStore-specific behavior", () => {
    it("does not deadlock when concurrent store() calls hit overlapping slots in different orders", async () => {
      // Postgres processes a multi-row INSERT ... ON CONFLICT DO UPDATE's rows
      // in order, locking each conflicting row as it goes. If concurrent
      // store() calls could lock the same rows in DIFFERENT orders, each could
      // grab a row the other is waiting on, and Postgres would abort one with
      // a "deadlock detected" error (40P01) after deadlock_timeout. The store
      // must therefore order its rows deterministically, so concurrent calls
      // acquire locks in one global order and merely wait on each other. This
      // property drives concurrent same-slot batches in forward and reversed
      // input orders; without deterministic ordering it deadlocks reliably.
      const cache = new Cache(postgresStore);

      await fc.assert(
        fc.asyncProperty(
          fc.record({
            runId: fc.uuid(),
            slotCount: fc.integer({ min: 60, max: 120 }),
          }),
          async ({ runId, slotCount }) => {
            const data = Array.from({ length: slotCount }, (_unused, i) => ({
              id: `${runId}:${String(i)}`,
              vary: emptyVary,
              // A non-trivial payload keeps each row's processing from being
              // instantaneous, widening the window in which the concurrent
              // statements actually interleave.
              content: { i, padding: "x".repeat(2048) },
              directives: { freshUntilAge: 60 },
            }));

            // Seed the slots so the concurrent calls below take the
            // row-UPDATE (lock-then-wait) path on every slot.
            await cache.store(data);

            const reversed = data.toReversed();
            const results = await Promise.allSettled([
              cache.store(data),
              cache.store(reversed),
              cache.store(data),
              cache.store(reversed),
            ]);
            // Surface the rejection reasons (e.g. "deadlock detected") in the
            // assertion diff, rather than an opaque `{ status: 'rejected' }`.
            const failures = results.flatMap((r) =>
              r.status === "rejected" ? [String(r.reason)] : [],
            );
            expect(failures).to.deep.eq([]);
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

    it("should only keep the entry with the newest birth date when storing multiple entries with same id and vary", async () => {
      const cache = new Cache(postgresStore);
      const id = randomURI();
      const vary = emptyVary;

      // Create three entries with the same id and vary, but different birth dates
      // Entry 1: oldest (produced 3 seconds ago)
      const oldestContent = { data: "oldest", timestamp: 1 };
      const oldestProducedAt = new Date(Date.now() - 3000);

      // Entry 2: middle (produced 2 seconds ago)
      const middleContent = { data: "middle", timestamp: 2 };
      const middleProducedAt = new Date(Date.now() - 2000);

      // Entry 3: newest (produced 1 second ago)
      const newestContent = { data: "newest", timestamp: 3 };
      const newestProducedAt = new Date(Date.now() - 1000);

      // Store all three entries at once
      await cache.store([
        {
          id,
          vary,
          content: oldestContent,
          directives: { freshUntilAge: 60 },
          date: oldestProducedAt,
        },
        {
          id,
          vary,
          content: middleContent,
          directives: { freshUntilAge: 60 },
          date: middleProducedAt,
        },
        {
          id,
          vary,
          content: newestContent,
          directives: { freshUntilAge: 60 },
          date: newestProducedAt,
        },
      ]);

      // Retrieve the entries
      const result = await cache.get({
        id,
        params: {},
        directives: {},
      });

      // Should only have one entry (the newest one)
      expect(result.usable).to.not.eq(undefined);
      expect(result.usable?.content).to.deep.eq(newestContent);
      expect(result.usable?.date.getTime()).to.be.closeTo(
        newestProducedAt.getTime(),
        100,
      );
    });
  });

  describe("events", () => {
    it("should emit an event for each stored entry", async () => {
      const cache = new Cache(memoryStore);
      const listener = mock.fn();
      const results = [
        {
          id: randomURI(),
          vary: emptyVary,
          content: ["myArray"],
          directives: { freshUntilAge: 0.01 }, // 10ms
        },
        {
          id: randomURI(),
          vary: emptyVary,
          content: ["myArray"],
          directives: { freshUntilAge: 0.01 }, // 10ms
        },
      ];

      cache.emitter.on("store", listener);
      await cache.store(results);
      expect(listener.mock.calls[0]?.arguments[0]).to.deep.contain(results[0]);
      expect(listener.mock.calls[0]?.arguments[1]).to.eq(Infinity);

      expect(listener.mock.calls[1]?.arguments[0]).to.deep.contain(results[1]);
      expect(listener.mock.calls[1]?.arguments[1]).to.eq(Infinity);
    });
  });

  describe("AbortSignal support", () => {
    describe("Cache.get", () => {
      it("should reject immediately with an already-aborted signal", async () => {
        const cache = new Cache(memoryStore);
        const controller = new AbortController();
        controller.abort(new Error("pre-aborted"));

        try {
          await cache.get(
            { id: "test", params: {}, directives: {} },
            { signal: controller.signal },
          );
          throw new Error("should have rejected");
        } catch (e) {
          expect((e as Error).message).to.eq("pre-aborted");
        }
      });

      it("should forward the signal to the store's get method", async () => {
        const signalCapture: (AbortSignal | undefined)[] = [];
        const store = new MemoryStore();
        const origGet = store.get.bind(store);
        store.get = (async (
          id: string,
          params: any,
          options?: { signal?: AbortSignal },
        ) => {
          signalCapture.push(options?.signal);
          return origGet(id, params);
        }) as typeof store.get;

        const cache = new Cache(store);
        const controller = new AbortController();

        try {
          await cache.get(
            { id: "signal-fwd-test", params: {}, directives: {} },
            { signal: controller.signal },
          );

          expect(signalCapture).to.have.lengthOf(1);
          expect(signalCapture[0]).to.eq(controller.signal);
        } finally {
          await cache.close();
        }
      });

      it("should still return results normally when signal is not aborted", async () => {
        const cache = new Cache(memoryStore);
        const id = randomURI();
        await cache.store([
          {
            id,
            vary: emptyVary,
            content: ["signal-normal"],
            directives: { freshUntilAge: 100 },
          },
        ]);

        const controller = new AbortController();
        const result = await cache.get(
          { id, params: {}, directives: {} },
          { signal: controller.signal },
        );
        expect(result.usable).to.deep.include({ content: ["signal-normal"] });
      });
    });

    describe("Cache.getMany", () => {
      it("should reject immediately with an already-aborted signal", async () => {
        const cache = new Cache(memoryStore);
        const controller = new AbortController();
        controller.abort(new Error("pre-aborted-many"));

        try {
          await cache.getMany([{ id: "a", params: {}, directives: {} }], {
            signal: controller.signal,
          });
          throw new Error("should have rejected");
        } catch (e) {
          expect((e as Error).message).to.eq("pre-aborted-many");
        }
      });

      it("should forward the signal to the store's getMany method", async () => {
        const signalCapture: (AbortSignal | undefined)[] = [];
        const store = new MemoryStore();
        const origGetMany = store.getMany.bind(store);
        store.getMany = (async (
          requests: any,
          options?: { signal?: AbortSignal },
        ) => {
          signalCapture.push(options?.signal);
          return origGetMany(requests);
        }) as typeof store.getMany;

        const cache = new Cache(store);
        const controller = new AbortController();

        try {
          await cache.getMany(
            [{ id: "fwd-test-a", params: {}, directives: {} }],
            { signal: controller.signal },
          );

          expect(signalCapture).to.have.lengthOf(1);
          expect(signalCapture[0]).to.eq(controller.signal);
        } finally {
          await cache.close();
        }
      });

      it("should still return results normally when signal is not aborted", async () => {
        const cache = new Cache(memoryStore);
        const ids = [randomURI(), randomURI()];
        await cache.store(
          ids.map((id, i) => ({
            id,
            vary: emptyVary,
            content: [`many-${i}`],
            directives: { freshUntilAge: 100 },
          })),
        );

        const controller = new AbortController();
        const results = await cache.getMany(
          ids.map((id) => ({ id, params: {}, directives: {} })),
          { signal: controller.signal },
        );
        expect(results).to.have.lengthOf(2);
        results.forEach((r, i) => {
          expect(r.usable).to.deep.include({ content: [`many-${i}`] });
        });
      });
    });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
