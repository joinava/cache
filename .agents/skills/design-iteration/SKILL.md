---
name: design-iteration
description: "Design-iteration passes that an agent runs over its own code before it reports a structural change as done. Use after adding or splitting a component, changing a contract or public API, rewriting a module, or moving responsibility between modules, and before listing a design smell as an accepted cost. Covers the pass loop, the question bank, and when to apply versus propose."
---

# Design iteration

A design is not done when it works and its tests pass. It is done when a pass
over it finds nothing simpler.

The failure this skill fixes: an agent ships a working design, then the user
asks "why does X need Y?" and the agent answers with the better design in one
turn. The agent had the knowledge. It did not ask the question. In one session
of this package's v4 work, the user started nearly all of several dozen
design rounds. Most rounds began with one of these questions:

- "Do we still need X?"
- "Why does Y care about Z?"
- "Is X derived from Y?"
- "Can't A just call B directly?"
- "Should this exist at all?"

Ask them yourself, before the user has to.

## When to run a pass

Run a pass before you report done, after any of these:

- You add a component, or split or merge components.
- You change a contract, a public API, or a type that other modules read.
- You rewrite a function or module.
- You move responsibility from one module to another.
- A pass applied a change. Run another pass, because one change often makes
  another piece obsolete.

Also run a pass when you are about to write "accepted cost", "acceptable
because it is private", "mostly theoretical", or "behavior change" about your
own design.

## The loop

1. Run the question bank below over every field, parameter, option, type,
   helper, and module boundary the change adds or touches.
2. Apply each fix that stays inside the task's scope.
3. Propose each fix that crosses scope, and let the user decide whether to
   widen it. Give the fix. Do not only name the smell.
4. Repeat from step 1 until a pass finds nothing, or after three passes.
5. Run `/simplify` on the result. Its Structure angle reviews the touched
   modules as a whole, and its report lists what a reviewer must see.

## Rules

- **If you could answer it when asked, it is yours to fix now.** When you can
  name the better shape, propose or apply it. Do not wait for the question.
- **A smell you list must come with a fix.** "This is worse than before",
  "no requirement forces this order", and "the names still differ" are the
  start of a change, not its report. (Real case: the agent listed four
  regressions against an earlier version, including an `any[]` result and
  mutable state that user code could reach. The user then had to request each
  fix one at a time.)
- **An API you own is not fixed.** Change the lower layer when that is the
  simpler design. Do not add a side channel in the consumer to avoid it. (Real
  case: the agent saved and restored a mutable variable around every call to
  its own `TaskSharer`, because adding a context argument "would change the
  sharer's API". The context argument deleted the save-and-restore in two
  places.)
- **Ask whether it should exist before you rename it.** A rename keeps the
  thing. (Real case: the agent renamed `Work.accumulated` to `autoBatch`. A
  later pass deleted the whole `Work` type, because the batcher already
  computed the only value that depended on it.)
- **Extraction does not remove state.** A helper extraction lowers nesting but
  keeps every variable. Check that your simplification deleted something.
- **Do not keep an order because the old code had it.** When the old shape
  forced a guard, a deferred, or a failure path, ask what requirement forced
  that shape. Remove the shape when no requirement does.
- **Read the prior art before you design its replacement.** When you replace a
  well-known library, read its source to learn its semantics, and run its own
  tests against your replacement. Write down each difference.

## Question bank

### Existence

- Does each field, parameter, option, and type have a reader? Delete it when
  nothing reads it, along with the type parameters it carries.
- Can a value be computed from other state, or from another value you also
  return? Derive it on demand, or state why it is stored.
- Did this change make an earlier workaround unnecessary? Look for guards,
  boxes, deferrals, and dedup steps that existed only for the removed problem.
- Is a helper or named type used in one place only? Inline it when it hides
  the flow or the contract.
- Does a public export have a real consumer? If it cannot honor a guarantee
  that every other entry point honors, remove it instead of documenting the
  gap or adding a hook.

### Responsibility

- Does this module import or name a type from a module that sits above it?
  The composer imports the parts. A part never imports its composer.
- Does a flag or parameter repeat a decision that the caller already expresses
  through another input? (Real case: a `background` flag only dropped the
  signal, and the caller already passed no signal.)
- Does a generic component encode one caller's modes, such as an
  `"automatic" | "direct"` parameter? Move that policy to the caller.
- Does a concern live on an object with a different lifetime? A lease that
  must last for a task's whole life belongs on the task, not on the queue.
- Does a method mostly touch another object's fields? Move it to that object.
- Does every call to X sit next to a call to Y? Fold Y into X.

### Composition

- Make a table of callers against features. If the table is sparse, split the
  component into blocks, and let each caller compose the blocks it needs.
  (Real case: one scheduler did batching and sharing. Store reads used only
  batching, single-request producers used only sharing, and only bulk
  producers used both.)
- Does any caller pay for a part that it switches off? It should not use that
  part.
- After a split, re-justify each option that came from the old component. Some
  options exist only because one object did two jobs.
- Is a special case a general mechanism in disguise? A task "without
  cancellation" is a task with no signal.

### API shape

- Does any caller work around the API? Signs are a pre-filter, `[0]!`,
  inferring a value the callee knows, or two settings to express one intent.
  A workaround is evidence of a callee defect.
- Does a callback receive information that its caller already has? Return
  data and let the caller act after the call.
- Is each fact at the level where it varies? A per-call fact belongs on the
  call, not repeated on each item.
- In a batch API, does one bad item affect the other items? It must not.
- Is each fixed collaborator a constructor option, and each per-call choice an
  argument?
- Does a flag keep the promise that its name makes? Fix the flag. Do not add a
  second option beside it.

### Invariants

- Does correctness depend on call order that only a comment states? Make one
  operation do both steps, or use a hold, lock, or refcount that makes the
  wrong order impossible.
- Did you make a field optional and then add an "impossible" throw? Model the
  new case as a union where the paths meet, and leave the old type unchanged.
- Can the API express an illegal combination of options? Make it untypeable.
- Does a doc comment describe a known gap? Look for the primitive that closes
  it before you accept it.
- Do you represent absence with a sentinel? Use `undefined` and an optional
  field. Do not export an internal constant so that another module can compare
  against it.
- Did you write `T | undefined` at the use site of a type parameter? Write
  `T`, and let a caller that needs `undefined` put it in the type argument. For
  an omittable trailing argument, default the type parameter to `void`:
  TypeScript lets a caller omit a trailing argument only when its type accepts
  `void`.

### Names

- Does each concept have one name across every layer, including the wrapper
  around a component? Trace a value from its entry point to its last use.
- Does each name refer to exactly one concept?
- Does a name describe what the thing is, or only its mechanism or first use?
- Does a function's name match what it takes and every effect it has? A name
  like `flush` must cover a permanent mode change, if the method makes one.

### Baseline

- Diff the rewrite against the base branch. For each lost name, log, comment,
  helper, `async`, or assertion, confirm that the change needs it gone.
- Did a refactor onto a new abstraction drop an output that callers had, such
  as a log field or a metric? Extend the abstraction to expose the fact. Do not
  report the loss as a behavior change.

### Verifiability

- Before you propose a design, write the call trace for two or three
  interleaved calls, including the edge modes. Two design errors in the cache
  work appeared only when the user asked for pseudo-code.
- Are `map`, `filter`, and `flatMap` callbacks free of side effects? Decide
  first, then act.
- Is each acquire paired with its release on every path, close enough that a
  reader can check it line by line?

## Apply versus propose

Apply a fix in the same task when it stays inside the files and contracts the
task already changes. Propose it with a concrete fix when it edits a module
the task never named, turns a test-only change into a production change, or
changes a public contract the user has not asked to change. In both
cases, say what the pass found.
