import { TimeSliceBudget, timeSlicedForEach } from "./time-slicing.js";

/** Stable sorting with the same comparator as native sort and bounded native runs. */
export async function sortCooperatively<T>(
  items: readonly T[],
  compare: (left: T, right: T) => number,
): Promise<T[]> {
  const budget = new TimeSliceBudget();
  const compareWithinBudget = (left: T, right: T) =>
    budget.measure(() => compare(left, right));
  const runSize = 256;
  function* sortedRuns() {
    for (let start = 0; start < items.length; start += runSize) {
      yield* items.slice(start, start + runSize).sort(compareWithinBudget);
    }
  }
  function* mergedRuns(source: readonly T[], width: number) {
    for (let start = 0; start < source.length; start += 2 * width) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + 2 * width, source.length);
      let left = start;
      let right = middle;
      while (left < middle || right < end) {
        if (
          right === end ||
          (left < middle && !(compareWithinBudget(source[left]!, source[right]!) > 0))
        ) {
          yield source[left++]!;
        } else {
          yield source[right++]!;
        }
      }
    }
  }
  let result: T[] = [];
  await timeSlicedForEach(sortedRuns(), (item) => {
    result.push(item);
  }, budget);
  for (let width = runSize; width < items.length; width *= 2) {
    const merged: T[] = [];
    await timeSlicedForEach(mergedRuns(result, width), (item) => {
      merged.push(item);
    }, budget);
    result = merged;
  }
  return result;
}
