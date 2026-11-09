import { throwIfAnyError } from "./utils/utils.js";
import { expect } from "chai";
import { after, before, describe, it } from "node:test";
import { makeTestWithFixture } from "test-with-fixture";

import { setTimeout as delay } from "timers/promises";
import { dummyEntryData, postgresStoreFixture } from "../test/fixtures.js";
import Cache from "./Cache.js";
import { resourceType } from "./index.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import type PostgresStore from "./stores/PostgresStore/PostgresStore.js";
import type { CacheSpec } from "./types/00_CacheSpec.js";
import { type JSON } from "./types/utils.js";

// These suites exercise id-structure-agnostic Cache behavior, so they use a
// sole-type registry (2.0 requires every cache to name itself and declare its
// resource types). Classification-specific behavior is covered in
// resourceTypeClassification.test.ts; store-entry channel payloads in
// diagnosticsChannels.test.ts.
const cacheOptions = {
  name: "cache-test",
  resourceTypes: {
    entries: resourceType<JSON>()({
      matches: (id: string): id is string => typeof id === "string",
    }),
  },
};

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

  /**
   * Every cache in this suite is the same cache over a different store, so the
   * store is the only thing worth reading at a construction site. The registry
   * is concrete here, so this needs no cast.
   */
  const cacheOver = (store: typeof memoryStore | typeof postgresStore) =>
    new Cache({ store, ...cacheOptions });

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
          return {
            cache: cacheOver(store),
          };
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
                // Backdated entry: freshness (29s) is already expired while
                // the staleWhileRefresh window (1h) stays open — no sleep,
                // no wall-clock race. The previous live 10ms/1s windows
                // required the read to land within 1.01s of storing, which
                // full-suite load stalls (>1.1s observed) missed.
                await cache.store([
                  {
                    id: uri,
                    vary: { accept: "text/html" },
                    content,
                    date: new Date(Date.now() - 30_000),
                    directives: {
                      freshUntilAge: 29,
                      maxStale: {
                        withoutRevalidation: 0,
                        whileRevalidate: 3600,
                        ifError: 3600,
                      },
                    },
                  },
                ]);

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
                // Backdated entry: freshness (29s) is already expired at
                // store time while the staleWhileRefresh window (1h) stays
                // open, so no sleep is needed and no wall-clock race exists.
                // The previous live 10ms/600ms windows raced real-store
                // round trips under full-suite load (observed elapsed >
                // 600ms → usableWhileRevalidate undefined → flake).
                await cache.store([
                  {
                    id: uri,
                    ...emptyVary,
                    content,
                    date: new Date(Date.now() - 30_000),
                    directives: {
                      freshUntilAge: 29,
                      maxStale: {
                        withoutRevalidation: 0,
                        whileRevalidate: 3600,
                        ifError: 3600,
                      },
                    },
                    validators: { etag: "w/11111" },
                  },
                ]);

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
                expect(res.validatable).to.deep.eq([res.usableWhileRevalidate]);
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

  // The @zingage/cache:store-entry channel's conformance suite (payload
  // shape and per-resource-type attribution) lives in diagnosticsChannels.test.ts.

  describe("AbortSignal support", () => {
    describe("Cache.get", () => {
      it("should reject immediately with an already-aborted signal", async () => {
        const cache = cacheOver(memoryStore);
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
        const store = new MemoryStore<CacheSpec<string, JSON>>();
        const origGet = store.get.bind(store);
        store.get = (async (
          request: Parameters<typeof origGet>[0],
          options?: { signal?: AbortSignal },
        ) => {
          signalCapture.push(options?.signal);
          return origGet(request, options);
        }) as typeof store.get;

        const cache = cacheOver(store);
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
        const cache = cacheOver(memoryStore);
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
        const cache = cacheOver(memoryStore);
        const controller = new AbortController();
        controller.abort(new Error("pre-aborted-many"));

        try {
          await cache
            .getMany([{ id: "a", params: {}, directives: {} }], {
              signal: controller.signal,
            })
            .then(throwIfAnyError);
          throw new Error("should have rejected");
        } catch (e) {
          expect((e as Error).message).to.eq("pre-aborted-many");
        }
      });

      it("should forward the signal to single reads in a known set", async () => {
        const signalCapture: (AbortSignal | undefined)[] = [];
        const store = new MemoryStore<CacheSpec<string, JSON>>();
        const origGetMany = store.get.bind(store);
        store.get = (async (
          requests: any,
          options?: { signal?: AbortSignal },
        ) => {
          signalCapture.push(options?.signal);
          return origGetMany(requests);
        }) as typeof store.get;

        const cache = cacheOver(store);
        const controller = new AbortController();

        try {
          await cache
            .getMany([{ id: "fwd-test-a", params: {}, directives: {} }], {
              signal: controller.signal,
            })
            .then(throwIfAnyError);

          expect(signalCapture).to.have.lengthOf(1);
          expect(signalCapture[0]).to.eq(controller.signal);
        } finally {
          await cache.close();
        }
      });

      it("should still return results normally when signal is not aborted", async () => {
        const cache = cacheOver(memoryStore);
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
        const results = await cache
          .getMany(
            ids.map((id) => ({ id, params: {}, directives: {} })),
            { signal: controller.signal },
          )
          .then(throwIfAnyError);
        expect(results).to.have.lengthOf(2);
        results.forEach((r, i) => {
          expect(r.usable).to.deep.include({ content: [`many-${i}`] });
        });
      });
    });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
