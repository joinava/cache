import fc from "fast-check";

/**
 * Adversarial resource-id arbitraries for fuzzing classification (the 2.0
 * resource-type registry).
 *
 * The design doc's test plan (§10) calls for fast-check over adversarial ids,
 * "reusing the Object.prototype-collision arbitraries from the vary-matching
 * suite". The vary-matching conformance suite
 * (src/stores/Store.conformance.test.ts, "treats vary keys that collide with
 * Object.prototype members as ordinary params") uses hardcoded
 * `constructor`/`toString`/`__proto__` keys rather than an exported arbitrary,
 * so this file packages that idea as reusable arbitraries: ids (and id
 * suffixes) that collide with `Object.prototype` members, which break any
 * classification/registry implementation that does naive property lookups on
 * plain objects (e.g. a per-id memo object, or `registry[name]` resolution
 * that walks the prototype chain).
 */
export const ObjectPrototypeCollisionKeyArb: fc.Arbitrary<string> =
  fc.constantFrom(
    "__proto__",
    "constructor",
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
  );

/**
 * Ids that are adversarial for classification: bare Object.prototype member
 * names, prototype member names hiding behind a realistic prefix, the empty
 * string, and arbitrary (including non-ASCII) strings.
 */
export const AdversarialIdArb: fc.Arbitrary<string> = fc.oneof(
  ObjectPrototypeCollisionKeyArb,
  fc
    .tuple(fc.constantFrom("site:", "biz:", ""), ObjectPrototypeCollisionKeyArb)
    .map(([prefix, key]) => `${prefix}${key}`),
  fc.constant(""),
  fc.string(),
  fc.string({ unit: "binary" }),
);
