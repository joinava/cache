# Computing wrappers: a cache-free hashing producer

Supersedes the `branches`-record shape in
[§6.4 of the registry plan](./2026-07-28-resource-type-registry-and-diagnostics.md).
Same contracts (coverage, minted ids, supplementals); different carrier.

## The problem with the record

The shipped shape was `wrapComputingProducer(cache, options, branches)`, where
`branches` was a record keyed by covered resource-type name. It worked, but the
wrapper had a single `Input` type parameter shared across every branch, and that
had three consequences:

1. **Branches could not narrow their own input.** Inside a branch's `produce`,
   `input` was the whole union, so every multi-branch producer cast:
   `makeStory((input as StoryInput).id)`. There were 30 such casts in
   `wrapComputingProducer.test.ts`.
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
const compute = wrapComputingProducer({ cache, hashInput, produce });

// several: a hashing producer, built with NO cache
const compute = wrapComputingProducer({ cache, hashingProducer });
```

```ts
const hashingProducer = hashingProducerByInputType<{
  story: ComputingVariant<StoryInput, Story>;
  collection: ComputingVariant<CollInput, Story[]>;
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
hashingProducerByInputType<Variants, Validators, Params, IdKeyedSpec>()
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
  no subject (the two-function form has no guard).
- 30 `input as StoryInput`-style casts across the tests, and the explicit type
  arguments at ~16 call sites.

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

`tsc -b`, `oxlint`, and the full suite: 347 tests, 346 passing, 1 pre-existing
docker-dependent skip. New compile fixtures cover per-branch input narrowing,
wrong output for a variant, a duplicate `.when`, a guard for an undeclared
input, minting outside the variant's resource type, a variant name outside the
registry, correlated input-keyed supplementals, and the id-keyed spec
requirement. Runtime pins carried over unchanged, including the branch-named
mint-check errors, which now come from a one-`.when` builder rather than a
one-key record.
