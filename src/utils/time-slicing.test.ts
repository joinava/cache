import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  TimeSliceBudget,
  timeSlicedFilter,
  timeSlicedFlatMap,
  timeSlicedForEach,
  timeSlicedGroupBy,
  timeSlicedMap,
  timeSlicedMapFromEntries,
} from "./time-slicing.js";

function clock() {
  const state = { time: 0, yields: 0 };
  return {
    state,
    settings: {
      now: () => state.time,
      yieldToEventLoop: async () => {
        state.yields += 1;
        state.time += 100;
        await Promise.resolve();
      },
    },
    work: (ms: number) => {
      state.time += ms;
    },
  };
}

describe("processing budgets", () => {
  it("gives independent calls their own allowance", async () => {
    const c = clock();
    await Promise.all([
      timeSlicedForEach(
        [0],
        () => c.work(5),
        new TimeSliceBudget(
          undefined,
          c.settings.now,
          c.settings.yieldToEventLoop,
        ),
      ),
      timeSlicedForEach(
        [0],
        () => c.work(5),
        new TimeSliceBudget(
          undefined,
          c.settings.now,
          c.settings.yieldToEventLoop,
        ),
      ),
    ]);
    assert.equal(c.state.yields, 0);
  });

  it("shares the remainder and excludes unrelated work between calls", async () => {
    const c = clock();
    const budget = new TimeSliceBudget(
      undefined,
      c.settings.now,
      c.settings.yieldToEventLoop,
    );
    await timeSlicedForEach([0], () => c.work(3), budget);
    c.work(1_000);
    await timeSlicedForEach([0], () => c.work(4), budget);
    assert.equal(c.state.yields, 0);
    await timeSlicedForEach([0], () => c.work(1), budget);
    assert.equal(c.state.yields, 1);
  });

  it("replenishes before yielding so connected work can use the next slice", async () => {
    const c = clock();
    const waiting = Promise.withResolvers<void>();
    const budget = new TimeSliceBudget(undefined, c.settings.now, async () => {
      c.state.yields += 1;
      await waiting.promise;
    });
    const a = timeSlicedForEach([0], () => c.work(8), budget);
    assert.equal(c.state.yields, 1);
    c.work(1_000);
    const b = timeSlicedForEach([0], () => c.work(7), budget);
    await b;
    assert.equal(c.state.yields, 1);
    waiting.resolve();
    await a;
    await timeSlicedForEach([0], () => c.work(1), budget);
    assert.equal(c.state.yields, 2);
  });

  it("does not charge waiting time or grant a new slice on resumption", async () => {
    const c = clock();
    const budget = new TimeSliceBudget(
      undefined,
      c.settings.now,
      c.settings.yieldToEventLoop,
    );
    await timeSlicedForEach([8, 7, 1], (ms) => c.work(ms), budget);
    assert.equal(c.state.yields, 2);
  });

  it("counts failed callbacks toward a reused budget", async () => {
    const c = clock();
    const budget = new TimeSliceBudget(
      undefined,
      c.settings.now,
      c.settings.yieldToEventLoop,
    );
    const failure = new TypeError("callback failed");
    await assert.rejects(
      timeSlicedForEach(
        [0],
        () => {
          c.work(6);
          throw failure;
        },
        budget,
      ),
      (error) => error === failure,
    );
    await timeSlicedForEach([0], () => c.work(2), budget);
    assert.equal(c.state.yields, 1);
  });

  it("closes a generator after callback failure", async () => {
    const c = clock();
    const state = { closed: false };
    function* items() {
      try {
        c.work(5);
        yield 1;
        c.work(5);
        yield 2;
      } finally {
        state.closed = true;
      }
    }
    const failure = new TypeError("stop");
    await assert.rejects(
      timeSlicedForEach(
        items(),
        (value) => {
          if (value === 2) throw failure;
        },
        new TimeSliceBudget(
          undefined,
          c.settings.now,
          c.settings.yieldToEventLoop,
        ),
      ),
      (error) => error === failure,
    );
    assert.equal(state.closed, true);
    await timeSlicedForEach(
      [0],
      () => c.work(1),
      new TimeSliceBudget(
        undefined,
        c.settings.now,
        c.settings.yieldToEventLoop,
      ),
    );
  });

  it("does not double-charge nested synchronous work on the same budget", async () => {
    const c = clock();
    const budget = new TimeSliceBudget(
      undefined,
      c.settings.now,
      c.settings.yieldToEventLoop,
    );
    const nested: Promise<void>[] = [];
    await timeSlicedForEach(
      [0],
      () => {
        c.work(2);
        nested[0] = timeSlicedForEach([0], () => c.work(3), budget);
        c.work(1);
      },
      budget,
    );
    await Promise.all(nested);
    assert.equal(c.state.yields, 0);
    await timeSlicedForEach([0], () => c.work(2), budget);
    assert.equal(c.state.yields, 1);
  });

  it("propagates a yield failure and closes the active iterator", async () => {
    const c = clock();
    const state = { closed: false };
    function* items() {
      try {
        yield 0;
        yield 1;
      } finally {
        state.closed = true;
      }
    }
    const failure = new TypeError("yield failed");
    await assert.rejects(
      timeSlicedForEach(
        items(),
        () => c.work(8),
        new TimeSliceBudget(
          undefined,
          c.settings.now,
          async () => await Promise.reject(failure),
        ),
      ),
      (error) => error === failure,
    );
    assert.equal(state.closed, true);
  });

  it("validates slice length", () => {
    [0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((sliceMs) =>
      assert.throws(() => new TimeSliceBudget(sliceMs)),
    );
  });

  it("uses a configured slice length", async () => {
    const c = clock();
    await timeSlicedForEach(
      [3, 3],
      (ms) => c.work(ms),
      new TimeSliceBudget(3, c.settings.now, c.settings.yieldToEventLoop),
    );
    assert.equal(c.state.yields, 2);
  });

  it("lets a real event-loop callback run before later items", async () => {
    const c = clock();
    const state = { tick: false };
    const tick = setImmediate().then(() => {
      state.tick = true;
    });
    const result = await timeSlicedMap(
      [0, 1, 2],
      () => {
        c.work(4);
        return state.tick;
      },
      new TimeSliceBudget(undefined, c.settings.now),
    );
    await tick;
    assert.deepEqual(result, [false, false, true]);
  });
});

describe("collection helpers", () => {
  it("maps iterable values in input order with their indices", async () => {
    assert.deepEqual(
      await timeSlicedMap(
        new Set([4, 9]),
        (item, index) => `${index}:${item}`,
        new TimeSliceBudget(),
      ),
      ["0:4", "1:9"],
    );
    assert.deepEqual(await timeSlicedMap([], (item: number) => item), []);
  });

  it("flattens large result lists without argument spreading", async () => {
    const result = await timeSlicedFlatMap(
      [0, 1],
      (item) =>
        item === 0 ? [] : Array.from({ length: 100_000 }, (_, index) => index),
      new TimeSliceBudget(),
    );
    assert.equal(result.length, 100_000);
    assert.equal(result.at(-1), 99_999);
  });

  it("charges callbacks returning empty flat-map lists", async () => {
    const c = clock();
    assert.deepEqual(
      await timeSlicedFlatMap(
        [0, 1],
        () => {
          c.work(4);
          return [];
        },
        new TimeSliceBudget(
          undefined,
          c.settings.now,
          c.settings.yieldToEventLoop,
        ),
      ),
      [],
    );
    assert.equal(c.state.yields, 1);
  });

  it("filters and groups without changing input order", async () => {
    assert.deepEqual(
      await timeSlicedFilter(
        [3, 2, 1],
        (item) => item % 2 === 1,
        new TimeSliceBudget(),
      ),
      [3, 1],
    );
    assert.deepEqual(
      await timeSlicedGroupBy(
        [3, 2, 1],
        (item) => item % 2,
        new TimeSliceBudget(),
      ),
      new Map([
        [1, [3, 1]],
        [0, [2]],
      ]),
    );
  });

  it("keeps the last value for repeated map keys", async () => {
    const entries = new Map([
      [0, ["a", 1] as const],
      [1, ["b", 2] as const],
      [2, ["a", 3] as const],
    ]);
    assert.deepEqual(
      await timeSlicedMapFromEntries(entries.values(), new TimeSliceBudget()),
      new Map([
        ["a", 3],
        ["b", 2],
      ]),
    );
  });
});

describe("native iterator cleanup", () => {
  const traversals = [
    {
      name: "forEach",
      run: async (
        items: Iterable<number>,
        callback: (value: number) => void,
        budget: TimeSliceBudget,
      ) => await timeSlicedForEach(items, callback, budget),
    },
    {
      name: "flatMap",
      run: async (
        items: Iterable<number>,
        callback: (value: number) => void,
        budget: TimeSliceBudget,
      ) =>
        await timeSlicedFlatMap(
          items,
          (value) => {
            callback(value);
            return [];
          },
          budget,
        ),
    },
  ];
  // oxlint-disable-next-line zingage/no-restricted-syntax -- Register the same cleanup tests for both traversal implementations.
  for (const { name, run } of traversals) {
    describe(name, () => {
      it(`${name} does not close an iterator whose next method throws`, async () => {
        const state = { closes: 0 };
        const failure = new TypeError("next failed");
        const items: Iterable<number> = {
          [Symbol.iterator]() {
            return {
              next: () => {
                throw failure;
              },
              return: () => {
                state.closes += 1;
                return { done: true, value: undefined };
              },
            };
          },
        };
        await assert.rejects(
          run(
            items,
            () => assert.fail("next must fail first"),
            new TimeSliceBudget(),
          ),
          (error) => error === failure,
        );
        assert.equal(state.closes, 0);
      });

      it(`${name} preserves callback errors when cleanup also throws`, async () => {
        const state = { closes: 0 };
        const failure = new TypeError("callback failed");
        const items: Iterable<number> = {
          [Symbol.iterator]() {
            const iterator = {
              next() {
                assert.equal(this, iterator);
                return { done: false as const, value: 1 };
              },
              return() {
                assert.equal(this, iterator);
                state.closes += 1;
                throw new TypeError("cleanup failed");
              },
            };
            return iterator;
          },
        };
        await assert.rejects(
          run(
            items,
            () => {
              throw failure;
            },
            new TimeSliceBudget(),
          ),
          (error) => error === failure,
        );
        assert.equal(state.closes, 1);
      });

      it(`${name} preserves yield failures when cleanup also throws`, async () => {
        const c = clock();
        const state = { closes: 0 };
        const failure = new TypeError("yield failed");
        const items: Iterable<number> = {
          [Symbol.iterator]() {
            return {
              next: () => ({ done: false as const, value: 1 }),
              return: () => {
                state.closes += 1;
                throw new TypeError("cleanup failed");
              },
            };
          },
        };
        const budget = new TimeSliceBudget(
          8,
          c.settings.now,
          async () => await Promise.reject(failure),
        );
        await assert.rejects(
          run(items, () => c.work(8), budget),
          (error) => error === failure,
        );
        assert.equal(state.closes, 1);
      });

      it(`${name} does not close after normal exhaustion or charge iterator work`, async () => {
        const c = clock();
        const state = { closes: 0, calls: 0 };
        const items: Iterable<number> = {
          [Symbol.iterator]() {
            return {
              next: () => {
                state.calls += 1;
                c.work(4);
                return state.calls === 1
                  ? { done: false as const, value: 1 }
                  : { done: true as const, value: undefined };
              },
              return: () => {
                state.closes += 1;
                return { done: true, value: undefined };
              },
            };
          },
        };
        await run(
          items,
          () => {},
          new TimeSliceBudget(8, c.settings.now, c.settings.yieldToEventLoop),
        );
        assert.equal(state.closes, 0);
        assert.equal(c.state.yields, 0);
      });
    });
  }
});
