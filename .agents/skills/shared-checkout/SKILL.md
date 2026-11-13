---
name: shared-checkout
description: "Use before you commit, stage, or script an edit in a worktree that the user may also be editing, and before you commit an edit you did not make. Covers checking the index, staging only your own version of a file, safe edit scripts, and where review fixes go."
---

# Share the checkout safely

The user often edits and stages files in the same worktree while you work.

- **Read the index before you commit.** Run `git diff --cached --stat` before `git commit`. A file the user already staged goes into your commit otherwise. To commit only your own version of a file that the user also changed, stage it with `git hash-object -w <file>` plus `git update-index --cacheinfo`.
- **Never revert the user's edits.** If an edit you did not make is in the way, report it and ask.
- **Never read and write one path in one expression.** `open(p, "w").write(f(open(p).read()))` truncates `p` before it reads `p`, and the file is lost, with any uncommitted edits in it. Read the whole file into a variable first, then open it for writing. (Real case: an edit script emptied `src/cache/Cache.ts` and wiped the user's uncommitted edit. An anchor assertion that failed on the next step exposed it.)
- **Trace someone else's edit before you commit it.** When asked to commit an edit that you did not make, read the code downstream of it first. (Real case: removing a `& { date: Date }` requirement looked like a type cleanup. The lazy normalizer in `PendingResources` then reset the age of a dateless resource at its first read.)
- **Review fixes go on the PR they review.** Unless the user says otherwise, push fixes for a PR's review to that PR's branch. Do not offer to open a new PR.
