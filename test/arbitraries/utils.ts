import fc from "fast-check";

// We prefer integers to avoid edge cases where tests would otherwise fail
// because of the imprecision of floating point math, and we always use pretty
// big floats because certain tests can fail if we use values too close to 0.
// (e.g., if the freshUntilAge is verrrry close to 0, the test can fail if the
// entry becomes not fresh between when we create it and when we assert on it.)
//
// TODO: properly handle NaN
export const AnyNumberArb = fc.oneof(
  fc.integer(),
  fc.double({ min: 0.05, noNaN: true }),
  fc.double({ max: -0.05, noNaN: true }),
);

export const PositiveNumberArb = fc.oneof(
  fc.integer({ min: 1 }),
  fc.double({ min: 0.05, noNaN: true }),
);
