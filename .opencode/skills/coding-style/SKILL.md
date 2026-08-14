---
name: coding-style
description: Enforces Rarebert's coding style conventions for refactors and method placement. Use when editing, refactoring, or adding methods/functions to scripts/ or lib/ modules.
---

# Coding Style Skill

## Purpose

Enforces structural conventions that keep Rarebert's modules readable,
diff-friendly, and resistant to duplication drift. Apply these rules any
time you edit, refactor, or extend a module in `scripts/` or `lib/`.

## 1. Targeted refactors

All refactors must be **targeted**. A refactor should address one concern:

- One binding, one import path, one method, or one tightly-coupled group.
- Do not sweep unrelated cleanups, renames, or reformatting into the same
  edit. Those belong in their own targeted commits.
- If a request says "fix X", edit the minimum surface area that fixes X.
  Leave neighboring code untouched unless it blocks the fix.
- Prefer a sequence of small, reviewable targeted refactors over one
  large restructuring pass. Use `make refactor` (see the
  `operate-multi-stage-refactor` skill) to pin baselines between stages
  when a refactor genuinely needs multiple steps.

## 2. New methods and functions go at the end

When adding a method to a class, or a function to a module, place it
**at the end** of the receiving class/module body:

- **Class methods** → append after the last existing method, before the
  closing `}` of the class.
- **Module-level functions** → append after the last existing function
  in the file.
- **Static vs instance** → preserve the existing grouping; a new static
  method goes after the last static method, a new instance method after
  the last instance method. If unsure, append to the very end of the
  class body.

This makes recency of addition visible in the source: a reader can scan
bottom-up to find what was added last, and diffs stay append-only rather
than splicing into the middle of a class.

Do **not** insert new methods alphabetically, by perceived importance, or
"next to related code". Recency wins over locality.

## 3. Destructive operations require a user warning

The user **must always be warned before** a destructive operation is
performed. No destructive action runs without explicit acknowledgement.

Operations considered destructive:

- **File deletions** — no unauthorised `rm`, `fs.unlink`, `git clean`,
  or any call that removes a tracked or working file. State what will be
  deleted and wait for confirmation before executing.
- **`git checkout` on a dirty tree** — never run `git checkout <ref>`
  or `git checkout -- <paths>` while the working tree has uncommitted
  changes. Check `git status` first; if dirty, warn the user and abort
  the checkout until the tree is committed or stashed with confirmation.
- **`git reset`** — never run `git reset --hard`, `git reset <ref>`
  moving HEAD backwards, or `git reset --soft` that discards staged
  work. Warn and require confirmation. Prefer non-destructive
  alternatives (`git revert`, `git stash`) and surface them to the user.

Rule of thumb: if an operation can lose uncommitted work, delete files,
or move HEAD in a way that hides prior commits, it is destructive. Warn
first, then act only on confirmation.

## 4. Partial-overwrite collisions during insertion

If you insert a function or method and discover that the edit
accidentally overwrote part of another existing declaration (a partial
collision — the new code landed on top of, or truncated, a prior
`function`, `class`, `method`, or `const` body), you **must pause
immediately**:

1. **Stop editing** — do not attempt to repair the collision silently
   or chain further edits on top of the damaged region.
2. **Prompt the user** — ask whether they want their editor opened on
   the conflicting line so they can undo the change themselves and
   review the inserted code. Surface the file path and the offending
   line number.
3. **On acceptance** — use the `open-in-editor` skill to open the file
   at the conflict and hand control back to the user for review.
4. **On refusal** — only then proceed to repair the collision yourself,
   re-reading the surrounding declarations to restore the overwritten
   content before continuing.

The user always gets the first chance to review a collision they did
not author. Never bury the damage in a follow-up edit.

## 5. Adjacent-module refactors trigger a library extraction check

Any time an adjacent module (a sibling in `scripts/` or `lib/`, or a
module reached through the import DAG) needs to be refactored, **before
duplicating or re-implementing**, evaluate recently added methods across
both modules for a shared abstraction:

1. **Survey** — Look at the most recently added methods (per rule 2,
   these are at the end of each class/module body) in both the current
   module and the adjacent module.
2. **Compare** — Do any of them perform similar operations? Same shape
   of input, same core algorithm, same side effect, differing only in
   caller-specific details?
3. **If yes → extract to a library module**:
   - Create or extend a module under `lib/` that holds the shared
     operation as a pure, parameterized function.
   - Adapt the function so it serves **both** the original and the next
     module's use cases — do not copy-and-paste then tweak one branch.
     Parameterize the caller-specific parts rather than forking logic.
   - Reintroduce the function to **both** original modules as an
     `import` from the new library module. Remove the per-module
     implementations.
4. **If no** → proceed with the targeted refactor as normal.

### Worked example

Module `scripts/foo.mjs` recently gained `summarizeFoo(rows)` (end of
class). An adjacent `scripts/bar.mjs` now needs `summarizeBar(rows)`.
Both reduce a row list to a summary object but differ in the field
projection.

- **Do** extract `summarizeRows(rows, projection)` into
  `lib/summarize.mjs`, then `import { summarizeRows }` in both
  `foo.mjs` and `bar.mjs`, passing the per-module projection.
- **Do not** copy `summarizeFoo` into `bar.mjs` and rename it.

## When to use

- The user asks for a "style" or "coding style" pass.
- You are about to add a method/function and need to know where.
- You are about to refactor a module that imports or is imported by
  another module you have touched recently.
- Run `audit-consistency naming` to verify placement conventions hold
  after edits that touch class bodies.
- You are about to perform a destructive operation (file deletion,
  `git checkout`, `git reset`) and need to confirm the warning rule
  applies.
- An edit collided with an existing declaration and you need to decide
  whether to hand the conflict to the user's editor for review.