---
name: module-and-api-design
description: "Use before adding a public API, a required argument, an option, a new file, a wrapper class, or shared code, and before reporting a change that moves, splits, or merges modules. Covers minimizing the API surface, reading the module first, the shape a module should take after a change, what a change report must disclose, and when to duplicate code that only looks identical."
---

# Module and API design

## Minimize Your API Surface — Promise Less, Demand Less

Every piece of code makes promises to its consumers (return types, supported operations, available fields) and demands from them (required arguments). Both constrain future evolution.

- **Promise only what's truly necessary.** Don't return extra data or support operations that aren't needed yet. The smaller the contract, the easier the code is to change.
- **Consider your consumers.** This package is a published library, so most consumers are outside your control. Every exported symbol, option, and documented behavior is a promise that only a major version can break. Keep promises small.
- **Demand only what's truly necessary — but understand _why_ it's a cost, so you can tell when it isn't.** Making an argument required (vs. optional-with-a-default) is only costly for two concrete reasons: (1) **backward-compatibility** — a new required argument breaks every existing caller, so this bites in proportion to how many callers exist and whether you control them; and (2) **portability/usability** — a required argument a caller can't produce locks the functionality out of contexts that lack it. When _neither_ bites, requiredness is nearly free, and the countervailing concern usually wins: **a default silently answers "what does a caller who didn't think about this want?", and for a capability whose absence quietly removes behavior (observability, a safety/deadlock guard, auth, durability) on the platform you actually run on, the didn't-think-about-it case is precisely the production bug.** So: if there are few/no existing callers to break, _and_ every target context can supply the argument (e.g. the module itself exports a ready-made no-op implementation, so opting out costs one explicit token rather than the ability to run), prefer **required with the no-op exported as an _explicit_ opt-out** over optional-with-a-silent-default. Flip back toward a default only when a cost genuinely applies — the API is already widely deployed, or no usable no-op can be shipped. Enforce a required capability at every layer that can be bypassed: the type, a boundary runtime check (naming the real impls and the explicit no-op), and an internal fail-loud `throw` instead of a `?? noop` fallback — "nothing was chosen" must never behave like "the no-op was chosen".
- **Nullable vs non-null is a real tradeoff.** Promising non-null simplifies consumers but limits evolvability. Default to nullable for fields that could plausibly be absent in future use cases; promise non-null when it saves significant consumer complexity and the field is stable.
- **Before you add an option, check whether callers can easily compose it.** If a caller gets the same behavior by wrapping their own function or object with a tool they already have, add no option. Write a doc note that names the composition instead. The exception is a helper whose whole point is to do that composition for the caller, usually because it is tricky to do correctly. (Real case: a proposed `maxConcurrentBatches` knob on a cache library was dropped. Callers that want a limit wrap their producer in `pLimit`.)
- **Make a function-valued public member `readonly`.** A public arrow-function property is reassignable unless you mark it `readonly`, and reassignment silently changes the behavior of every internal caller.
- **A missing prerequisite is not a reason to add a bypass method.** If the canonical path into a module is blocked only because setup data is missing (e.g., a service profile with no seeded auth method, so you "can't" authenticate), seed the prerequisite — don't add a new public method that skips the canonical path.

## Understand the Module Before Changing It

**Before making changes to a module, read its structure first.** Understand the existing files, their responsibilities, and how they relate to each other. Then make your changes fit the existing architecture — don't create new files when the logic belongs in an existing one.

- **Read the module directory** (`ls` or `Glob`) before writing any code. Know what files exist and what each one does.
- **Default to adding to existing files.** A new helper function belongs in the file that already contains related helpers. A new service method belongs on the existing service class. A new type belongs in the existing types file. Only create a new file when the responsibility is genuinely new and doesn't fit anywhere.
- **Respect encapsulation boundaries.** `src/index.ts` defines the public API. Don't export an internal helper from it, and mark a member that must stay reachable inside the package but is not public with `@internal`.
- **One file per clear responsibility, not one file per function.** Splitting a 50-line helper into its own file doesn't improve encapsulation — it just adds indirection. Files should represent coherent responsibilities, not individual functions.
- **Ask yourself before creating a file**: Does this responsibility already have a home? Would a teammate look for this logic in an existing file? If yes, put it there.

## Shape the Module After the Change, Not Only the Diff

A change can be correct and still leave its module in a worse shape. Before you report a change, review the files, classes, and folders it touched as a whole. The Structure angle of the `simplify` skill lists the checks: consumers, size and concerns, dependency direction, repeated idioms, placement, primitive meanings, and the smallest mechanism. Run it on your own; do not wait for the user to ask why a file grew. While you write the code, ask the questions in the `design-iteration` skill. Three design rules apply while you write the code:

- **A wrapper must fully replace what it wraps.** When you put a class around a dependency to add behavior, make it wide enough that the consumer holds only the wrapper. A consumer that holds both the wrapper and the raw dependency can bypass the added behavior. If the wrapper adds behavior to exactly one class, merge it into that class instead. Keep the original method bodies as private methods (for example `#getWithoutPending`), and make the wrapper's methods the public ones.
- **Keep a mechanism that serves one consumer out of the shared core.** If only one builder or variant needs a mechanism, let the code that creates that variant own it. Prefer existing object identity and lifetime (a `WeakMap` keyed on an object that already exists) over a new field or protocol that every shared layer must carry.
- **Group by role, not by "touches the feature".** Code that builds X and code that consumes X are different roles, even when both mention X. Put them in different modules, and let the dependency run one way.

## Report What Your Change Promises

A user reviews your report, not every line. So the report must disclose the decisions a reviewer would otherwise have to find in the diff:

- **Each widening of the public API, with its reason.** A member that became public "for convenience" is a promise to every consumer. (Real case: `normalizeParams` and `normalizeVary` became public during a class merge, and the report did not say so. The user found it and asked why.)
- **Each precondition that only a comment enforces.** Name the module that must uphold it and what breaks if it does not. Offer the type that would enforce it.
- **Each deliberate behavior difference from `main`.** Label it as intent, not as a bug. In a review, check the PR's description and commits for intent before you call a deliberate change incorrect.
- **The measured size change.** Give the line count of each touched file before and after. Do not estimate it.

## Duplicate Coincidentally-Identical Code

Two pieces of code that currently look the same should only share logic (base class, utility function) if they **must always evolve together**. DRY is a double-edged sword — automatic propagation of changes prevents bugs when consumers should stay in sync, but causes bugs when they shouldn't.

Key examples:

- **Create vs Update input types**: Never have Update extend Create. A new field on create shouldn't automatically be settable on update — force the developer to decide for each field.
- **Storage row shapes vs public types**: Never link a Store's row or column shapes to the public resource types. A storage format change needs an explicit migration; linking the types hides this requirement and turns the row types into lies.
- **Rule of thumb**: DRY up code you're confident should always evolve together. When in doubt, duplicate — three similar lines are better than a premature abstraction that couples unrelated concerns.
