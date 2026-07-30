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
   hashed-input wrappers. Bulk's only form was one function over the whole union.
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
>) &
  // Optional when `Covered` is the whole registry (so a bare function needs no
  // ceremony); REQUIRED when it is a strict subset. See §5.2 of this doc.
  ([ResourceTypeName<RT>] extends [Covered]
    ? { readonly [coveredTypes]?: readonly Covered[] }
    : { readonly [coveredTypes]: readonly Covered[] });

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
>) &
  ([ResourceTypeName<RT>] extends [Covered]
    ? { readonly [coveredTypes]?: readonly Covered[] }
    : { readonly [coveredTypes]: readonly Covered[] });

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

Both helpers take `cache` for two reasons: to infer `RT`, and to `classify` —
the bulk helper to split the batch, the single helper to pick a sub-producer,
which has no other route to a request's resource type. Each helper sets
`[coveredTypes]` to `Object.keys(producers)`; since that property holds a real
value, no cast or tagged-type stamping is involved. That value is also what
satisfies the *required* branch of the carrier for narrowed coverage (§5.2 of
this doc), which is why partial coverage routes through a helper.

### 3.3 Call-site shapes

```ts
// Sole-type cache: SHORTER than 2.0 as shipped.
wrapProducer(cache, opts, async (req) => ({ content, directives }));

// Multi-type, full mixed batch. The capability this design exists for.
wrapBulkProducer(cache, opts, async (reqs) => { /* reqs spans all types */ });

// Multi-type, per-type dispatch. Takes the REGISTRY, not the cache
// (§11 of this doc).
wrapBulkProducer(cache, opts, bulkProducerByIdType(storiesResourceTypes, {
  story: async (reqs) => [...],
  collection: async (reqs) => [...],
}));
```

**Which to reach for.** The bare form is the right default for a sole-type cache
and for a genuine cross-type batch optimization. On a registry whose types have
*different content*, prefer `producerByIdType` / `bulkProducerByIdType` even at
full coverage: the bare form's result type is the union over its covered ids, so
nothing ties the returned variant to the id it was handed (§10 of this doc), and
the second call-site shape above elides that its body must return a distinct
object literal per branch — a single object with `content: Story | Collection`
is assignable to neither member. Per-type dispatch restores both properties by
splitting the function per branch.

### 3.4 `bulkProducerByIdType` behaviour

Splits the incoming mixed batch by `cache.classify(req.id)`, invokes each
sub-producer concurrently with its own slice, and reassembles results
**positionally** into the caller's request order.

Positional is forced, not chosen: a batch can legitimately contain the same id
twice with different `params` (the suite already pins duplicate ids in
`getMany`), so id is not a routing key.

Each sub-producer's rejection is **caught** and written into that type's slots
as `Error` elements, so per-request error isolation survives the merge — it
lives in the sugar rather than in the wrapper. A rejection with a non-`Error`
value is wrapped in an `Error` carrying the original as `cause`, since a
non-`Error` sitting in a result slot would be read downstream as a *successful*
producer result.

Those slots are typed `ErrorType` from the caller's side but a caught reason is
`unknown`, so this needs no separate cast only because the dispatching function
is already id-erased internally (`(LooseResult | Error)[]`) and re-typed once, at
the return, by the same cast the helper needs anyway for id erasure.

A sub-producer that under-returns is **not** repaired or padded: the helper
leaves those slots absent in the reassembled array, so the wrapper's existing
under-return check (which rejects the whole invocation rather than risk
misaligned pairing) fires exactly as it does today. Silently substituting an
`Error` there would convert a contract violation into a per-request failure and
hide the bug.

> **Superseded in review — see §12.** The no-padding conclusion held, but
> "leave holes for the wrapper to find" did not: the helper now rejects a count
> mismatch in its own slice, in either direction.

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
- `wrapHashedInputProducer` / `wrapBulkHashedInputProducer`'s **public API**,
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
  The existing hashed-input suites are the regression net and must stay green.
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
identical before-any-cache-read timing, whenever coverage was narrowed.

This is a genuine reduction in reachable failure modes for the common case, not
a weakening: the bare form cannot under-cover, because its parameter type must
accept every registry id.

**Amended after implementation.** This section originally also claimed the error
stayed reachable when coverage was narrowed "by an explicit `Covered` type
argument". It does not, and cannot: an explicit type argument narrows only the
type, while a bare function carries no runtime covered set — so the wrapper's
runtime coverage read as the whole registry while the type said otherwise. Under
the record form these could not disagree, because `Covered` and the runtime
check came from one source (the record's keys).

The types still banned uncovered ids at the wrapped function's call site, so the
divergence was reachable only by defeating them — a cast or a loosely-typed id.
But that is exactly the case `NoProducerForResourceTypeError` exists to catch,
and losing it there is worse than losing an error: the wrapper would hand the id
to a producer written for a different resource type, then store that producer's
content under the incoming id — a type-mismatched entry that outlives the
request and is later served to ordinary `Cache.get` readers.

Fixed by making the carrier **conditionally required** — optional when `Covered`
is the whole registry, required when it is a strict subset (§3.2 of this doc):

```ts
[ResourceTypeName<RT>] extends [Covered]
  ? { readonly [coveredTypes]?: readonly Covered[] }   // full set: optional
  : { readonly [coveredTypes]: readonly Covered[] }    // subset: required
```

So narrowed coverage cannot exist without runtime proof of that narrowing, and
the single-source property is restored by construction rather than by
convention. `wrapProducer<RT, "story">(cache, opts, bareFn)` is now a compile
error; the sanctioned routes are `producerByIdType` (which always supplies the
value) or attaching `[coveredTypes]` directly.

Four properties were probed before adopting this, since three of them could
plausibly have broken:

1. A bare function is still accepted with no ceremony.
2. `Covered` **still infers from the carrier** even though it also appears in
   the condition — the failure mode that would have silently defeated the
   helpers' narrowing.
3. Explicit narrowing with a bare function is rejected.
4. The deferred case verifies: a helper's result forwarded through an
   *unresolved* generic `Covered`, which is how the hashed-input wrappers forward
   theirs into `wrapProducer`.

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
6. **Compile fixtures** (`@ts-expect-error`): a bare function accepts every
   registry id; a function typed for a strict subset is **rejected**; the
   per-resource-type record the wrappers used to take is **rejected** (a
   surviving record overload would be exactly the compatibility layer this
   change exists to avoid); a helper narrows `Covered` so an uncovered id is an
   error at the wrapped function's call site; narrowing `Covered` by an explicit
   type argument alone is **rejected**, with a control proving the cause is the
   missing carrier and not the function's signature (§10.1 of this doc); an empty
   record throws at construction.

   These landed in their own `singleProducerTyping.test.ts` rather than beside
   the existing `coverageTyping.test.ts` fixtures, so that this change's tests
   could be written independently of its implementation. Worth folding together
   later.
7. **Sole-type regression.** An existing sole-type suite converted to the bare
   form behaves identically, pinning that the common case is unaffected.
8. **Hashed-input wrappers unchanged end-to-end.** The existing
   `wrapHashedInputProducer` / `wrapBulkHashedInputProducer` suites pass untouched
   after their internals are rewired through the `*ByIdType` helpers — the
   regression net for the silent-cast hazard in §4 of this doc.

## 7. Migration

Mechanical, and favourable in the common case:

- Sole-type caches — the majority of the monorepo's 53 cache constructions —
  drop the wrapper record: `{ visits: fn }` → `fn`.
- Multi-type sites wrap once: `{ a: f, b: g }` →
  `bulkProducerByIdType(cache.resourceTypes, { a: f, b: g })` (§11 of this doc;
  the first argument was `cache` as originally specified).

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

1. **`producerByIdType` classifies too.** §3.2 originally said both helpers take
   `cache` "to infer `RT`, and — in the bulk helper — to `classify`". The single
   helper must classify as well: picking a sub-producer for a request has no
   other route to the request's resource type. So the double-classification note
   in §3.4 applies to both helpers, not just bulk. §3.2 is corrected inline.
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
pinned by a fixture in `coverageTyping.test.ts` and now stated in §3.3.

This also invalidated a rationale comment that predated the change:
`requestPairedProducerUtils.ts` credited the *per-type producer records* with
being "the user-facing (id, content) correlation backstop", and used that to
justify two `as unknown as` casts. With the record no longer the wrappers'
parameter, that justification held only for the helper path, and the comment was
corrected. There is no runtime backstop and never was — the registry's `matches`
is an *id* predicate, and `resourceType<Content>()` is type-only for content, so
there is nothing to validate content against without adding content validators
to the registry.

### 10.1 Post-implementation amendment: the conditional coverage carrier

Adopted after implementation and after review of §5.2, which was wrong (see that
section for the full account and the four probed properties). The carrier changed
from unconditionally optional to **optional for whole-registry coverage,
required for a strict subset**, so type-level and runtime coverage can no longer
disagree.

Scope of the change: the two type aliases in §3.2, plus one typing fixture that
flipped from a positive assertion to `@ts-expect-error` — `wrapProducer<RT,
"story">(cache, opts, bareFn)` is now rejected, with a control proving the
rejection is the missing carrier rather than the function's signature (attaching
`[coveredTypes]` makes the identical function compile). No runtime code changed;
both helpers already set the property. The 336-test suite was unaffected.

## 11. Post-implementation amendment: the helpers take the registry, not the cache

**Date:** 2026-07-30, after §10.1. **Supersedes** the first parameter of
`producerByIdType`/`bulkProducerByIdType` as specified in §3.2 and shown in §3.3
and §7.

```ts
producerByIdType(cache.resourceTypes, { story: f, collection: g })
```

Motivation is the same one that made the hashed-input producer cache-free
(`2026-07-30-hashing-producer-builder.md`): it is backwards for the thing that
*feeds* a cache to need the cache in order to exist. Routing by id type needs
the registry's `matches` guards and nothing else, so a by-id-type producer is now
a value in its own right — buildable, drivable and unit-testable before any cache
exists, and reusable across caches over the same registry.

### 11.1 Why not `Pick<RT, Covered>`

The obvious purer signature — hand the helper only the slice it covers — does
not work, and the failure is silent:

```ts
producerByIdType<RT, Covered, …>(covered: Pick<RT, Covered>, producers: ProducersFor<…>)
```

`Pick<RT, K>` is `{ [P in K]: RT[P] }`: a mapped type keyed by `K` rather than by
`keyof RT`, so it is not homomorphic and TS's reverse-mapped-type inference does
not apply. `RT` then has no inference site at all (a constraint like
`Covered extends ResourceTypeName<RT>` is never one) and silently falls back to
`ResourceTypes` — whose index signature makes content `unknown`. Probed: `RT`
came back as `ResourceTypes`, and a `site_day` producer returning `content: 12345`
was **accepted**. `Covered` still infers from the producers' keys, so the shape
looks right while every per-type check — content, id narrowing, key-in-registry —
is vacuous.

Two shapes do work; both were probed with negative controls:

| | arg 1 = the full registry (**chosen**) | arg 1 = the covered slice, as its own registry |
| --- | --- | --- |
| `RT` / `Covered` inferred | ✅ / ✅ from the keys | ✅ / all of the slice |
| content + `req.id` narrowing | ✅ | ✅ |
| bad content / non-registry key rejected | ✅ | ✅ (at the wrapper) |
| cross-type supplementals | ✅ retained | ❌ lost — `SpecOf<slice>` is smaller |
| classification totality | ✅ whole registry | ❌ slice only: an uncovered-type id becomes *unclassifiable* rather than *uncovered*, and an overlap with an uncovered type is invisible |
| extra machinery | none | the return type must force `[coveredTypes]` **required** (probed: at whole-slice coverage the carrier goes optional, and an optional carrier is not assignable) |

The slice is the more appealing signature and it is the one that loses things, so
the registry won. A registry is not a cache — it is the literal the caller
already declared, inert data — so it satisfies the motivation without the
tradeoffs. It is a parameter rather than a type argument because it is the
inference site (see `Cache.resourceTypes`' docs for why a bare-`RT` member is
needed for that at all).

### 11.2 Classification moved to the registry; a cache-free error

`Cache.classify`'s loop moved to `classifyIdAgainst(resourceTypesEntries(rt), id)` in
the registry module, which **returns** an `IdClassification` outcome instead of
throwing: the registry has no identity to name in an error. `Cache.classify` is
now a thin renderer of that outcome into its existing cache-named errors — same
behaviour, one implementation, and the `Object.entries` cast that widened a
generic mapped type's values now lives in `resourceTypesEntries` alone. Both are
exported, because a hand-written multi-type producer needs exactly this and
should not have to reach for a cache either.

The helpers throw a new cache-free `UnroutableIdError` carrying `id`,
`coveredResourceTypes`, and a `detail` discriminated on `reason`
(`"uncovered" | "unclassifiable" | "ambiguous"`). Each wrapper catches it around
its producer call and re-throws the equivalent **cache-named** error, so a
wrapped producer's observable errors are exactly what §5.2 specified;
`UnroutableIdError` surfaces only on the direct-drive path, which is where the
cache name genuinely isn't available.

Rejected alternative: moving dispatch into the wrapper (it already classifies
once, so this would have removed the second classification pass and kept the
cache name naturally). Declined as premature optimization that would also
privilege our record shape over a hand-written multi-type producer. The
double classification §3.4 documents therefore stands.

### 11.3 Reachability of the re-throw

Through a wrapper the re-throw is reachable **only** when the registry the helper
was built from disagrees with the cache's own — the wrapper classifies first,
against the cache's registry, and rejects uncovered types before dispatching.
Structural divergence is a compile error (the producer's `RT` won't match the
cache's), so what remains is same-shape registries with different guard
*implementations*. Passing `cache.resourceTypes` rules it out entirely. A runtime
test builds exactly that divergence to pin the mapping.

### 11.4 Scope

`resolveCoveredSubProducer` (shared by both helpers; returns the sub-producer
rather than its name, so the membership test and the lookup are one own-property
read) and `rethrowUnroutableWithCacheName`. Both wrappers' `callProducerAndLog`
gained the catch. 57 call sites in the tests took `cache.resourceTypes`, as did
the hashed-input wrappers' two internal uses. Four new runtime tests: cache-free
single routing plus reuse against a later cache, cache-free bulk batch splitting,
direct-drive `UnroutableIdError` for the uncovered and unclassifiable reasons, and
the divergent-registry re-throw. No other contract changed.

## 12. Post-implementation amendment: a count mismatch fails where it is dispatched

Raised in review against §3.4's reassembly: the merge read `subResults[j]` and
skipped the slot when it was `undefined`, which made `undefined` the "no result
here" sentinel and left the diagnosis to `wrapBulkProducer`.

**Is `undefined` a legal producer result?** No, and not accidentally.
`RequestPairedProducerResult` distributes over the id union and every arm is an
object type; the element union a bulk producer declares is
`LooseResultFor<...> | ErrorType` with `ErrorType extends Error`. Neither arm
admits `undefined`, so a hole is unambiguously a contract violation rather than a
value. The sentinel was sound; it was merely resting on a premise it did not need.

**Why change it anyway.** `wrapBulkProducer` only ever sees the *merged* batch, so
the best error available to it is a batch total — "returned results for only 7 of
10 requests" — with no way to name the sub-producer that broke its contract. The
information needed to say which one is present only at the point of dispatch. So
the helper now compares each sub-producer's result count against the slice it was
given and throws, naming the resource type and both counts. A count comparison
also needs no premise about which values are legal.

**Both directions.** Over-return fails too, which is stricter than the wrapper —
it still does not police a bare producer's over-return. Extras mean the sub-producer
disagrees with the slice it was handed, so its positional pairing is no longer
trustworthy — a stronger signal than a bare producer over-returning against a
batch it received whole.

**What does not change.** Per-type error *isolation* is untouched: a sub-producer
that throws or rejects still settles only its own slots as `Error`s, and that path
builds one element per request by construction, so it never trips the new check.
Callers see the same outcome for a mismatch as before — a rejected invocation,
nothing stored, `produce` reporting error — just raised earlier and named. The
result array is now dense, so the filled-slots message ratified in §10 item 3 no
longer has a producer that can reach it through the helper; the wrapper keeps it for
bare producers, which remain able to return a short or explicitly-sparse array.

**Test consequence.** The wrapper's own under-return check was covered *only*
through the helper, which now intercepts it, so it would have gone silently
untested. `diagnosticsChannels.test.ts` drives a bare producer for it; the
cross-type blast-radius assertion that test also carried (a healthy sibling runs
but does not get to deliver) moved to `bulkProducerByIdType.test.ts`, where the
mismatch is now raised.
