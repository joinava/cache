/* eslint-disable max-lines */
import { describe, it, mock } from "node:test";

import { omit } from "es-toolkit";
import fc from "fast-check";
import assert from "node:assert/strict";
import { setTimeout as delay } from "timers/promises";
import {
  UnusableEntryArb,
  UsableEntryArb,
  UsableIfErrorEntryArb,
  UsableWhileRevalidateEntryArb,
} from "../../test/fixtures.js";
import Cache from "../Cache.js";
import {
  MemoryStore,
  soleResourceType,
  wrapProducer,
  type ProducerDirectives,
} from "../index.js";
import type { NormalizedProducerResult } from "../types/06_Normalization.js";
import { completeRequest } from "./requestPairedProducerUtils.js";
import { type mapTuple } from "./utils.js";
import { wrapBulkProducer } from "./wrapBulkProducer.js";

describe("wrapBulkProducer", () => {
  const cacheOptions = {
    name: "wrap-bulk-producer-test",
    resourceTypes: { main: soleResourceType<unknown>() },
  };

  describe("one request given", () => {
    describe("the requested id is usable in the cache", () => {
      it("should return the result from the cache, mimicking wrapProducer", async () => {
        await fc.assert(
          fc.asyncProperty(UsableEntryArb, async ({ entry, consumerDirs }) => {
            const store = new MemoryStore();
            const cache = new Cache(store, cacheOptions);
            try {
              await store.store([{ entry, maxStoreForSeconds: 100 }]);

              const producer = mock.fn(function (_: unknown) {
                throw new Error("not called");
              });
              const wrappedProducer = wrapProducer(
                cache,
                { collapseOverlappingRequestsTime: 0 },
                { main: producer },
              );
              const wrappedBulkProducer = wrapBulkProducer(
                cache,
                { collapseOverlappingRequestsTime: 0 },
                { main: producer },
              );

              const request = { id: entry.id, directives: consumerDirs };
              const [result, bulkResult] = await Promise.all([
                wrappedProducer(request),
                wrappedBulkProducer([request]),
              ]);

              assert.deepEqual(result, bulkResult[0]);
              assert.equal(result.content, entry.content);
              assert.equal(producer.mock.callCount(), 0);
            } finally {
              await cache.close();
            }
          }),
        );
      });
    });

    describe("the requested id is usable while revalidating in the cache", () => {
      it("should return the cached result immediately and trigger background refresh", async () => {
        const producerBase = async function (req: { id: string }) {
          return {
            content: `refreshed-${req.id}-${Date.now()}`,
            directives: { freshUntilAge: 1 },
          };
        };
        const bulkProducerBase = bulkProducerFromProducer(producerBase);

        await fc.assert(
          fc.asyncProperty(
            UsableWhileRevalidateEntryArb,
            async ({ entry, consumerDirs }) => {
              const store = new MemoryStore();
              const storeMock = mock.method(store, "store");

              const cache = new Cache(store, cacheOptions);
              try {
                await store.store([{ entry, maxStoreForSeconds: 100 }]);
                storeMock.mock.resetCalls();

                const singleProducer = mock.fn(producerBase);
                const bulkProducer = mock.fn(bulkProducerBase);

                const wrappedProducer = wrapProducer(cache, {}, {
                  main: singleProducer,
                });
                const wrappedBulkProducer = wrapBulkProducer(cache, {}, {
                  main: bulkProducer,
                });

                const request = { id: entry.id, directives: consumerDirs };
                const [result, bulkResult] = await Promise.all([
                  wrappedProducer(request),
                  wrappedBulkProducer([request]),
                ]);

                assertResultsApproximatelyEqual(result, bulkResult[0]);
                assert.equal(result.content, entry.content);
                assert.equal(singleProducer.mock.callCount(), 1);
                assert.equal(bulkProducer.mock.callCount(), 1);

                await delay(10);
                assert.equal(storeMock.mock.callCount(), 2);
              } finally {
                await cache.close();
              }
            },
          ),
        );
      });
    });

    describe("the requested id is usable if error", () => {
      it("should return the cached result when the producer errors", async () => {
        const producerBase = async function (_req: { id: string }) {
          throw new Error("test");
        };

        await fc.assert(
          fc.asyncProperty(
            UsableIfErrorEntryArb,
            async ({ entry, consumerDirs }) => {
              const store = new MemoryStore();
              const storeMock = mock.method(store, "store");

              const cache = new Cache(store, cacheOptions);
              try {
                await store.store([{ entry, maxStoreForSeconds: 100 }]);
                storeMock.mock.resetCalls();

                const singleProducer = mock.fn(producerBase);
                const bulkProducer = mock.fn(
                  async (reqs: readonly { id: string }[]) => {
                    return Promise.all(
                      reqs.map(async (it) => producerBase(it).catch((e) => e)),
                    );
                  },
                );

                const wrappedProducer = wrapProducer(cache, {}, {
                  main: singleProducer,
                });
                const wrappedBulkProducer = wrapBulkProducer(cache, {}, {
                  main: bulkProducer,
                });

                const request = { id: entry.id, directives: consumerDirs };
                const [result, bulkResult] = await Promise.all([
                  wrappedProducer(request),
                  wrappedBulkProducer([request]),
                ]);

                assertResultsApproximatelyEqual(result, bulkResult[0]);
                assert.equal(result.content, entry.content);
                assert.equal(singleProducer.mock.callCount(), 1);
                assert.equal(bulkProducer.mock.callCount(), 1);

                await delay(10);
                assert.equal(storeMock.mock.callCount(), 0);
              } finally {
                await cache.close();
              }
            },
          ),
        );
      });
    });

    describe("the requested id is unusable or there's no entry in the cache", () => {
      it("should return the result from the producer", async () => {
        const producerBase = async function (_req: { id: string }) {
          return { content: "test44", directives: { freshUntilAge: 1 } };
        };
        const bulkProducerBase = bulkProducerFromProducer(producerBase);

        await fc.assert(
          fc.asyncProperty(
            UnusableEntryArb,
            fc.boolean(),
            async ({ entry, consumerDirs }, shouldStoreEntry) => {
              const store = new MemoryStore();
              const cache = new Cache(store, cacheOptions);
              try {
                if (shouldStoreEntry) {
                  await store.store([{ entry, maxStoreForSeconds: 100 }]);
                }

                const singleProducer = mock.fn(producerBase);
                const bulkProducer = mock.fn(bulkProducerBase);

                const wrappedProducer = wrapProducer(cache, {}, {
                  main: singleProducer,
                });
                const wrappedBulkProducer = wrapBulkProducer(cache, {}, {
                  main: bulkProducer,
                });

                const request = { id: entry.id, directives: consumerDirs };
                const [result, bulkResult] = await Promise.all([
                  wrappedProducer(request),
                  wrappedBulkProducer([request]),
                ]);

                assertResultsApproximatelyEqual(result, bulkResult[0]);
                assert.equal(result.content, "test44");
                assert.equal(singleProducer.mock.callCount(), 1);
                assert.equal(bulkProducer.mock.callCount(), 1);
              } finally {
                await cache.close();
              }
            },
          ),
        );
      });
    });
  });

  describe("multiple requests given", () => {
    it("should handle mixed cache states correctly (usable, revalidate, error, unusable)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .record({
              Usable: fc.array(UsableEntryArb, { minLength: 0, maxLength: 5 }),
              UsableWhileRevalidate: fc.array(UsableWhileRevalidateEntryArb, {
                minLength: 0,
                maxLength: 5,
              }),
              UsableIfError: fc.array(UsableIfErrorEntryArb, {
                minLength: 0,
                maxLength: 5,
              }),
              // Exclude bypass (maxAge: 0) directives: in 2.0 those skip the
              // cache read and form their own producer invocation, which is
              // deliberate behavior tested separately -- this test is about
              // mixed *cache* states.
              Unusable: fc.array(
                UnusableEntryArb.filter(
                  ({ consumerDirs }) => consumerDirs.maxAge !== 0,
                ),
                {
                  minLength: 0,
                  maxLength: 5,
                },
              ),
              Unstored: fc.array(UsableEntryArb, {
                minLength: 0,
                maxLength: 5,
              }),
            })
            .filter(
              ({
                Usable,
                UsableWhileRevalidate,
                UsableIfError,
                Unusable,
                Unstored,
              }) => {
                const entryIds = new Set(
                  [
                    ...Usable,
                    ...UsableWhileRevalidate,
                    ...UsableIfError,
                    ...Unusable,
                    ...Unstored,
                  ].map(({ entry }) => entry.id),
                );
                return (
                  entryIds.size ===
                  Unstored.length +
                    Usable.length +
                    UsableIfError.length +
                    Unusable.length +
                    UsableWhileRevalidate.length
                );
              },
            ),
          async ({
            Usable,
            UsableWhileRevalidate,
            UsableIfError,
            Unusable,
            Unstored,
          }) => {
            const store = new MemoryStore();
            const cache = new Cache(store, cacheOptions);
            try {
              const unstoredIds = Unstored.map(({ entry }) => entry.id);

              const storableGeneratedData = [
                ...Usable,
                ...UsableWhileRevalidate,
                ...UsableIfError,
                ...Unusable,
              ];

              await store.store(
                storableGeneratedData.map(({ entry }) => ({
                  entry,
                  maxStoreForSeconds: 10,
                })),
              );

              function shouldError(id: string) {
                return id.includes("9");
              }

              const storeMock = mock.method(store, "store");

              const bulkProducer = mock.fn(
                bulkProducerFromProducer(async function (_req: { id: string }) {
                  if (shouldError(_req.id)) {
                    throw new Error("test");
                  }

                  if (unstoredIds.includes(_req.id)) {
                    return {
                      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                      content: Unstored.find(
                        ({ entry }) => entry.id === _req.id,
                      )!.entry.content,
                      directives: { freshUntilAge: 1 },
                    };
                  }

                  return {
                    content: `refreshed-${_req.id}`,
                    directives: { freshUntilAge: 1 },
                  };
                }),
              );

              const wrappedBulkProducer = wrapBulkProducer(cache, {}, {
                main: bulkProducer,
              });

              const results = await wrappedBulkProducer(
                storableGeneratedData
                  .concat(Unstored)
                  .map(({ entry, consumerDirs }) => ({
                    id: entry.id,
                    directives: consumerDirs,
                  })),
              );

              const error = new Error("test");
              const expectedResultContentsOrErrors = [
                // We won't call the producer for this, so doesn't matter if it would error.
                ...Usable.map(({ entry }) => entry.content),
                // Same, but we won't call the producer _synchronously_.
                ...UsableWhileRevalidate.map(({ entry }) => entry.content),
                // We will call the producer, so we should get refreshed values unless it errors.
                ...UsableIfError.map(({ entry }) =>
                  shouldError(entry.id)
                    ? entry.content
                    : `refreshed-${entry.id}`,
                ),
                ...Unusable.map(({ entry }) =>
                  shouldError(entry.id) ? error : `refreshed-${entry.id}`,
                ),
                ...Unstored.map(({ entry }) =>
                  shouldError(entry.id) ? error : entry.content,
                ),
              ];

              assert.equal(
                results.length,
                expectedResultContentsOrErrors.length,
              );
              for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (result instanceof Error) {
                  assert.deepEqual(
                    results[i],
                    expectedResultContentsOrErrors[i],
                  );
                } else {
                  assert.deepEqual(
                    result?.content,
                    expectedResultContentsOrErrors[i],
                  );
                }
              }

              const producerWontError = (it: { entry: { id: string } }) =>
                !shouldError(it.entry.id);

              const expectedStoreCalls =
                ([...Unstored, ...Unusable, ...UsableIfError].filter(
                  producerWontError,
                ).length > 0
                  ? 1
                  : 0) +
                (UsableWhileRevalidate.filter(producerWontError).length > 0
                  ? 1
                  : 0);

              await delay(10);
              assert.equal(storeMock.mock.callCount(), expectedStoreCalls);
            } finally {
              await cache.close();
            }
          },
        ),
      );
    });

    it("should skip the cache read for bypass (maxAge: 0) requests and call the producer directly", async () => {
      const store = new MemoryStore();
      const cache = new Cache(store, cacheOptions);
      try {
        const plainRequests = [{ id: "plain-a" }, { id: "plain-b" }];
        const bypassRequests = [
          { id: "bypass-a", directives: { maxAge: 0 } },
          { id: "bypass-b", directives: { maxAge: 0 } },
        ];
        const requests = [...plainRequests, ...bypassRequests];

        const bulkProducer = mock.fn(
          async (reqs: readonly { id: string }[]) =>
            reqs.map((req) => ({
              content: `content-${req.id}`,
              directives: { freshUntilAge: 10 },
            })),
        );

        const wrappedBulkProducer = wrapBulkProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          { main: bulkProducer },
        );

        // First call: the bypass requests go straight to the producer (as
        // their own batch, kicked off before the cache read), and the plain
        // requests miss, producing a second batch.
        await wrappedBulkProducer(requests);
        assert.equal(bulkProducer.mock.callCount(), 2);
        assert.deepEqual(
          bulkProducer.mock.calls[0]?.arguments[0],
          bypassRequests.map(completeRequest),
          "first producer call should be the bypass batch",
        );
        assert.deepEqual(
          bulkProducer.mock.calls[1]?.arguments[0],
          plainRequests.map(completeRequest),
          "second producer call should be the plain misses",
        );

        // Second call: the plain requests now hit the cache, while the
        // bypass requests still reach the producer (guaranteed contact).
        bulkProducer.mock.resetCalls();
        const results = await wrappedBulkProducer(requests);

        assert.equal(bulkProducer.mock.callCount(), 1);
        assert.deepEqual(
          bulkProducer.mock.calls[0]?.arguments[0],
          bypassRequests.map(completeRequest),
        );

        // ...and every element still resolved, in order.
        const entries = results as Exclude<(typeof results)[number], Error>[];
        assert.deepEqual(
          entries.map((it) => it.content),
          requests.map((it) => `content-${it.id}`),
        );
      } finally {
        await cache.close();
      }
    });

    it("should maintain result order matching input request order", async () => {
      const returnErrorForRequest = (id: string) => id.includes("9");

      // Test that results are returned in the same order as requests, regardless of cache state
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc
                .string({ minLength: 1, maxLength: 5 })
                .filter((it) => !returnErrorForRequest(it)),
            }),
            { minLength: 0, maxLength: 3 },
          ),
          fc.array(
            fc.record({
              id: fc.string({ minLength: 6, maxLength: 10 }),
            }),
            { minLength: 0, maxLength: 3 },
          ),
          async (cachedRequests, uncachedRequests) => {
            // Create fresh cache and pre-populate with some entries
            const store = new MemoryStore();
            const cache = new Cache(store, cacheOptions);

            const genericError = new Error("test");

            const requests = [...cachedRequests, ...uncachedRequests].toSorted(
              (a, b) => a.id.localeCompare(b.id),
            );

            try {
              // Pre-populate cache with cached requests to create mixed cache states
              await cache.store(
                cachedRequests.map((req) => ({
                  id: req.id,
                  content: `cached-${req.id}`,
                  directives: { freshUntilAge: 100 },
                })),
              );

              // Create a bulk producer that maintains order
              const bulkProducer = mock.fn(
                async (reqs: readonly { id: string }[]) => {
                  return Promise.all(
                    reqs.map(async (req) => {
                      return returnErrorForRequest(req.id)
                        ? genericError
                        : {
                            content: `fresh-${req.id}`,
                            directives: { freshUntilAge: 1 },
                          };
                    }),
                  );
                },
              );

              // Create wrapped bulk producer
              const wrappedBulk = wrapBulkProducer(
                cache,
                { collapseOverlappingRequestsTime: 0 },
                { main: bulkProducer },
              );

              // Call wrapBulkProducer with the requests
              const bulkResults = await wrappedBulk(requests);

              // Verify results are in the correct order
              assert.equal(bulkResults.length, requests.length);
              assert.deepEqual(
                bulkResults.map((it) => (it instanceof Error ? it : it.id)),
                requests.map((it) =>
                  returnErrorForRequest(it.id) ? genericError : it.id,
                ),
              );
            } finally {
              await cache.close();
            }
          },
        ),
      );
    });

    describe("onCacheReadFailure option", () => {
      it("should throw when cache read fails and onCacheReadFailure is 'throw'", async () => {
        const store = new MemoryStore();
        const cache = new Cache(store, cacheOptions);

        // Mock cache.getMany to simulate a cache read failure
        const originalGetMany = cache.getMany.bind(cache);
        cache.getMany = async () => {
          throw new Error("Cache read error");
        };

        try {
          const producer = mock.fn(async (req: { id: string }) => ({
            content: `content-${req.id}`,
            directives: { freshUntilAge: 1 },
          }));

          const bulkProducer = mock.fn(bulkProducerFromProducer(producer));

          const wrappedBulkProducer = wrapBulkProducer(
            cache,
            { onCacheReadFailure: "throw" },
            { main: bulkProducer },
          );

          await assert.rejects(
            async () => wrappedBulkProducer([{ id: "test1" }, { id: "test2" }]),
            /Cache read error/,
          );

          // Producer should not have been called
          assert.equal(bulkProducer.mock.callCount(), 0);
        } finally {
          cache.getMany = originalGetMany;
          await cache.close();
        }
      });

      it("should fall back to producer when cache read fails and onCacheReadFailure is 'call-producer'", async () => {
        const store = new MemoryStore();
        const cache = new Cache(store, cacheOptions);

        // Mock cache.getMany to simulate a cache read failure
        const originalGetMany = cache.getMany.bind(cache);
        cache.getMany = async () => {
          throw new Error("Cache read error");
        };

        try {
          const producer = mock.fn(async (req: { id: string }) => ({
            content: `content-${req.id}`,
            directives: { freshUntilAge: 1 },
          }));

          const bulkProducer = mock.fn(bulkProducerFromProducer(producer));

          const wrappedBulkProducer = wrapBulkProducer(
            cache,
            { onCacheReadFailure: "call-producer" },
            { main: bulkProducer },
          );

          const _results = await wrappedBulkProducer([
            { id: "test1" },
            { id: "test2" },
          ]);

          const results = _results as Exclude<
            (typeof _results)[number],
            Error
          >[];

          assert.equal(results.length, 2);
          assert.equal(results[0]?.content, "content-test1");
          assert.equal(results[1]?.content, "content-test2");

          // Producer should have been called
          assert.equal(bulkProducer.mock.callCount(), 1);
        } finally {
          cache.getMany = originalGetMany;
          await cache.close();
        }
      });
    });

    describe("collapseOverlappingRequestsTime option", () => {
      it("should collapse identical overlapping requests within time window", async () => {
        const store = new MemoryStore();
        const cache = new Cache(store, cacheOptions);

        try {
          let callCount = 0;
          const producer = mock.fn(async (req: { id: string }) => {
            callCount++;
            await delay(50); // Simulate some processing time
            return {
              content: `content-${req.id}-${callCount}`,
              directives: { freshUntilAge: 0 }, // Force cache miss
            };
          });

          const bulkProducer = mock.fn(bulkProducerFromProducer(producer));

          const wrappedBulkProducer = wrapBulkProducer(
            cache,
            { collapseOverlappingRequestsTime: 1 }, // 1 second window
            { main: bulkProducer },
          );

          // Make multiple overlapping requests for the same resources
          const resultSets = await Promise.all([
            wrappedBulkProducer([{ id: "a" }, { id: "b" }]),
            wrappedBulkProducer([{ id: "a" }, { id: "b" }]),
            wrappedBulkProducer([{ id: "a" }, { id: "b" }]),
          ]);

          const [results1, results2, results3] = resultSets as ReturnType<
            typeof mapTuple<
              typeof resultSets,
              Exclude<(typeof resultSets)[number][number], Error>[]
            >
          >;

          // All results should be identical (from the same producer call)
          assert.deepEqual(results1[0]?.content, results2[0]?.content);
          assert.deepEqual(results1[0]?.content, results3[0]?.content);
          assert.deepEqual(results1[1]?.content, results2[1]?.content);
          assert.deepEqual(results1[1]?.content, results3[1]?.content);

          // Producer should only have been called once due to collapsing
          assert.equal(bulkProducer.mock.callCount(), 1);
        } finally {
          await cache.close();
        }
      });

      it("should not collapse requests outside the time window", async () => {
        const store = new MemoryStore();
        const cache = new Cache(store, cacheOptions);

        try {
          let callCount = 0;
          const producer = mock.fn(async (req: { id: string }) => {
            callCount++;
            return {
              content: `content-${req.id}-${callCount}`,
              directives: { freshUntilAge: 0 }, // Force cache miss
            };
          });

          const bulkProducer = mock.fn(bulkProducerFromProducer(producer));

          const wrappedBulkProducer = wrapBulkProducer(
            cache,
            { collapseOverlappingRequestsTime: 0.05 }, // 50ms window
            { main: bulkProducer },
          );

          // Make requests with delay between them
          const results1 = await wrappedBulkProducer([{ id: "a" }]);
          await delay(100); // Wait longer than collapse window
          const results2 = await wrappedBulkProducer([{ id: "a" }]);

          // Results should be different (from different producer calls)
          assert.notEqual(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (results1[0] as any)?.content,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (results2[0] as any)?.content,
          );

          // Producer should have been called twice
          assert.equal(bulkProducer.mock.callCount(), 2);
        } finally {
          await cache.close();
        }
      });
    });

    describe("supplemental resources", () => {
      it("should cache supplemental resources returned by the bulk producer", async () => {
        const store = new MemoryStore();
        const cache = new Cache(store, cacheOptions);

        try {
          const bulkProducer = mock.fn(
            async (reqs: readonly { id: string }[]) => {
              return reqs.map((req) => ({
                content: `main-${req.id}`,
                directives: { freshUntilAge: 1 },
                supplementalResources: [
                  {
                    id: `supp-${req.id}`,
                    vary: {},
                    content: `supplemental-${req.id}`,
                    directives: { freshUntilAge: 1 },
                  },
                ],
              }));
            },
          );

          const wrappedBulkProducer = wrapBulkProducer(cache, {}, {
            main: bulkProducer,
          });

          // Request main resources
          const results = await wrappedBulkProducer([
            { id: "res1" },
            { id: "res2" },
          ]);

          // We know the producer never throws, hence this cast.
          const [result0, result1] = results as Exclude<
            (typeof results)[number],
            Error
          >[];

          assert.equal(result0?.content, "main-res1");
          assert.equal(result1?.content, "main-res2");

          // Now request the supplemental resources - they should be cached
          const suppResults = await wrappedBulkProducer([
            { id: "supp-res1" },
            { id: "supp-res2" },
          ]);

          // We know the producer never throws, hence this cast.
          const [suppResult0, suppResult1] = suppResults as Exclude<
            (typeof suppResults)[number],
            Error
          >[];

          assert.equal(suppResult0?.content, "supplemental-res1");
          assert.equal(suppResult1?.content, "supplemental-res2");

          // Producer should only have been called once (for main resources)
          assert.equal(bulkProducer.mock.callCount(), 1);
        } finally {
          await cache.close();
        }
      });
    });
  });

  describe("AbortSignal support", () => {
    it("should reject immediately with an already-aborted signal", async () => {
      const store = new MemoryStore();
      const cache = new Cache(store, cacheOptions);

      try {
        const producer = mock.fn(
          async (reqs: readonly { id: string }[]) =>
            reqs.map((req) => ({
              content: `c-${req.id}`,
              directives: { freshUntilAge: 1 },
            })),
        );

        const wrappedBulk = wrapBulkProducer(cache, {}, { main: producer });

        const controller = new AbortController();
        controller.abort(new Error("pre-aborted"));

        await assert.rejects(
          async () =>
            wrappedBulk(
              [{ id: "a" }, { id: "b" }],
              { signal: controller.signal },
            ),
          { message: "pre-aborted" },
        );

        assert.equal(producer.mock.callCount(), 0);
      } finally {
        await cache.close();
      }
    });

    it("should reject if signal fires before the cache read completes (i.e., before producer is called)", async () => {
      const store = new MemoryStore();
      const cache = new Cache(store, cacheOptions);

      let cacheGetManyResolve: (v: unknown) => void;
      const originalGetMany = cache.getMany.bind(cache);
      cache.getMany = (() =>
        new Promise((resolve) => {
          cacheGetManyResolve = resolve as (v: unknown) => void;
        })) as typeof cache.getMany;

      try {
        const controller = new AbortController();
        const producer = mock.fn(
          async (reqs: readonly { id: string }[]) =>
            reqs.map((r) => ({
              content: `c-${r.id}`,
              directives: { freshUntilAge: 1 },
            })),
        );

        const wrappedBulk = wrapBulkProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          { main: producer },
        );

        const resultPromise = wrappedBulk(
          [{ id: "abort-during-read" }],
          { signal: controller.signal },
        );

        await delay(5);
        controller.abort(new Error("cancelled-during-read"));

        // Resolve the cache read after the abort — the abort checkpoint
        // should fire.
        cacheGetManyResolve!([{ validatable: [] }]);

        await assert.rejects(
          async () => resultPromise,
          { message: "cancelled-during-read" },
        );

        assert.equal(producer.mock.callCount(), 0);
      } finally {
        cache.getMany = originalGetMany;
        await cache.close();
      }
    });

    it("should reject when signal is aborted mid-producer, but still store the producer's result", async () => {
      const store = new MemoryStore();
      const cache = new Cache(store, cacheOptions);

      try {
        const controller = new AbortController();
        const slowProducer = mock.fn(
          async (reqs: readonly { id: string }[]) =>
            new Promise<{ content: string; directives: { freshUntilAge: number } }[]>(
              (resolve) => {
                setTimeout(
                  () =>
                    resolve(
                      reqs.map((r) => ({
                        content: `slow-${r.id}`,
                        directives: { freshUntilAge: 10 },
                      })),
                    ),
                  100,
                );
              },
            ),
        );

        const wrappedBulk = wrapBulkProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          { main: slowProducer },
        );

        const resultPromise = wrappedBulk(
          [{ id: "mid-abort" }],
          { signal: controller.signal },
        );

        await delay(10);
        controller.abort(new Error("cancelled-mid-producer"));

        await assert.rejects(
          async () => resultPromise,
          { message: "cancelled-mid-producer" },
        );

        // Wait for the producer to finish and store its result.
        await delay(150);

        // Verify the result was still stored.
        const results = await wrappedBulk([{ id: "mid-abort" }]);
        const entries = results as Exclude<(typeof results)[number], Error>[];
        assert.equal(entries[0]?.content, "slow-mid-abort");
        assert.equal(slowProducer.mock.callCount(), 1);
      } finally {
        await cache.close();
      }
    });

    it("should still return cache hits even when signal is provided", async () => {
      const store = new MemoryStore();
      const cache = new Cache(store, cacheOptions);

      try {
        const producer = mock.fn(
          async (reqs: readonly { id: string }[]) =>
            reqs.map((r) => ({
              content: `fresh-${r.id}`,
              directives: { freshUntilAge: 10 },
            })),
        );

        const wrappedBulk = wrapBulkProducer(
          cache,
          { collapseOverlappingRequestsTime: 0 },
          { main: producer },
        );

        // Populate cache
        await wrappedBulk([{ id: "hit-a" }, { id: "hit-b" }]);
        assert.equal(producer.mock.callCount(), 1);

        // Second call with signal should still get cache hits
        const controller = new AbortController();
        const results = await wrappedBulk(
          [{ id: "hit-a" }, { id: "hit-b" }],
          { signal: controller.signal },
        );

        const entries = results as Exclude<(typeof results)[number], Error>[];
        assert.equal(entries[0]?.content, "fresh-hit-a");
        assert.equal(entries[1]?.content, "fresh-hit-b");
        assert.equal(producer.mock.callCount(), 1);
      } finally {
        await cache.close();
      }
    });

    it("should not treat abort errors as cache read failures eligible for fallback", async () => {
      const store = new MemoryStore();
      const cache = new Cache(store, cacheOptions);

      // Make cache.getMany throw an abort error
      const originalGetMany = cache.getMany.bind(cache);
      cache.getMany = (async (
        _reqs: Parameters<typeof originalGetMany>[0],
        options?: { signal?: AbortSignal },
      ) => {
        options?.signal?.throwIfAborted();
        return originalGetMany(_reqs);
      }) as typeof cache.getMany;

      try {
        const producer = mock.fn(
          async (reqs: readonly { id: string }[]) =>
            reqs.map((r) => ({
              content: `c-${r.id}`,
              directives: { freshUntilAge: 1 },
            })),
        );

        const wrappedBulk = wrapBulkProducer(
          cache,
          { onCacheReadFailure: "call-producer" },
          { main: producer },
        );

        const controller = new AbortController();
        controller.abort(new Error("aborted-during-getmany"));

        await assert.rejects(
          async () =>
            wrappedBulk(
              [{ id: "test" }],
              { signal: controller.signal },
            ),
          { message: "aborted-during-getmany" },
        );

        // Should NOT have fallen back to the producer
        assert.equal(producer.mock.callCount(), 0);
      } finally {
        cache.getMany = originalGetMany;
        await cache.close();
      }
    });
  });

  function bulkProducerFromProducer<C>(
    producer: (req: {
      id: string;
    }) => Promise<{ content: C; directives: ProducerDirectives }>,
  ) {
    // TODO: make it possible for the bulk producer to reject, even though that
    // shouldn't happen.
    return async (reqs: readonly { id: string }[]) => {
      return Promise.all(
        reqs.map(async (it) => producer(it).catch((e) => e as Error)),
      );
    };
  }

  function assertResultsApproximatelyEqual(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actual: NormalizedProducerResult<any, any, any> | Error | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expected: NormalizedProducerResult<any, any, any> | Error | undefined,
  ) {
    if (
      actual === undefined ||
      expected === undefined ||
      actual instanceof Error ||
      expected instanceof Error
    ) {
      return assert.deepEqual(actual, expected);
    }

    if (actual.date === expected.date) {
      return assert.deepEqual(actual, expected);
    } else if (Math.abs(actual.date.getTime() - expected.date.getTime()) < 10) {
      return assert.deepEqual(omit(actual, ["date"]), omit(expected, ["date"]));
    }

    throw new Error(
      `Data mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual,
      )}`,
    );
  }
});
