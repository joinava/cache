/**
 * DataLoader's own test suite (graphql/dataloader, src/__tests__), ported to
 * the Batcher. With no aborted signal, and no `flush` or `dispatchNow` call,
 * a Batcher must behave exactly like a DataLoader built with `cache: false`.
 *
 * The Batcher has no cache, so every test here uses DataLoader's
 * `cache: false` behavior: a repeated key is sent again, and a later load of
 * a key starts a new load. The ported tests keep DataLoader's names and
 * comments. A test whose cache-enabled expectation differs says so.
 *
 * Not ported, because the Batcher has no equivalent:
 * - the cache: caching, `clear`, `clearAll`, `prime`, `cacheKeyFn`,
 *   `cacheMap`, and the unhandled-rejection test for a primed error;
 * - the `name` option, and `batch: false` (use `maxBatchSize: 1`);
 * - argument checks that TypeScript enforces: a missing batch function or
 *   key, a non-array `loadMany` argument, a batch function that returns a
 *   non-promise, and a non-function `batchScheduleFn`;
 * - the browser tests: the Batcher runs on Node only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Batcher } from "./batcher.js";

type BatchLoadFn<K, V> = (
  this: unknown,
  keys: readonly K[],
) => Promise<readonly (V | Error)[]>;

type LoaderOptions = {
  maxBatchSize?: number;
  batchScheduleFn?: (this: unknown, callback: () => void) => void;
};

/**
 * DataLoader's `load` and `loadMany` on a Batcher. `load` enqueues one item.
 * `loadMany` enqueues all its keys in one call, and turns each rejection into
 * its error, as DataLoader's `loadMany` does.
 */
function makeLoader<K, V>(
  batchLoadFn: BatchLoadFn<K, V>,
  options?: LoaderOptions,
) {
  const batcher = new Batcher<K, V>({
    ...options,
    dispatch: function (this: unknown, items) {
      return batchLoadFn.call(
        this,
        items.map(({ input }) => input),
      );
    },
  });
  return {
    batcher,
    load: (key: K) => batcher.enqueue([{ input: key }])[0]!.result,
    loadMany: (keys: readonly K[]) =>
      Promise.all(
        batcher
          .enqueue(keys.map((key) => ({ input: key })))
          .map(({ result }) => result.catch((error: unknown) => error)),
      ),
  };
}

function idLoader<K>(options?: LoaderOptions) {
  const loadCalls: (readonly K[])[] = [];
  const identityLoader = makeLoader<K, K>((keys) => {
    loadCalls.push(keys);
    return Promise.resolve(keys);
  }, options);
  return [identityLoader, loadCalls] as const;
}

/** Returns the rejection of `promise`, and fails when it resolves. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail("expected a rejection"),
    (error: unknown) => error,
  );
}

const nextMacroTask = () => new Promise(setImmediate);

describe("Batcher passes DataLoader's tests", () => {
  describe("Primary API", () => {
    it("builds a really really simple data loader", async () => {
      const identityLoader = makeLoader<number, number>(async (keys) => keys);

      const promise1 = identityLoader.load(1);
      assert.ok(promise1 instanceof Promise);

      const value1 = await promise1;
      assert.equal(value1, 1);
    });

    it('references the loader as "this" in the batch function', async () => {
      let that: unknown;
      const loader = makeLoader<number, number>(async function (keys) {
        // oxlint-disable-next-line typescript-eslint/no-this-alias -- the test checks `this`.
        that = this;
        return keys;
      });

      // Trigger the batch function
      await loader.load(1);

      assert.equal(that, loader.batcher);
    });

    it("supports loading multiple keys in one call", async () => {
      const identityLoader = makeLoader<number, number>(async (keys) => keys);

      const promiseAll = identityLoader.loadMany([1, 2]);
      assert.ok(promiseAll instanceof Promise);

      const values = await promiseAll;
      assert.deepEqual(values, [1, 2]);

      const promiseEmpty = identityLoader.loadMany([]);
      assert.ok(promiseEmpty instanceof Promise);

      const empty = await promiseEmpty;
      assert.deepEqual(empty, []);
    });

    it("supports loading multiple keys in one call with errors", async () => {
      const identityLoader = makeLoader<string, string>((keys) =>
        Promise.resolve(
          keys.map((key) => (key === "bad" ? new Error("Bad Key") : key)),
        ),
      );

      const promiseAll = identityLoader.loadMany(["a", "b", "bad"]);
      assert.ok(promiseAll instanceof Promise);

      const values = await promiseAll;
      assert.deepEqual(values, ["a", "b", new Error("Bad Key")]);
    });

    it("batches multiple requests", async () => {
      const [identityLoader, loadCalls] = idLoader<number>();

      const promise1 = identityLoader.load(1);
      const promise2 = identityLoader.load(2);

      const [value1, value2] = await Promise.all([promise1, promise2]);
      assert.equal(value1, 1);
      assert.equal(value2, 2);

      assert.deepEqual(loadCalls, [[1, 2]]);
    });

    it("batches multiple requests with max batch sizes", async () => {
      const [identityLoader, loadCalls] = idLoader<number>({ maxBatchSize: 2 });

      const promise1 = identityLoader.load(1);
      const promise2 = identityLoader.load(2);
      const promise3 = identityLoader.load(3);

      const [value1, value2, value3] = await Promise.all([
        promise1,
        promise2,
        promise3,
      ]);
      assert.equal(value1, 1);
      assert.equal(value2, 2);
      assert.equal(value3, 3);

      assert.deepEqual(loadCalls, [[1, 2], [3]]);
    });

    it("applies maxBatchSize correctly with duplicate keys", async () => {
      const [identityLoader, loadCalls] = idLoader<string>({
        maxBatchSize: 3,
        batchScheduleFn: (callback) => {
          setTimeout(callback, 100);
        },
      });

      const values = ["a", "b", "a", "a", "a", "b", "c"];
      const results = await Promise.all(
        values.map((value) => identityLoader.load(value)),
      );

      assert.deepEqual(results, values);
      // With its cache, DataLoader sends [["a", "b", "c"]].
      assert.deepEqual(loadCalls, [["a", "b", "a"], ["a", "a", "b"], ["c"]]);
    });

    it("coalesces identical requests", async () => {
      const [identityLoader, loadCalls] = idLoader<number>();

      const promise1a = identityLoader.load(1);
      const promise1b = identityLoader.load(1);

      const [value1a, value1b] = await Promise.all([promise1a, promise1b]);
      assert.equal(value1a, 1);
      assert.equal(value1b, 1);

      // With its cache, DataLoader sends [[1]].
      assert.deepEqual(loadCalls, [[1, 1]]);
    });

    it("coalesces identical requests across sized batches", async () => {
      const [identityLoader, loadCalls] = idLoader<number>({ maxBatchSize: 2 });

      const promise1a = identityLoader.load(1);
      const promise2 = identityLoader.load(2);
      const promise1b = identityLoader.load(1);
      const promise3 = identityLoader.load(3);

      const [value1a, value2, value1b, value3] = await Promise.all([
        promise1a,
        promise2,
        promise1b,
        promise3,
      ]);
      assert.equal(value1a, 1);
      assert.equal(value2, 2);
      assert.equal(value1b, 1);
      assert.equal(value3, 3);

      // With its cache, DataLoader sends [[1, 2], [3]].
      assert.deepEqual(loadCalls, [
        [1, 2],
        [1, 3],
      ]);
    });

    it("does not cache repeated requests", async () => {
      // DataLoader's "May disable caching" test, which mirrors its "caches
      // repeated requests" test.
      const [identityLoader, loadCalls] = idLoader<string>();

      const [a, b] = await Promise.all([
        identityLoader.load("A"),
        identityLoader.load("B"),
      ]);

      assert.equal(a, "A");
      assert.equal(b, "B");

      assert.deepEqual(loadCalls, [["A", "B"]]);

      const [a2, c] = await Promise.all([
        identityLoader.load("A"),
        identityLoader.load("C"),
      ]);

      assert.equal(a2, "A");
      assert.equal(c, "C");

      assert.deepEqual(loadCalls, [
        ["A", "B"],
        ["A", "C"],
      ]);

      const [a3, b2, c2] = await Promise.all([
        identityLoader.load("A"),
        identityLoader.load("B"),
        identityLoader.load("C"),
      ]);

      assert.equal(a3, "A");
      assert.equal(b2, "B");
      assert.equal(c2, "C");

      assert.deepEqual(loadCalls, [
        ["A", "B"],
        ["A", "C"],
        ["A", "B", "C"],
      ]);
    });

    it("Keys are repeated in batch when cache disabled", async () => {
      const [identityLoader, loadCalls] = idLoader<string>();

      const [values1, values2, values3, values4] = await Promise.all([
        identityLoader.load("A"),
        identityLoader.load("C"),
        identityLoader.load("D"),
        identityLoader.loadMany(["C", "D", "A", "A", "B"]),
      ]);

      assert.equal(values1, "A");
      assert.equal(values2, "C");
      assert.equal(values3, "D");
      assert.deepEqual(values4, ["C", "D", "A", "A", "B"]);

      assert.deepEqual(loadCalls, [["A", "C", "D", "C", "D", "A", "A", "B"]]);
    });

    it("loads a key again after an earlier load settles", async () => {
      // DataLoader's "cacheMap may be set to null to disable cache" test.
      const [identityLoader, loadCalls] = idLoader<string>();

      await identityLoader.load("A");
      await identityLoader.load("A");

      assert.deepEqual(loadCalls, [["A"], ["A"]]);
    });
  });

  describe("Represents Errors", () => {
    it("Resolves to error to indicate failure", async () => {
      const loadCalls: (readonly number[])[] = [];
      const evenLoader = makeLoader<number, number>((keys) => {
        loadCalls.push(keys);
        return Promise.resolve(
          keys.map((key) => (key % 2 === 0 ? key : new Error(`Odd: ${key}`))),
        );
      });

      const caughtError = await caught(evenLoader.load(1));
      assert.ok(caughtError instanceof Error);
      assert.equal(caughtError.message, "Odd: 1");

      const value2 = await evenLoader.load(2);
      assert.equal(value2, 2);

      assert.deepEqual(loadCalls, [[1], [2]]);
    });

    it("Can represent failures and successes simultaneously", async () => {
      const loadCalls: (readonly number[])[] = [];
      const evenLoader = makeLoader<number, number>((keys) => {
        loadCalls.push(keys);
        return Promise.resolve(
          keys.map((key) => (key % 2 === 0 ? key : new Error(`Odd: ${key}`))),
        );
      });

      const promise1 = evenLoader.load(1);
      const promise2 = evenLoader.load(2);

      const caughtError = await caught(promise1);
      assert.ok(caughtError instanceof Error);
      assert.equal(caughtError.message, "Odd: 1");

      assert.equal(await promise2, 2);

      assert.deepEqual(loadCalls, [[1, 2]]);
    });

    it("does not cache failed fetches", async () => {
      // DataLoader's "Caches failed fetches" test. With its cache, DataLoader
      // sends [[1]].
      const loadCalls: (readonly number[])[] = [];
      const errorLoader = makeLoader<number, number>((keys) => {
        loadCalls.push(keys);
        return Promise.resolve(keys.map((key) => new Error(`Error: ${key}`)));
      });

      const caughtErrorA = await caught(errorLoader.load(1));
      assert.ok(caughtErrorA instanceof Error);
      assert.equal(caughtErrorA.message, "Error: 1");

      const caughtErrorB = await caught(errorLoader.load(1));
      assert.ok(caughtErrorB instanceof Error);
      assert.equal(caughtErrorB.message, "Error: 1");

      assert.deepEqual(loadCalls, [[1], [1]]);
    });

    it("Propagates error to all loads", async () => {
      const loadCalls: (readonly number[])[] = [];
      const failLoader = makeLoader<number, number>((keys) => {
        loadCalls.push(keys);
        return Promise.reject(new Error("I am a terrible loader"));
      });

      const promise1 = failLoader.load(1);
      const promise2 = failLoader.load(2);

      const caughtErrorA = await caught(promise1);
      assert.ok(caughtErrorA instanceof Error);
      assert.equal(caughtErrorA.message, "I am a terrible loader");

      const caughtErrorB = await caught(promise2);
      assert.equal(caughtErrorB, caughtErrorA);

      assert.deepEqual(loadCalls, [[1, 2]]);
    });
  });

  describe("Accepts any kind of key", () => {
    it("Accepts objects as keys", async () => {
      const [identityLoader, loadCalls] = idLoader<object>();

      const keyA = {};
      const keyB = {};

      // Fetches as expected

      const [valueA, valueB] = await Promise.all([
        identityLoader.load(keyA),
        identityLoader.load(keyB),
      ]);

      assert.equal(valueA, keyA);
      assert.equal(valueB, keyB);

      assert.equal(loadCalls.length, 1);
      assert.equal(loadCalls[0]!.length, 2);
      assert.equal(loadCalls[0]![0], keyA);
      assert.equal(loadCalls[0]![1], keyB);
    });
  });

  describe("Accepts options", () => {
    // Note: mirrors 'batches multiple requests' above.
    it("May disable batching", async () => {
      // DataLoader's `batch: false` sets its maximum batch size to 1.
      const [identityLoader, loadCalls] = idLoader<number>({ maxBatchSize: 1 });

      const promise1 = identityLoader.load(1);
      const promise2 = identityLoader.load(2);

      const [value1, value2] = await Promise.all([promise1, promise2]);
      assert.equal(value1, 1);
      assert.equal(value2, 2);

      assert.deepEqual(loadCalls, [[1], [2]]);
    });
  });

  describe("It allows custom schedulers", () => {
    it("Supports manual dispatch", () => {
      function createScheduler() {
        let callbacks: (() => void)[] = [];
        return {
          schedule: (callback: () => void) => {
            callbacks.push(callback);
          },
          dispatch: () => {
            callbacks.forEach((callback) => callback());
            callbacks = [];
          },
        };
      }

      const { schedule, dispatch } = createScheduler();
      const [identityLoader, loadCalls] = idLoader<string>({
        batchScheduleFn: schedule,
      });

      void identityLoader.load("A");
      void identityLoader.load("B");
      dispatch();
      void identityLoader.load("A");
      void identityLoader.load("C");
      dispatch();
      // Note: never dispatched!
      void identityLoader.load("D");

      // With its cache, DataLoader sends [["A", "B"], ["C"]].
      assert.deepEqual(loadCalls, [
        ["A", "B"],
        ["A", "C"],
      ]);
    });

    it("Custom batch scheduler is provided loader as this context", () => {
      let that: unknown;
      function batchScheduleFn(this: unknown, callback: () => void) {
        // oxlint-disable-next-line typescript-eslint/no-this-alias -- the test checks `this`.
        that = this;
        callback();
      }

      const [identityLoader] = idLoader<string>({ batchScheduleFn });

      void identityLoader.load("A");
      assert.equal(that, identityLoader.batcher);
    });
  });

  describe("It is resilient to job queue ordering", () => {
    it("batches loads occuring within promises", async () => {
      const [identityLoader, loadCalls] = idLoader<string>();

      await Promise.all([
        identityLoader.load("A"),
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => {
            void identityLoader.load("B");
            void Promise.resolve()
              .then(() => Promise.resolve())
              .then(() => {
                void identityLoader.load("C");
                void Promise.resolve()
                  .then(() => Promise.resolve())
                  .then(() => {
                    void identityLoader.load("D");
                  });
              });
          }),
      ]);

      assert.deepEqual(loadCalls, [["A", "B", "C", "D"]]);
    });

    it("can call a loader from a loader", async () => {
      const deepLoadCalls: (readonly (readonly string[])[])[] = [];
      const deepLoader = makeLoader<readonly string[], readonly string[]>(
        (keys) => {
          deepLoadCalls.push(keys);
          return Promise.resolve(keys);
        },
      );

      const aLoadCalls: (readonly string[])[] = [];
      const aLoader = makeLoader<string, string>(async (keys) => {
        aLoadCalls.push(keys);
        return deepLoader.load(keys);
      });

      const bLoadCalls: (readonly string[])[] = [];
      const bLoader = makeLoader<string, string>(async (keys) => {
        bLoadCalls.push(keys);
        return deepLoader.load(keys);
      });

      const [a1, b1, a2, b2] = await Promise.all([
        aLoader.load("A1"),
        bLoader.load("B1"),
        aLoader.load("A2"),
        bLoader.load("B2"),
      ]);

      assert.equal(a1, "A1");
      assert.equal(b1, "B1");
      assert.equal(a2, "A2");
      assert.equal(b2, "B2");

      assert.deepEqual(aLoadCalls, [["A1", "A2"]]);
      assert.deepEqual(bLoadCalls, [["B1", "B2"]]);
      assert.deepEqual(deepLoadCalls, [
        [
          ["A1", "A2"],
          ["B1", "B2"],
        ],
      ]);
    });
  });

  describe("Settles results like DataLoader", () => {
    // From DataLoader's "batches cached requests" test, without the primed
    // key: no load settles before its batch function's promise does.
    it("settles no load before the batch function resolves", async () => {
      const loadCalls: (readonly number[])[] = [];
      let resolveBatch = () => {};
      const identityLoader = makeLoader<number, number>((keys) => {
        loadCalls.push(keys);
        return new Promise((resolve) => {
          resolveBatch = () => resolve(keys);
        });
      });

      const promise1 = identityLoader.load(1);
      const promise2 = identityLoader.load(2);

      // Track when each resolves.
      let promise1Resolved = false;
      let promise2Resolved = false;
      void promise1.then(() => {
        promise1Resolved = true;
      });
      void promise2.then(() => {
        promise2Resolved = true;
      });

      // Move to next macro-task (tick)
      await nextMacroTask();

      assert.equal(promise1Resolved, false);
      assert.equal(promise2Resolved, false);

      resolveBatch();
      // Move to next macro-task (tick)
      await nextMacroTask();

      assert.equal(promise1Resolved, true);
      assert.equal(promise2Resolved, true);

      assert.deepEqual(await Promise.all([promise1, promise2]), [1, 2]);
      assert.deepEqual(loadCalls, [[1, 2]]);
    });
  });

  describe("Provides descriptive error messages for API abuse", () => {
    it("Requires a positive number for maxBatchSize", () => {
      assert.throws(
        () =>
          makeLoader<number, number>(async (keys) => keys, { maxBatchSize: 0 }),
        TypeError,
      );
    });

    // DataLoader wraps the next three failures in its own TypeError. The
    // Batcher rejects every load with one Error too, but its messages differ.
    it("Batch function must return a Promise, not error synchronously", async () => {
      const thrown = new Error("Mock Synchronous Error");
      const badLoader = makeLoader<number, number>(() => {
        throw thrown;
      });

      const caughtError = await caught(badLoader.load(1));
      assert.ok(caughtError instanceof Error);
    });

    it("Batch function must return a Promise of an Array, not null", async () => {
      const badLoader = makeLoader<number, number>(
        // @ts-expect-error The batch function's type forbids null.
        async () => null,
      );

      const caughtError = await caught(badLoader.load(1));
      assert.ok(caughtError instanceof Error);
    });

    it("Batch function must promise an Array of correct length", async () => {
      // Note: this resolves to empty array
      const badLoader = makeLoader<number, number>(async () => []);

      const caughtError = await caught(badLoader.load(1));
      assert.ok(caughtError instanceof Error);
    });
  });
});
