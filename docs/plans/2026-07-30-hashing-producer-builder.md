# Hashed-input wrappers: a cache-free hashed-input producer

Supersedes the `branches`-record shape in
[§6.4 of the registry plan](./2026-07-28-resource-type-registry-and-diagnostics.md).
Same contracts (coverage, minted ids, supplementals); different carrier.

## The problem with the record

The shipped shape was `wrapHashedInputProducer(cache, options, branches)`, where
`branches` was a record keyed by covered resource-type name. It worked, but the
wrapper had a single `Input` type parameter shared across every branch, and that
had three consequences:

1. **Branches could not narrow their own input.** Inside a branch's `produce`,
   `input` was the whole union, so every multi-branch producer cast:
   `makeStory((input as StoryInput).id)`. There were 30 such casts in
   `wrapHashedInputProducer.test.ts`.
2. **Guards had to lie.** Because `matchesInput` narrowed to the shared `Input`,
   a "story" guard was typed `(i: unknown) => i is VInput` — claiming to prove
   the whole union. A guard proving only `StoryInput` was *rejected*.
3. **A workaround in the signature.** `Covered`'s constraint had to be `string`
   rather than `ResourceTypeName<RT>`, because a mapped type whose key parameter
   is constrained by another inference variable makes TS give up inferring the
   template's other variables — `Input` collapsed to `unknown` at every call
   site.

## What shipped instead

One options bag, two forms:

```ts
// one resource type: the two functions are the whole contract
const compute = wrapHashedInputProducer({ cache, hashInput, produce });

// several: a hashed-input producer, built with NO cache
const compute = wrapHashedInputProducer({ cache, hashedInputProducer });
```

```ts
const hashedInputProducer = hashedInputProducerByInputType<{
  story: HashedInputVariant<StoryInput, Story>;
  collection: HashedInputVariant<CollInput, Story[]>;
}>()
  .when((i): i is StoryInput => i.kind === "story", {
    name: "story",
    hashInput: (input) => `extract:story:${input.id}`,   // input: StoryInput
    produce: async (input) => ({ content: makeStory(input.id), directives }),
  })
  .when((i): i is CollInput => i.kind === "collection", {
    name: "collection",
    hashInput: (input) => `extract:collection:${input.ids.join(",")}`,
    produce: async (input) => ({ content: input.ids.map(makeStory), directives }),
  })
  .build();
```

Three properties fall out of this that the record could not have.

**Each `.when` is its own inference site.** That is the whole reason a chain
works where a record does not: `I` is inferred from the guard (argument 1), and
argument 2's declared type then contextually types `hashInput`/`produce`. So
`input` is the branch's own input, with no annotations and no casts, and a guard
proves only its own variant.

**`name` selects the variant; the guard is only the runtime dispatcher.** Two
variants may therefore be computed from the *same* input type (a summary and a
translation of one story) without becoming ambiguous, and a guard may prove a
*subtype* of the declared input. An earlier iteration derived the variant from
the guard's narrowed type by reverse lookup, which failed both cases: two
variants sharing an input made the lookup return *both* keys, so one `.when`
silently claimed coverage of a variant nothing produced.

**The producer needs no cache.** It is a value in its own right — buildable and
reusable before any cache exists — and the variant map's declared `output` is
what lets a branch be validated where it is written.

(The same treatment was then applied to `producerByIdType`/`bulkProducerByIdType`,
which now take the resource-type registry rather than a cache — see §11 of
[the by-id-type plan](./2026-07-30-single-producer-fn-and-by-id-type-sugar.md),
including why the tempting `Pick<RT, Covered>` signature is silently vacuous.)

## Where each check lives

| Check | Where |
| --- | --- |
| `produce` returns the variant's declared output | build time, at the branch |
| `input` is narrowed to the variant's input | build time, at the branch |
| a supplemental's `input` and `content` come from the same variant | build time |
| a second `.when` for a covered variant | build time (`Name` excludes `Covered`) |
| `.build()` with no branches | construction-time throw |
| minted-id type is inside the variant's resource type | at `new`-wrapper wiring |
| declared output matches the resource type's content | at wiring |
| variant names are registry resource types | at wiring |
| declared id-keyed spec is inside the registry | at wiring |
| minted id actually classifies to the branch's type | runtime, per call |

The wiring checks are surfaced through the wrapper's **return** type as named
problem objects (`{ ERROR; variant; expected; got }`), not through its parameter.
That is not a style choice: a conditional over a type parameter placed on the
parameter is resolved *before* that parameter is inferred, which reports every
branch as broken. In the return position everything is already inferred. (The
same failure mode, in the same codebase, drove the `singleTypeCacheOptions`
store-coverage check into `new Cache`; see §6.8.)

The runtime mint-check is retained deliberately even though the compile-time one
exists. Its whole value is catching a mint that arrives through a cast or an
untyped boundary — the same reasoning that removed `soleResourceType`, whose
narrowing was asserted and never enforced. It is what a branch `name` buys at
runtime: without one, the check degrades from "the story branch minted a
collection id" to "this id classifies to something".

## What the builder cannot know

A branch's result carries more than content: `validators`, `vary`, and id-keyed
supplementals are typed against `Validators`, `Params`, and the registry's spec,
none of which a cache-free builder has. They are therefore declared on the
builder, defaulted, and required to agree when the producer meets a cache:

```ts
hashedInputProducerByInputType<Variants, Validators, Params, IdKeyedSpec>()
```

`IdKeyedSpec` defaults to `never`, i.e. id-keyed supplementals are unavailable
unless the registry's `SpecOf` is declared. That is the one capability the
cache-free builder does not get for free; the single-producer form, which has the
cache, keeps it with no ceremony.

## What this deleted

- `ComputingBranch` (6 type parameters) and `checkedBranchEntries`.
- The `Covered extends string` inference workaround, and `Covered` as a wrapper
  type parameter at all.
- Two runtime throws that became structural: a matcher-less branch in a
  multi-branch producer is unconstructible (`.when` takes the guard
  positionally), and "matchesInput is ignored on a single-coverage wrapper" has
  no subject (the two-function form has no guard, and a one-`.when` builder's
  guard is consulted like any other).
- 30 `input as StoryInput`-style casts across the tests, and the explicit type
  arguments at ~16 call sites.

One runtime throw was ADDED, for the same reason the minted-id check exists —
the type-level rejection is bypassable by a cast: a duplicate `.when` for one
variant throws at build time. Silently keeping one would not merely shadow the
other, since dispatch takes the first matching branch while the
per-resource-type producer table keeps the last: the second branch's content
would be stored under the first branch's minted id.

## Alternatives probed and rejected

- **A per-branch factory** (`computingBranch<StoryInput>()({…})`) stamping the
  input as a phantom. Works, but a content mismatch reports on the branch slot
  rather than the offending line, and every call site pays the factory even
  single-branch ones.
- **An `Inputs` map on the wrapper itself.** Simplest of the map designs, but
  its single-branch form needs a map for one entry, and it cannot give a branch
  its own guard.
- **A variadic case list** (`byInputType(...cases)`). Per-case inference works —
  but the case objects have no contextual type, so `input` is silently `any`
  inside the bodies (`input.nonsense.deeply.missing` compiled). Two annotations
  per case fix it; the chain needs none.
- **A registry-blind helper returning `[hashInput, produce]` to spread.**
  Unsound: only the unions reach the wrapper, so swapping two branches' outputs
  (story mints `extract:story:` but produces `Story[]`, collection the reverse)
  compiles clean. Passing the producer as a *property* rather than spreading it
  is what lets the phantom survive to be checked.

## Verification

`tsc -b`, `oxlint`, and the full suite: 355 tests, 354 passing, 1 pre-existing
docker-dependent skip. New compile fixtures cover per-branch input narrowing,
wrong output for a variant, a duplicate `.when`, a guard for an undeclared
input, minting outside the variant's resource type, a variant name outside the
registry, correlated input-keyed supplementals, and the id-keyed spec
requirement. Runtime pins carried over unchanged, including the branch-named
mint-check errors, which now come from a one-`.when` builder rather than a
one-key record.

Routing has its own runtime pins, since each is reachable only by a cast or by a
guard the compiler cannot check: a sole `.when` branch's guard is consulted (in
both wrappers, and for supplementals) rather than being skipped because it is
the only branch; a guard that throws counts as a non-match so a later branch can
still claim the input, with the guard error(s) surfacing as the routing error's
`cause` when nothing matches; and a duplicate `.when` throws at build time. The
multi-branch BULK path is covered end to end too -- batch partitioning by
`matchesInput`, result alignment to the caller's order, per-item errors, and
cross-branch input-keyed supplementals.

## Post-implementation: renamed to "hashed input producer", and split out

**Date:** 2026-07-30, after the by-id-type registry change.

"Computing producer" never said what was actually distinctive about these
wrappers. What distinguishes them is not that they compute -- plain producers
compute too -- but that the **cache key is a hash of the input** rather than an
id the caller already holds. So the vocabulary is now "hashed input producer"
throughout, and the two names that had drifted apart ("computing" for the
wrappers, "hashing" for the builder) collapse into one:

| was | now |
| --- | --- |
| `wrapComputingProducer` / `wrapBulkComputingProducer` | `wrapHashedInputProducer` / `wrapBulkHashedInputProducer` |
| `WrappedComputingProducer` / `WrappedBulkComputingProducer` | `WrappedHashedInputProducer` / `WrappedBulkHashedInputProducer` |
| `ComputingProducerResult` | `HashedInputProducerResult` |
| `ComputingVariant` | `HashedInputVariant` |
| `hashingProducerByInputType` / `bulkHashingProducerByInputType` | `hashedInputProducerByInputType` / `bulkHashedInputProducerByInputType` |
| `HashingProducer`, `HashingProducerBuilder`, `BulkHashingProducerBuilder`, `HashingProducerMeta`, `HashingProducerProblems` | `HashedInputProducer`, `HashedInputProducerBuilder`, `BulkHashedInputProducerBuilder`, `HashedInputProducerMeta`, `HashedInputProducerProblems` |
| the `hashingProducer` option property | `hashedInputProducer` |

"Hashing" survives only where it names the *act* (bulk input hashing,
supplemental hashing, "derive the primary key by hashing"). Historical sections
of the earlier plans still name deleted symbols (`ComputingBranch`,
`ComputingProducerByInputTypeBuilder`, `ComputingProducerOptions`,
1.6.0's `computingProducerByInputType`) and were deliberately left: renaming
them would claim those symbols existed under names they never had. This file's
own name is likewise left as the date-stamped record of when it was written.

One prose casualty worth noting: a passage contrasted "computing wrappers" with
their use as "hashed-input producers" for key privacy. Under one vocabulary that
sentence became circular, so it was rewritten to draw the distinction it was
actually making -- hashing for **key privacy** vs. for expensive computation.

### File layout

Both sugar helpers moved back out of the wrappers, as they were before 2.0:

```txt
src/utils/producerByIdType.ts                  producerByIdType + bulkProducerByIdType
src/utils/producerByIdType.test.ts
src/utils/hashedInputProducerByInputType.ts    both builders
src/utils/hashedInputProducerByInputType.test.ts
src/utils/producer-errors.ts                   the errors both wrappers raise
```

The import graph is what makes this work, and it is acyclic by construction
rather than by luck:

- `producer-errors.ts` (`NoProducerForResourceTypeError`, `UnroutableIdError`,
  `UnroutableIdReason`, `rethrowUnroutableWithCacheName`) depends on neither
  wrapper, so `wrapProducer`, `wrapBulkProducer` and `producerByIdType` can each
  raise or map those errors without importing one another for it. `assertResourceTypeCovered`
  stays in `wrapProducer.ts`: it is coverage policy that happens to throw, not
  an error definition.
- `producerByIdType.ts` imports the {@link coveredTypes} carrier and the
  id-erased shapes from `wrapProducer.ts`, and is **type-only** against
  `wrapBulkProducer.ts`.
- `hashedInputProducerByInputType.ts` imports exactly one *type* from the
  wrapper (`HashedInputProducerResult`), so the only runtime edge runs the other
  way: the wrapper reads `builtBranches`. That symbol had to become exported for
  the wrapper to read it across a module boundary; it is deliberately NOT
  re-exported from `src/index.ts`, which is what keeps a built producer opaque to
  its holder.

Tests follow the same rule as the code: what is *about* a helper moved to its own
file (an empty record/chain is unconstructible; routing needs only the registry;
a duplicate `.when` throws), while coverage *enforcement* by the wrappers stayed
in `coverageRuntime.test.ts`. 355 tests before and after, 354 passing, 1
pre-existing docker skip -- the identical count is the check that the move
neither dropped nor duplicated a case.
