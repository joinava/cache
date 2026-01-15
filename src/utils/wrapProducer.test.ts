import { expect } from "chai";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { setTimeout as delay } from "timers/promises";
import Cache from "../Cache.js";
import { MemoryStore } from "../index.js";
import type {
  AnyParams,
  AnyValidators,
  RequestPairedProducerResult,
} from "../types/index.js";
import wrapProducer from "./wrapProducer.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("wrapProducer", () => {
  let fetcher: ReturnType<
      typeof mock.fn<
        (it: {
          id: string;
        }) => Promise<RequestPairedProducerResult<any, any, any>>
      >
    >,
    cache: Cache<any>,
    sut: ReturnType<typeof wrapProducer>;

  beforeEach(() => {
    cache = new Cache(new MemoryStore());
    fetcher = mock.fn(
      async (_req) =>
        ({
          content: new Date().toISOString(),
          directives: {
            freshUntilAge: 0.1,
            maxStale: {
              withoutRevalidation: 0,
              whileRevalidate: 0.4,
              ifError: 0.4,
            },
          },
          supplementalResources: [
            {
              id: "s",
              vary: { dummy: true },
              content: "supplemental",
              directives: { freshUntilAge: 1 },
            },
          ],
        }) satisfies RequestPairedProducerResult<any, any, any>,
    );

    sut = wrapProducer(cache, { collapseOverlappingRequestsTime: 0 }, fetcher);
  });

  afterEach(async () => {
    return cache.close();
  });

  it("should call the fetcher at first", async () => {
    await sut({ id: "myUrl" });
    expect(fetcher.mock.callCount()).to.eq(1);
    expect(fetcher.mock.calls[0]?.arguments).to.deep.eq([
      { id: "myUrl", params: {}, directives: {} },
    ]);
  });

  it("should add supplemental resources to the cache", async () => {
    await sut({ id: "myUrl" });
    expect(fetcher.mock.callCount()).to.eq(1);
    expect(fetcher.mock.calls[0]?.arguments).to.deep.eq([
      { id: "myUrl", params: {}, directives: {} },
    ]);

    const res = await sut({ id: "s", params: { dummy: true } });
    expect(fetcher.mock.callCount()).to.eq(1);
    expect(res).to.deep.include({
      id: "s",
      vary: { dummy: true },
      content: "supplemental",
      directives: { freshUntilAge: 1 },
    });
  });

  it("should not call the fetcher again during the freshness window", async () => {
    await sut({ id: "myUrl" });
    await delay(30);
    await sut({ id: "myUrl" });

    expect(fetcher.mock.callCount()).to.eq(1);
  });

  it("should call but not block on the fetcher during the staleWhileRefresh window, if any", async () => {
    // Load content into the cache.
    const res1 = await sut({ id: "myUrl", params: {} });

    // get into the stale while validate window
    await delay(150);

    // request cached data, which should come back to us immediately w/ the old
    // result (faster than the fetcher loads), while a second load is triggered.
    const res2 = await sut({ id: "myUrl" });
    expect(res1.content).to.deep.eq(res2.content);

    // After the fetcher resolves, we should see that second load result
    // if we query the cache again.
    await delay(10);
    const res3 = await sut({ id: "myUrl" });
    expect(res2.content).to.not.deep.eq(res3.content);
    expect(fetcher.mock.callCount()).to.eq(2);
  });

  it("should call the fetcher again and block after the expiration window", async () => {
    const res1 = await sut({ id: "myUrl" });
    await delay(600);
    const res2 = await sut({ id: "myUrl" });

    expect(res1.content).not.to.deep.eq(res2.content);
    expect(fetcher.mock.callCount()).to.eq(2);
  });

  it("should return the error if the fetcher rejects", async () => {
    const testError = new Error("test");
    const rejectingFetcher = mock.fn(async () => Promise.reject(testError));
    const sut2 = wrapProducer(cache, {}, rejectingFetcher);

    return sut2({ id: "someUrl" }).then(
      () => {
        throw new Error("should have rejected");
      },
      (e: unknown) => {
        expect(e).to.eql(testError);
      },
    );
  });

  it("should use the cached response if fetcher rejects during the staleIfError window", async () => {
    const testError = new Error("test");
    const testResult = {
      content: { body: { test: true }, headers: {} },
      directives: {
        freshUntilAge: 0.05,
        maxStale: {
          withoutRevalidation: 0,
          whileRevalidate: 0,
          ifError: 0.1,
        },
      },
    } satisfies RequestPairedProducerResult<any, any, any>;

    let customFetcherCallCount = 0;
    const customTestFetcher = mock.fn(async () => {
      const currentCall = customFetcherCallCount;
      customFetcherCallCount++;
      switch (currentCall) {
        case 0:
          return testResult;
        case 1:
        case 2:
          throw testError;
        case 3:
          return testResult;
        default:
          throw new Error("unexpected number of calls");
      }
    });

    const sut2 = wrapProducer(cache, {}, customTestFetcher);

    const firstRes = await sut2({ id: "someUrl" });
    expect(firstRes).to.deep.include(testResult);

    await delay(80);

    // first res is expired, and the fetcher errored, but we should
    // be able to reuse the first res anyway because of staleIfError.
    const secondRes = await sut2({ id: "someUrl" });
    expect(secondRes).to.deep.include(testResult);
    expect(customTestFetcher.mock.callCount()).to.eq(2);

    await delay(120);

    // now, the staleIfError window should be up, so we have to go back
    // to the fetcher, but it errors again, so we should get that error.
    try {
      await sut2({ id: "someUrl" });
    } catch (e) {
      expect(e).to.deep.eq(testError);
      expect(customTestFetcher.mock.callCount()).to.eq(3);
    }

    // finally, the server comes back online for the next request
    const fourthRes = await sut2({ id: "someUrl" });
    expect(fourthRes).to.deep.include({ content: testResult.content });
  });

  it("should treat resolution values with Error-instance content as success", async () => {
    const test404 = new Error("test");
    const resolveWithErrorFetcher = mock.fn(
      async () =>
        ({
          content: test404 as unknown,
          directives: { freshUntilAge: 0 },
        }) satisfies RequestPairedProducerResult<any, any, any>,
    );
    const sut2 = wrapProducer(cache, {}, resolveWithErrorFetcher);

    return sut2({ id: "someUrl2" }).then((it) => {
      expect(it).to.include({ content: test404 });
    });
  });

  it("should respect consumer directives too", async () => {
    const randomId = String(Math.random());

    // Even though producer says the data's good for 100ms,
    // it should get called twice if the client sets its maxAge to 0
    await sut({ id: randomId, directives: { maxAge: 0 } });
    await delay(5);
    await sut({ id: randomId, directives: { maxAge: 0 } });
    expect(fetcher.mock.callCount()).to.eq(2);

    // but this third call should use the cache, because no consumer directive
    await sut({ id: randomId });
    expect(fetcher.mock.callCount()).to.eq(2);
  });

  describe("the onCacheReadFailure setting", async () => {
    const err = new Error("Cache get error 2");
    let mockCache: Cache<null, AnyValidators, AnyParams, string>;

    beforeEach(() => {
      mockCache = new Cache(new MemoryStore());
      mockCache.get = async () => {
        throw err;
      };
    });

    afterEach(async () => {
      await mockCache.close();
    });

    it("should throw if configured and cache's get method rejects", async () => {
      const wrappedProducer = wrapProducer(
        mockCache,
        { onCacheReadFailure: "throw" },
        async ({ id }) => ({
          content: id,
          directives: { freshUntilAge: 1 },
        }),
      );

      await wrappedProducer({ id: "test" }).then(
        () => {
          throw new Error("should've rejected");
        },
        (e) => {
          expect(e).to.eq(err);
        },
      );
    });

    it("should call the producer if configured and cache's get method rejects", async () => {
      const mockProducer = mock.fn(async ({ id }) => ({
        content: id,
        directives: { freshUntilAge: 1 },
      }));

      const wrappedProducer = wrapProducer(
        mockCache,
        { onCacheReadFailure: "call-producer" },
        mockProducer,
      );

      const res = await wrappedProducer({ id: "test" });
      expect(res.content).to.eq("test");
    });

    it("should call the producer by default if cache's get method rejects", async () => {
      const mockProducer = mock.fn(async ({ id }) => ({
        content: id,
        directives: { freshUntilAge: 1 },
      }));

      const wrappedProducer = wrapProducer(mockCache, {}, mockProducer);

      const res = await wrappedProducer({ id: "test" });
      expect(res.content).to.eq("test");
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  it.skip("collapsing overlapping requests to producer", () => {});
});
/* eslint-enable @typescript-eslint/no-explicit-any */
