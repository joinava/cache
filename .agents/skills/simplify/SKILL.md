---
name: simplify
description: "Review the changed code for reuse, simplification, efficiency, altitude, state/docs-auditability, baseline and naming, and the structure of the modules it touches, then apply the fixes and repeat until a pass changes nothing. Quality only — it does not hunt for bugs; use /code-review for that. Invoke with /simplify, and run it before every commit, including pure moves and renames."
---

# Simplify

`/simplify → 7 cleanup agents in parallel → apply the fixes → repeat until a pass changes nothing`

You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, altitude, state/documentation,
baseline and naming, and module-structure issues, then fix what you find. Do not look for correctness
bugs — that is what `/code-review` is for.

Run it before every commit, including a commit that only moves or renames code.
A move changes dependency direction and placement, which the Structure angle
reviews. Skipping it on "just a move" is how a whole round of structural
problems reached the user unflagged. (Real case: joinava/cache PR #27. In the
segment where every commit ran this review, reviewer agents found a variant
flag, a dropped count check, dead paths, and duplicate mechanisms. In the next
segment the agent skipped it on every commit, and the user had to find a
780-line function, wrong-direction imports, and misplaced files.)

This skill is the reviewer's side of the `design-iteration` skill. That skill
holds the questions an author asks while writing the code. This skill checks
the result. Run both: a review does not replace asking the questions while you
design.

## Phase 0 — Gather the diff

Run `git diff $(git merge-base origin/main HEAD)` to get the unified diff
under review. It holds the branch's commits and its uncommitted changes to
tracked files, because the review often runs before the commit. Do not diff
against `@{upstream}`: a pushed branch tracks its own remote copy, so that diff
is empty. Also add each untracked file the task created
(`git ls-files --others --exclude-standard`) to the scope as a whole-file
addition. Without that step, a new module skips the review. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope for every
angle except Structure. The Structure angle reviews the whole files, classes,
and folders that the diff touches.

Record the line count of each touched file (`wc -l`). Phase 3 reports the
change against it.

## Phase 1 — Review (7 cleanup agents in parallel)

Launch **7 independent review agents** via the Agent tool, all in a single
message so they run concurrently. Pass each agent the diff and one of the seven
angles below. Each returns its findings with `file`, `line`, a one-line
`summary`, and the concrete cost (what is duplicated, wasted, or harder to
maintain).

### Reuse

Flag new code that re-implements something the codebase already has — Grep
shared/utility modules and files adjacent to the change, and name the existing
helper to call instead.

### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.

Also flag what a change leaves behind:

- A dead path, a parameter that only ever gets one value, or a second
  mechanism that does the job of the first (for example a tracker plus a
  wait loop that compensates for it).
- A literal that repeats across files. Give it one named constant.
- After a merge of two classes or modules: every member that only forwards,
  copies, or re-tracks what the other side already does. Delete it.
- Copied logic that differs from its source. Diff the copy against the
  original and name each check it dropped. (Real case: a scheduler copied
  from `Batcher#send` left out the result-count check, so an empty result
  resolved to `undefined` instead of a contract error.)

**Counter-check: a helper must not hide control flow.** Flag a new helper
that contains an early return, a swallowed error, or an abort check that a
reader of the call site needs to see. Extract a helper only when it makes
the code more readable and predictable at the use site, by replacing inline
logic with a helper that performs a logical, independent unit of work and
uses a clear name. (Real case: `#publishReadFailed` silently returned when
the signal was aborted. The user re-inlined it, because the hidden abort
handling was more confusing than the duplication it removed.)

### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.

### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.

Also flag **comment-enforced invariants across call sites**: an invariant
enforced per-site whose comment says future sites "must remember" to
re-apply it (a rejection funnel, a guard, a registration step) is a
finding, not documentation — comments don't fire in CI. Demand a
structural funnel (one guarded entry helper every site must pass through)
or a test that enumerates the call sites/entry points and asserts the
invariant generically. (Real case: a review noted "a future public async
entry point must remember the funnel — only a comment says so"; the very
next entry point added forgot both the funnel and the shutdown guard, and
shipped in the same PR.)

Also flag **preconditions enforced only by a comment** in a contract
between two modules: "callers must pass an already-completed request". Ask
whether a type (a brand, with `Tagged` or a class type with a `#private` field) can carry it. Verify a brand
with a type probe before you rely on it: a `type-fest` `Tagged` brand
survives an object spread, so it cannot prove object identity and has other
limitations. For example, in:

```ts
declare const y: Tagged<{ readonly a: string }, "Y">;
const x = { ...y };
x.a = "Something unvalidated";
```

`x` still has the `"Y"` tag, _even though `x.a` no longer has the value that
the function attaching the brand (presumably) checked_.

Also flag **call-order rules and "impossible" throws.** An API that works only
if the caller calls A before B, and a field made optional with a throw for the
case that "cannot happen", both let the code express a wrong state. Ask for one
operation that does both steps, a hold or refcount that makes the wrong order
impossible, or a union at the point where the paths meet.

### Baseline & naming

Compare the change with its base branch, and check its vocabulary.

- **Losses from a rewrite.** For each name, log, comment, helper, `async`, or
  test assertion that the diff removes, confirm that the change needs it gone.
  When a refactor onto a new abstraction drops an output that callers had
  before, such as a log field, do not blindly accept it as a "behavior change"
  when the new abstraction could expose the missing fact. Assess whether
  bringing back the old behavior is necessary or worth the added complexity,
  and flag it if you're unsure. (Real case: a rewrite
  onto `TaskSharer` dropped the task key and the start reason from every log.
  The agent reported this as a behavior change. One small return field
  restored them.)
- **One concept, several names.** List the nouns that the diff adds or
  touches. Flag a value whose name changes as it passes through layers, a name
  used for two concepts, and a wrapper that names an operation differently
  from the component it wraps. (Real case: one boolean was `automatic`,
  `accumulated`, `autoBatch`, and `autoBatched` in four layers.)
- **Names by mechanism or first use.** Flag a name that describes one call
  site or how something works, not what it is. Flag a function name that does
  not cover all of the function's effects, such as a `flush` that also makes a
  permanent mode change.

### Structure (the touched modules, not the diff)

A diff can be clean while the module it lands in has outgrown its shape.
Review each file, class, and folder that the diff touches as a whole. Check:

- **Consumers.** List the production importers of each class, helper, and
  wrapper. One importer means the boundary must earn its place: name what it
  hides from its consumer, or propose merging it into that consumer. A
  wrapper that adds behavior to exactly one class often belongs inside that
  class.
- **Size and concerns.** Flag a function longer than about 300 lines, or one
  that interleaves 3 or more concerns (for example diagnostics, abort
  handling, batching, and shutdown). Propose a split:
  - Separate a pure decision from the effects that carry it out.
  - Return a record from each branch instead of calling recorder closures
    that push into shared arrays.
  - In a factory closure, list each inner function that reads little or no
    closure state, and move it to module level.
- **Dependency direction.** List each import that crosses a folder. Ask
  whether the lower layer should know about the higher one. "There is no
  cycle" and "it is type-only" do not answer that question. Move a type that
  both sides need to the layer that both sides already depend on. Also flag a
  generic component that encodes one caller's modes, such as an
  `"automatic" | "direct"` parameter.
- **Caller policy in the callee.** Flag a flag or parameter that repeats a
  decision the caller already expresses through another input. (Real case: a
  `background` flag only dropped the signal, and the caller already passed no
  signal.)
- **Caller workarounds.** Read each caller of a changed API. A pre-filter, a
  `[0]!`, an inferred value that the callee knows, or two settings that
  express one intent is evidence of a callee defect. Name the callee change
  that removes the workaround. (Real case: a bulk call failed when one
  request's signal had aborted, so its caller pre-filtered the requests. A
  test even named the behavior as intended.)
- **Repeated idioms.** Grep the repository, not only the diff, for the idiom
  the change uses: a set of promises plus a drain, a closed-state check, an
  adapter shim. At 3 or more copies, propose one named abstraction and
  migrate each copy that must evolve with the others. Leave a copy that only
  looks the same, as "Duplicate Coincidentally-Identical Code" in the
  `module-and-api-design` skill explains. After you add an abstraction, grep for hand-written
  copies of the pattern that remain.
- **Placement.**
  - Put a type or an error next to its only owner or thrower.
  - Use a shared types folder only for contracts that two or more modules
    use, or that an outside implementer writes against.
  - Flag grab-bag files (`errors.ts`, a flat `utils/`) that collect
    unrelated items.
  - Name a folder after a domain concept, not after one class. Merge two
    folders that serve one concept.
  - When a change adds a cluster of related files to a grab-bag folder,
    propose a folder for them.
- **Primitive meanings.** Flag a `number` or `string` that carries a unit, a
  clock, or a provenance that a mix-up would break, such as a
  `performance.now()` timestamp. Propose a branded type. Then look for
  runtime type checks that the brand makes unnecessary.
- **The smallest mechanism.** For each new option, field, or protocol, check
  whether callers can compose a tool they already have instead (wrapping a
  producer in `pLimit`, or keying a `WeakMap` on an object that already
  exists). Prefer no new surface plus a doc note. The same holds for a new
  flag, mode, sentinel, hook, or backstop: check whether reshaping an existing
  operation or type gives the same guarantee. (Real case: a proposed
  `maxConcurrentBatches` option was dropped, because callers can wrap their
  own producer in `pLimit`. A proposed request-context field was replaced by
  a `WeakMap` from the request object to its input.)

(Real case for this whole angle: joinava/cache PR #27. The user asked for
more than 20 changes of these kinds by hand. Examples are deleting a
`RequestScheduler` that had one consumer, splitting `wrapProducer` into single
and bulk variants, splitting a 780-line client function into decide and
execute steps, moving builder types out of the wrapper, and extracting
`PendingPromisesTracker` from 8 hand-written copies.)

### State & docs (auditability)

Audit every field, cache, index, ledger, and module-level structure the diff
adds or touches, asking: could someone coming to this code fresh — with no
domain familiarity — tell WHY it exists? For each one, classify and flag:

- **Load-bearing state whose docs only say WHAT it is.** The comment must
  state why the state is needed at all — the invariant or capability that
  dies without it, why it can't be derived on demand, and (where non-obvious)
  when it is expected to be inert. "The providers under construction" is a
  what; "cycle _timing_ is a runtime property no static validation can
  answer, so the chain must exist at resolution time" is a why.
- **Derived state posing as essential.** Anything computable from other state
  (indexes keyed differently, precomputed sets, mirrored maps, counters) must
  either (a) carry an explicit justification — what it derives from, why it's
  materialized rather than computed on demand, and why that's sound (usually
  "inputs frozen after X") — or (b) be flagged for **deletion**, replaced by
  on-demand computation. The bar for keeping it is high: a real, named cost
  on a path that actually runs hot. "It felt wasteful to recompute" on a
  once-per-startup or once-per-construction path is not compelling.
- **Caches without a soundness sentence.** Every memo needs one line saying
  why a stale entry is impossible (or how invalidation works). A cache whose
  correctness depends on discipline elsewhere, undocumented, is a finding.
- **Unconditional mechanisms whose inert cases aren't named.** When a
  mechanism runs for every X but only matters for some X (kept uniform for
  simplicity or as a fail-loud backstop), the docs should say so explicitly —
  otherwise a fresh reader either assumes it's always load-bearing or
  "optimizes" it away.
- **Tiebreaks and normalization for impossible states.** A tiebreak,
  "first wins" rule, dedupe, or reconciliation step for a state the
  producer promises never to create means the data model _permits_ an
  illegal state — the fix is usually a stricter type (a Map keyed by the
  thing that must be unique; a discriminated union), after which the
  tiebreak deletes itself.
- **Memos whose argument carries more than the cache key.** A memoized
  function that accepts a richer argument than it keys on (e.g. takes a
  `{provider, owner}` pair but keys on `provider`) is one
  mismatched-caller away from silently poisoning the cache. Make the
  argument domain equal the key domain and derive the extra data inside
  the memoized computation. A key that only normalizes the argument (sorted
  keys, dropped `undefined` properties, a canonical casing) is fine.
- **Docs that a behavior change or a move made false.** Grep for every doc
  comment, README line, test comment, and CHANGELOG entry that describes the
  old behavior. Re-read each doc sentence that a merge or move carried over:
  it described the old context. Check each `{@link}` target in moved code,
  and check that a public doc does not link to an unexported symbol. Flag a
  visible behavior change that has no CHANGELOG entry.
- **Intentional behavior with no stated reason.** When a reviewer is likely
  to ask "is this intentional?" (a Store read that runs even after another
  source answered, a condition that looks unconditional), the doc comment
  must give the reason before anyone asks.

Findings name the field, its classification (load-bearing / derived-kept /
derived-delete), and either the missing WHY (drafted) or the on-demand
replacement.

## Phase 2 — Apply the fixes

Wait for all seven agents to complete, dedup findings that point at the same
line or mechanism, and fix each remaining one directly. Skip any finding whose
fix would change intended behavior, require changes well outside the reviewed
diff, or that you judge to be a false positive — note the skip rather than
arguing with it. A structural finding is not a reason to skip on its own. Skip
it as conflicting with the user's choices only when it contradicts a decision
the user stated, and name that decision. For derived-state deletions, the
existing test suite must pass unchanged — if behavior shifts, the state was load-bearing and the right
fix is upgrading its docs instead.

Structure findings are often larger than the diff. Use these rules for them:

- **Apply it** when it stays inside the modules the task already changes, and
  it changes neither behavior nor the public API. Examples are moving a
  closure-free helper to module level, co-locating a type with its owner,
  and migrating copies of an idiom to an abstraction the change adds.
- **Propose it** when it crosses into a module the task never named, changes
  the public API, or splits or merges a public class. Give the current shape,
  the proposed shape, and what it deletes. Do not wait for the user to ask
  why a file grew. Let the user decide whether to widen the scope.

After a refactor that moves tracking, guards, or error handling, run a
mutation check on each moved guard: remove it, and confirm that a test fails.
A surviving mutation is a test gap. Add the test.

## Phase 3 — Repeat, then report

A fix changes the code that the next review sees. Merging two classes exposes
forwarders. Splitting a function exposes closure-free helpers. Adding an
abstraction exposes hand-written copies. So one pass is not enough.

1. Run Phases 1 and 2 again on the result. Scope the next pass to the code
   that the last pass changed, plus the modules it touched.
2. Stop when a pass yields no fix that you apply, or after 3 passes.
3. Write each improvement that you defer as a `TODO` at the code it concerns,
   when that code is inside the task's scope. A deferral that lives only in
   chat is lost at the next session. A proposal that crosses scope goes only
   in the summary: adding a `TODO` edits that module too, so it waits for the
   user's approval like the fix itself.

Finish with a summary that includes:

- The fixes per pass, and the findings you skipped, each with its reason.
- The Structure proposals that wait for the user.
- The line count of each touched file before and after. Measure it; do not
  estimate it. A "simplification" that adds lines must say what it bought.
- Each widening of the public API, with its reason.
- Each precondition that only a comment enforces.
