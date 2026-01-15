import { expect } from "chai";
import { after, before, describe, it, mock } from "node:test";
import { makeTestWithFixture } from "test-with-fixture";

import { setTimeout as delay } from "timers/promises";
import { dummyEntryData, postgresStoreFixture } from "../test/fixtures.js";
import Cache from "./Cache.js";
import MemoryStore from "./stores/MemoryStore/MemoryStore.js";
import type PostgresStore from "./stores/PostgresStore/PostgresStore.js";
import { type JSON } from "./types/utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("Cache", { concurrency: true }, () => {
  let memoryStore: MemoryStore<JSON, any, any>,
    postgresStore: PostgresStore<any, any, any>,
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

    await Promise.all([memoryStore.close(), postgresCleanup()]);
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
});
/* eslint-enable @typescript-eslint/no-explicit-any */
