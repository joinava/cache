import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

const DEFAULT_TIME_SLICE_MS = 8;
const performanceNow = performance.now.bind(performance);

type Synchronous<Result> = Result extends PromiseLike<unknown> ? never : Result;

/**
 * A time budget before yielding that can be shared between related operations.
 */
export class TimeSliceBudget {
  readonly #sliceMs;
  readonly #now;
  readonly #yieldToEventLoop;
  #remainingMs;
  #depth = 0;

  constructor(
    sliceMs = DEFAULT_TIME_SLICE_MS,
    now = performanceNow,
    yieldToEventLoop: () => Promise<void> = setImmediate,
  ) {
    assert.ok(
      Number.isFinite(sliceMs) && sliceMs > 0,
      "sliceMs must be finite and greater than zero",
    );
    this.#sliceMs = sliceMs;
    this.#remainingMs = sliceMs;
    this.#now = now.bind(performance);
    this.#yieldToEventLoop = yieldToEventLoop;
  }

  /** Charge synchronous work once, including nested calls and failures. */
  measure<Result>(work: () => Result & Synchronous<Result>): Result {
    const outermost = this.#depth === 0;
    const startedAt = outermost ? this.#now() : 0;
    this.#depth += 1;
    try {
      return work();
    } finally {
      this.#depth -= 1;
      if (outermost) this.#remainingMs -= this.#now() - startedAt;
    }
  }

  /** Replenish before yielding so connected work can use the next slice. */
  yieldIfNeeded(): Promise<void> | undefined {
    if (this.#remainingMs > 0) return undefined;
    this.#remainingMs = this.#sliceMs;
    return this.#yieldToEventLoop();
  }
}

/** Run synchronous callbacks in order. One callback cannot be interrupted. */
export async function timeSlicedForEach<Item, Result>(
  items: Iterable<Item>,
  callback: (item: Item, index: number) => Result & Synchronous<Result>,
  budget = new TimeSliceBudget(),
): Promise<void> {
  const position = { index: 0 };
  // oxlint-disable-next-line zingage/no-restricted-syntax -- Native iteration owns cleanup while the body awaits budget yields.
  for (const item of items) {
    budget.measure<Result>(() => callback(item, position.index));
    position.index += 1;
    const pending = budget.yieldIfNeeded();
    if (pending !== undefined) await pending;
  }
  const pending = budget.yieldIfNeeded();
  if (pending !== undefined) await pending;
}

export async function timeSlicedMap<Item, Result>(
  items: Iterable<Item>,
  callback: (item: Item, index: number) => Result & Synchronous<Result>,
  budget = new TimeSliceBudget(),
): Promise<Result[]> {
  const results: Result[] = [];
  await timeSlicedForEach(
    items,
    (item, index) => {
      // oxlint-disable-next-line zingage/no-restricted-syntax -- Append to the local result to avoid quadratic copying.
      results.push(callback(item, index));
    },
    budget,
  );
  return results;
}

export async function timeSlicedFlatMap<Item, Result>(
  items: Iterable<Item>,
  callback: (item: Item, index: number) => readonly Result[],
  budget = new TimeSliceBudget(),
): Promise<Result[]> {
  const results: Result[] = [];
  const position = { index: 0 };
  // oxlint-disable-next-line zingage/no-restricted-syntax -- Native outer iteration owns cleanup; inner traversal can also yield.
  for (const item of items) {
    const mapped = budget.measure(() => callback(item, position.index));
    position.index += 1;
    const pending = budget.yieldIfNeeded();
    if (pending !== undefined) await pending;
    await timeSlicedForEach(
      mapped,
      (value) => {
        // oxlint-disable-next-line zingage/no-restricted-syntax -- Append incrementally without argument-spread limits or quadratic copying.
        results.push(value);
      },
      budget,
    );
  }
  const pending = budget.yieldIfNeeded();
  if (pending !== undefined) await pending;
  return results;
}

export async function timeSlicedFilter<Item>(
  items: Iterable<Item>,
  predicate: (item: Item, index: number) => boolean,
  budget = new TimeSliceBudget(),
): Promise<Item[]> {
  const results: Item[] = [];
  await timeSlicedForEach(
    items,
    (item, index) => {
      if (predicate(item, index)) {
        // oxlint-disable-next-line zingage/no-restricted-syntax -- Append to the local result without quadratic copying.
        results.push(item);
      }
    },
    budget,
  );
  return results;
}

export async function timeSlicedGroupBy<Item, Key>(
  items: Iterable<Item>,
  keyOf: (item: Item, index: number) => Key & Synchronous<Key>,
  budget = new TimeSliceBudget(),
): Promise<Map<Key, Item[]>> {
  const groups = new Map<Key, Item[]>();
  await timeSlicedForEach(
    items,
    (item, index) => {
      const key = keyOf(item, index);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [item]);
      // oxlint-disable-next-line zingage/no-restricted-syntax -- Each local group accumulates without quadratic copying.
      else group.push(item);
    },
    budget,
  );
  return groups;
}

export async function timeSlicedMapFromEntries<Key, Value>(
  entries: Iterable<readonly [Key, Value]>,
  budget = new TimeSliceBudget(),
): Promise<Map<Key, Value>> {
  const result = new Map<Key, Value>();
  await timeSlicedForEach(
    entries,
    ([key, value]) => {
      result.set(key, value);
    },
    budget,
  );
  return result;
}
