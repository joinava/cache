import type { Tagged } from "type-fest";
import { instantiateTaggedType } from "type-party/runtime/tagged-types.js";

/**
 * A reading of `performance.now()`, in milliseconds since the time origin.
 *
 * The tag keeps other numbers out of a parameter that expects a reading of
 * this clock. Examples are a `Date.now()` time, which uses a different
 * origin, and a duration.
 */
export type PerformanceNow = Tagged<number, "PerformanceNow">;

/** Reads `performance.now()`. */
export function performanceNow(): PerformanceNow {
  return instantiateTaggedType<PerformanceNow>(performance.now());
}

/** The milliseconds that passed between `start` and now. */
export function msSince(start: PerformanceNow): number {
  return performance.now() - start;
}
