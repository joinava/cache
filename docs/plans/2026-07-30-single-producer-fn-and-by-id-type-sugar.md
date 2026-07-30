# Single producer function + by-id-type sugar

**Date:** 2026-07-30
**Status:** implemented (see §10 for the ratified deviations)
**Amends:** `2026-07-28-resource-type-registry-and-diagnostics.md` §6.3, §6.5.3, §6.6

Bare `§n.n` references throughout point at that 2.0 plan; sections of *this*
document are written out as "§5.1 of this doc".

## 1. Problem

2.0 made the per-resource-type producer **record** the only accepted form for
`wrapProducer` and `wrapBulkProducer`. For the bulk wrapper that removed a
capability 1.6.0 had: a multi-id-type bulk producer could see the **full** set
of requested ids and optimize across them — one upstream call covering several
resource types, cross-type dedup, a join. Under the record form each producer
sees only its own type's slice, and the wrapper issues one call per type.

The layering was also inverted. In 1.6.0 the single function was the primitive
and per-type dispatch was *opt-in sugar* (`producerByIdType`). 2.0 made the
sugar mandatory and deleted the primitive — and for bulk there had never been a
per-type sugar at all, so the only form callers had was replaced outright.

## 2. Evidence

Each of these was probed against the real types on this branch, not reasoned
about. They are the load-bearing facts behind the design.

1. **1.6.0 had no bulk per-type sugar.** `producerByIdType` built a
   `RequestPairedProducer` (single); `computingProducerByInputType` covered the
   computing wrappers. Bulk's only form was one function over the whole union.
2. **Today's bare-function form fails in the worst way.** Passing a bare
   function to `wrapBulkProducer` is *silently accepted* — no error at the call
   site — then `Covered` collapses to `never` and the returned wrapper is
   uncallable, so the error surfaces at every *use* site instead.
3. **One function cannot be registered under several record keys.** Parameters
   are fine (contravariance — accepting the wider id union is legal); the
   **result** type is the blocker: each key narrows results to that key's
   content, so a shared function returning `Story | Story[]` is assignable to
   neither the `story` nor the `collection` slot. This is why the record form
   cannot simply be reused for cross-type producers, and it matches 1.6.0's own
   docstring, which said the type system deliberately does not require the i'th
   result to align with the i'th request because that "would require gnarly
   mapped-tuple typing."
4. **`Covered` does not infer from the producer function's parameter type.** It
   always falls back to its default. A function typed for only `story:` ids is
   therefore *rejected* rather than silently widened — the safe direction, but
   it means partial coverage cannot be expressed by a bare function.
5. **A defaulted `Covered` plus an optional symbol-keyed carrier gives both
   behaviours.** With `Covered extends ResourceTypeName<RT> =
   ResourceTypeName<RT>` and an **optional** `unique symbol` property on the
   helper's return type: a bare function takes the default (the whole registry),
   while a helper narrows `Covered` to its subset — verified including that an
   uncovered id is a compile error at the fetcher's call site.

Finding 5 refutes §6.3's claim that bare-function sugar is *"unsound rather
than merely omitted."* The unsoundness in finding 2 is an artifact of `Covered`
having **no default**, not something inherent to a bare function.

## 3. Design

### 3.1 The rule

Both wrappers take exactly **one** producer function.

- **A bare function covers the whole registry.** `Covered` defaults to
  `ResourceTypeName<RT>`, and the compiler makes the function prove it: its
  parameter must accept every registry id (finding 4).
- **Partial coverage requires a helper**, whose return type carries `Covered` in
  an optional symbol-keyed property. Optional is what lets bare functions
  through; inference beats the default whenever that property is present.

### 3.2 Contracts

```ts
declare const coveredTypes: unique symbol;

/**
 * A producer function that may additionally declare WHICH resource types it
 * covers. The property is **optional and carries a real runtime value** — the
 * covered type names — so it serves double duty: `Covered` is inferred from it
 * at compile time, and the wrapper reads it at runtime to enforce coverage
 * before touching the store. A plain function omits it and picks up `Covered`'s
 * default (every registry type), which needs no runtime check.
 *
 * It is deliberately NOT a value-less phantom: making it required would reject
 * bare functions, and making it type-only would leave the wrapper with no
 * runtime source for the covered set now that there are no record keys to read.
 */
export type CoveringProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = ((
  req: ReadonlyDeep<ConsumerRequest<Params, IdOfResourceType<RT[Covered]>>>,
) => Promise<
  RequestPairedProducerResult<
    SpecOf<RT>,
    Validators,
    Params,
    IdOfResourceType<RT[Covered]>
  >
>) & {
  readonly [coveredTypes]?: readonly Covered[];
};

export type CoveringBulkProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
> = ((
  reqs: readonly ReadonlyDeep<
    ConsumerRequest<Params, IdOfResourceType<RT[Covered]>>
  >[],
) => Promise<
  (
    | RequestPairedProducerResult<
        SpecOf<RT>,
        Validators,
        Params,
        IdOfResourceType<RT[Covered]>
      >
    | ErrorType
  )[]
>) & { readonly [coveredTypes]?: readonly Covered[] };

export function wrapProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT> = ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  producer: CoveringProducer<RT, Covered, Validators, Params>,
): <Id extends IdOfResourceType<RT[Covered]>>(
  req: PartialConsumerRequest<Params, Id>,
  options?: { signal?: AbortSignal },
) => Promise<EntryForId<SpecOf<RT>, Validators, Params, Id>>;

// wrapBulkProducer: same substitution of `producer` for `producers`; its
// returned function's signature is UNCHANGED.

/** Record -> single function. Restores the 1.6.0 name 2.0 deleted. */
export function producerByIdType<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  producers: ProducersFor<RT, Covered, Validators, Params>,
): CoveringProducer<RT, Covered, Validators, Params>;

export function bulkProducerByIdType<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  producers: BulkProducersFor<RT, Covered, Validators, Params, ErrorType>,
): CoveringBulkProducer<RT, Covered, Validators, Params, ErrorType>;
```

Narrowing each result's `Id` to `IdOfResourceType<RT[Covered]>` bounds the
**primary** result to covered types only — tighter than 1.6.0, which typed
results over the whole `Spec`. Supplementals are unaffected: they are a separate
field typed over the full `SpecOf<RT>`, so a covered producer can still attach
supplementals for any registry type, as §6.4 requires.

`ProducersFor` / `BulkProducersFor` are kept as-is — they move from being the
wrapper's parameter to being the *helper's* parameter.

Both helpers take `cache` for two reasons: to infer `RT`, and — in the bulk
helper — to `classify` each request when splitting the batch. Each helper sets
`[coveredTypes]` to `Object.keys(producers)`; since that property holds a real
value, no cast or tagged-type stamping is involved.

### 3.3 Call-site shapes

```ts
// Sole-type cache: SHORTER than 2.0 as shipped.
wrapProducer(cache, opts, async (req) => ({ content, directives }));

// Multi-type, full mixed batch. The capability this design exists for.
wrapBulkProducer(cache, opts, async (reqs) => { /* reqs spans all types */ });

// Multi-type, per-type dispatch.
wrapBulkProducer(cache, opts, bulkProducerByIdType(cache, {
  story: async (reqs) => [...],
  collection: async (reqs) => [...],
}));
```

### 3.4 `bulkProducerByIdType` behaviour

Splits the incoming mixed batch by `cache.classify(req.id)`, invokes each
sub-producer concurrently with its own slice, and reassembles results
**positionally** into the caller's request order.

Positional is forced, not chosen: a batch can legitimately contain the same id
twice with different `params` (the suite already pins duplicate ids in
`getMany`), so id is not a routing key.

Each sub-producer's rejection is **caught** and written into that type's slots
as `Error` elements, so per-request error isolation survives the merge — it
lives in the sugar rather than in the wrapper.

A sub-producer that under-returns is **not** repaired or padded: the helper
leaves those slots absent in the reassembled array, so the wrapper's existing
under-return check (which rejects the whole invocation rather than risk
misaligned pairing) fires exactly as it does today. Silently substituting an
`Error` there would convert a contract violation into a per-request failure and
hide the bug.

Throws at construction on an empty record — the check §6.3 put in
`wrapProducer` moves here, which is now its only meaningful home.

## 4. What does not change

Stated explicitly to bound the change:

- The registry, `classify`, `SpecOf`, and the exactly-one-match contract.
- The **wrapped functions'** signatures, including their `{ signal }` parameter
  and the per-slot narrowing of their return types.
- Bypass requests skipping the cache read; the age-≤0 / clock-skew fix.
- `read`, `fetch`, and `store-entry` messages: still one per request, still
  attributed by classifying the request's own id.
- `store()` / `delete()` / after-close options.
- `wrapComputingProducer` / `wrapBulkComputingProducer`'s **public API**,
  including their branch records. Their branches route by **input**
  (`matchesInput` / `hashInput`), not by id, so they are a genuinely different
  shape and are not forced into this mold. They keep taking records.

  Their **internals must change**, though, and this is a trap for whoever
  implements it: both build an internal per-type record with
  `Object.fromEntries` and hand it to `wrapProducer` / `wrapBulkProducer`
  through a cast to `Parameters<typeof wrapProducer<…>>[2]`. That cast will
  keep compiling after this change while passing a plain object where a
  function is now expected — a runtime break with no type error. Each must be
  updated to feed its record through the matching `*ByIdType` helper instead.
  The existing computing suites are the regression net and must stay green.
- Producer results stay positionally paired; producers still take no
  `AbortSignal`; nothing chunks batches.
- **All existing export names.** The rename considered during design
  (`cachedFetcher` / `cachedBulkFetcher`) is dropped: it was motivated purely by
  the argument being a *record*, and with a single producer function
  `wrapProducer` is accurate again.

## 5. Consequences

### 5.1 Collapse granularity (bulk only)

The collapse key is `stableStringify(args)` over the producer call's arguments,
which today are `(resourceType, reqs)`. With one producer the key becomes
`(reqs)` — and since `resourceType` was always derived from the ids, dropping it
changes nothing by itself.

What changes is the *number of invocations*. Today: one per (trigger group ×
resource type). After: one per trigger group, because a group's requests now go
to a single producer call. Bypass, miss, and revalidation groups stay separate —
not because `trigger` is in the key (it is not), but because their request
arrays differ, bypass carrying `maxAge: 0` directives.

The cost is concrete: today two callers whose `story` sub-batches are identical
share that invocation even when their `collection` parts differ. After, one key
spans the mixed batch, so they share nothing. This is 1.6.0's behaviour.
Recoverable later *inside* `bulkProducerByIdType` using the already-exported
`collapsedTaskCreator`, but deliberately not in v1 — that would relocate the
complexity one layer down rather than remove it.

**`wrapProducer` is unaffected**: it handles one request, so there is no merge
and its keying is unchanged.

### 5.2 `NoProducerForResourceTypeError` becomes helper-only

The wrapper reads the covered set from `producer[coveredTypes]` instead of
`Object.keys(producers)`. When that property is absent — the bare-function case
— coverage is the whole registry by construction, so the error is
**unreachable**: every classifiable id has a producer. It stays reachable, with
identical before-any-cache-read timing, whenever coverage was narrowed by a
helper or by an explicit `Covered` type argument.

This is a genuine reduction in reachable failure modes for the common case, not
a weakening: the bare form cannot under-cover, because its parameter type must
accept every registry id.

### 5.3 Diagnostics (§6.5.3 amendment)

`produce` emits one message per invocation, whose `requests[]` may now span
resource types. `CacheProduceMessage.requests` is already typed per-request
(`{ resourceType, resourceId }[]`), so no type change is needed — but its
docstring's invariant, *"bulk producers … batch within one resource type, so all
elements share resourceType,"* is **deleted**. Subscribers must stop treating
`requests[0].resourceType` as the invocation's resource type.

## 6. Test plan

Contract tests, so the capability survives refactors:

1. **Full-batch delivery.** A two-type registry; `getBulk([story:1,
   collection:1, story:2])` calls the bare producer **exactly once**, with all
   three requests, in the caller's order.
2. **Per-type dispatch.** The same call through `bulkProducerByIdType` invokes
   the `story` sub-producer once with `[story:1, story:2]` and the `collection`
   sub-producer once with `[collection:1]`, and reassembles results into the
   caller's order.
3. **Error isolation in the sugar.** When the `story` sub-producer rejects,
   only the `story` slots settle `producer-error`; `collection` results are
   returned normally.
4. **Diagnostics.** One `produce` message per invocation, with `requests[]`
   spanning both resource types and each element carrying its own
   `resourceType`.
5. **Runtime coverage.** Via a helper covering a strict subset, an id of an
   uncovered type still throws `NoProducerForResourceTypeError` **before any
   store read** (assert with a store spy) — pinning that moving the covered set
   from record keys to `producer[coveredTypes]` preserved both the error and its
   timing. Its companion: through a bare function, no id of any registry type
   can produce that error.
6. **Compile fixtures** (`@ts-expect-error`, alongside the existing coverage
   fixtures): a bare function accepts every registry id; a function typed for a
   strict subset is **rejected**; a helper narrows `Covered` so an uncovered id
   is an error at the wrapped function's call site; an empty record throws at
   construction.
7. **Sole-type regression.** An existing sole-type suite converted to the bare
   form behaves identically, pinning that the common case is unaffected.
8. **Computing wrappers unchanged end-to-end.** The existing
   `wrapComputingProducer` / `wrapBulkComputingProducer` suites pass untouched
   after their internals are rewired through the `*ByIdType` helpers — the
   regression net for the silent-cast hazard in §4 of this doc.

## 7. Migration

Mechanical, and favourable in the common case:

- Sole-type caches — the majority of the monorepo's 53 cache constructions —
  drop the wrapper record: `{ visits: fn }` → `fn`.
- Multi-type sites wrap once: `{ a: f, b: g }` →
  `bulkProducerByIdType(cache, { a: f, b: g })`.

The monorepo migration staged on `claude/cache-upgrade-validators-e76cd6` must
be re-run over its 42 wrapper sites. Because the change is to the third
argument only, both edits are greppable by wrapper name.

## 8. Rollback

Additive at the type level in one direction only: reverting means restoring the
record parameter, which breaks bare-function callers. If this ships and proves
wrong, the revert is the inverse codemod (`fn` →
`{ <soleTypeName>: fn }`), which the registry makes derivable per call site.

## 9. Deferred, with triggers

- **`multiIdTypeBulkProducer`** (`{ covers, produce }` — partial coverage plus a
  full batch). Cut as YAGNI: total coverage now needs no helper, and the coverage-carrier
  machinery this design introduces makes adding it later purely additive.
  Trigger: a caller needs a full mixed batch over a strict subset of a registry.
- **Per-type collapse inside `bulkProducerByIdType`** (§5.1 of this doc). Trigger: evidence
  from the `produce` channel that duplicate cross-caller origin work is
  material.

## 10. Ratified implementation deviations

Four, all small; the contracts in §3 shipped as written.

1. **`producerByIdType` classifies too.** §3.2 says both helpers take `cache`
   "to infer `RT`, and — in the bulk helper — to `classify`". The single helper
   must classify as well: picking a sub-producer for a request has no other
   route to the request's resource type. So the double-classification note in
   §3.4 applies to both helpers, not just bulk.
2. **Both helpers throw `NoProducerForResourceTypeError` on an unreachable
   uncovered type.** Unreachable *through the wrappers*, which reject uncovered
   types first, but reachable if a helper's returned function is driven
   directly, so it fails loud rather than leaving result slots empty.
3. **`wrapBulkProducer`'s under-return message now counts filled slots**
   ("returned results for only N of M requests") instead of reporting the result
   array's `length`. Required by §3.4's no-padding rule: the helper reassembles
   into a preallocated array, whose `length` always equals `reqs.length` even
   when slots are holes, so the old message read "3 results for 3 requests" on a
   short return. The *check* was unaffected; only its wording was wrong.
4. **A sub-producer that rejects with a non-`Error` value is wrapped** in an
   `Error` carrying the original as `cause`, rather than written into result
   slots raw — a non-`Error` in a result slot would be read downstream as a
   successful producer result.

Consequence worth stating, since §2's finding 3 only implies it: the bare
whole-registry form gives up the per-branch **(id, content) correlation** the
record form has. A single producer's result type is the union over its covered
ids, so returning one variant's content for every id typechecks; there is no
runtime content check either. That, not just partial coverage, is a standing
reason to reach for `producerByIdType` on a multi-type registry — and it is
pinned by a fixture in `coverageTyping.test.ts`.
