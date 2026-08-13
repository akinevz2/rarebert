---
name: troubleshoot-stale-memos
description: Guides an opencode agent in identifying and removing stale memos from the memo system. Use when the memo sidecars contain outdated references (deleted imports, renamed files, pre-refactor leftovers) that pollute `check` reminders and mislead the next agent. Covers index-based dropping (`--drop`), full-module forgetting (`--forget`), and verification via `check`/`memo --all`.
---

# Troubleshoot Stale Memos

## Purpose

The memo system (`lib/memo.mjs`) stores per-module sidecar files
(`lib/foo.mjs.` — note the trailing dot) containing contextual notes
that surface as "Reminder" banners in `node index.js check` and
`node index.js memo --all`. Over the course of a refactor, memos
accumulate references to imports, files, or line numbers that no
longer exist. This skill provides a disciplined procedure for
identifying and removing stale memos while preserving ones that are
still relevant to the current state of the codebase.

## When to use

- `node index.js check` shows "Reminder" banners referencing imports
  or files that no longer exist (e.g. `unused-import: lib/foo.mjs:5
  (bar)` when `bar` is no longer imported).
- `node index.js memo --all` shows memos with `line 1386: throw err;`
  or other pre-refactor leftovers that don't reflect the current code.
- You've just completed a refactor pass (file rename, module merge,
  import cleanup) and want to leave a clean memo state for the next
  agent.
- The user asks to "clean up memos", "remove stale memos", or "drop
  old memo notes".

## The two removal tools

### `--drop <module> <indices>` — index-based removal (preferred)

Drops specific memo notes by 1-based index, preserving the rest. Use
this when a module has a mix of stale and relevant memos.

```bash
# Interactive: shows a MultiSelect of all memos on the module
node index.js memo --drop lib/foo.mjs

# Non-interactive: drop memos at positions 1 and 3 (1-based)
node index.js memo --drop lib/foo.mjs 1,3

# Non-interactive: drop the last memo
node index.js memo --drop lib/foo.mjs -1

# Non-interactive: drop first two and the last one
node index.js memo --drop lib/foo.mjs 1,2,-1
```

Indices are 1-based (positive). Negative indices count from the end
(`-1` is the last memo). Index `0` is invalid. When passing indices
non-interactively, the command shows the selected memos and asks for
confirmation before dropping (use `--yes` to skip confirmation if
available, or pipe `yes` if supported).

### `--forget <module>` — full-module removal (nuclear)

Removes ALL memos for a module by deleting the sidecar file. Use this
only when every memo on a module is stale (e.g. the file was deleted,
renamed, or completely rewritten and none of the old notes apply).

```bash
node index.js memo --forget lib/foo.mjs
```

**Warning:** `--forget` is destructive — it drops ALL memos for the
module, including relevant ones. If a module has 5 memos and only 2
are stale, use `--drop` with indices, not `--forget`.

## The cleanup procedure

### 1. SURVEY — List all memos with their positions

```bash
node index.js memo --all
```

This prints the memo DAG: each module with memos, indented under its
import-related ancestors. For each module, the memos are listed as
individual lines. Note the ORDER — that's the index order (1-based)
used by `--drop`.

To see just a flat list (oldest-first) without the DAG:

```bash
node index.js memo --all --all
```

Wait — `--all` already prints the DAG. For a flat list of ALL memos
sorted by lastModified, there isn't a separate flag; the DAG output
is the canonical view. To list memos for a single module, use:

```bash
node index.js memo lib/foo.mjs
```

This prints the memos for that module (flat, no ancestors).

### 2. IDENTIFY — Classify each memo as stale or relevant

For each memo, check whether its content still applies to the current
code:

- **`unused-import:` memos** — Check if the named import still exists
  in the source. If the import was removed during the refactor, the
  memo is stale. If the import still exists but is now used, the memo
  is stale (the integrity check would have re-flagged it). If the
  import exists and is still unused, the memo is relevant.

  ```bash
  rg "^import" <module-path>   # check current imports
  ```

- **`line N:` memos** — Check if line N still contains the referenced
  code. If the file was rewritten and the line number no longer
  matches, the memo is stale.

  ```bash
  sed -n 'Np' <module-path>   # show line N
  ```

- **`imports:` memos** — These record the import list at analysis
  time. If the imports have changed, the memo is stale.

- **`TUI-conversion:` memos** — These are task-tracking memos for an
  in-progress refactor. They're relevant if the conversion hasn't been
  done yet; stale if the script has already been converted to `TUI`.

- **Design/architecture memos** — These describe the module's
  intended structure. They're relevant if the structure hasn't
  changed; stale if the module was refactored to a different shape.

### 3. DROP — Remove stale memos by index

For each module with stale memos, identify the 1-based indices of the
stale notes and drop them:

```bash
# Interactive (recommended for single modules): MultiSelect
node index.js memo --drop lib/foo.mjs

# Non-interactive: comma-separated indices
node index.js memo --drop lib/foo.mjs 2,3
```

If ALL memos on a module are stale, use `--forget`:

```bash
node index.js memo --forget lib/foo.mjs
```

### 4. VERIFY — Check the memo state

```bash
node index.js check
```

The "Reminder" banners should now only show relevant memos. If stale
references still appear, repeat from step 2.

```bash
node index.js memo --all
```

Confirm the DAG no longer contains the dropped notes.

### 5. COMMIT — Persist the sidecar changes

Memo sidecars (`*.mjs.`) are tracked by git. After dropping stale
memos, commit the sidecar changes so the next agent starts clean:

```bash
make commit
```

Or manually:

```bash
git add -A
git commit -m "chore(memo): drop stale memos after refactor"
```

## Common stale memo patterns

| Pattern | Cause | Fix |
|---|---|---|
| `unused-import: lib/foo.mjs:5 (bar)` | Import `bar` was removed or is now used | `--drop lib/foo.mjs <index>` |
| `line 1386: throw err;` | Leftover from a merged/deleted file | `--forget lib/foo.mjs` (if all memos are this) |
| `imports: a; b; c` | Import list changed during refactor | `--drop lib/foo.mjs <index>` |
| `TUI-conversion: ...` on an already-converted script | Script was converted to `TUI` | `--forget scripts/foo.mjs` |

## Important notes

- **Never `--forget` a module that has a mix of stale and relevant
  memos.** Use `--drop` with indices instead.
- **Sidecar files are git-tracked.** Dropping memos modifies the
  sidecar file; commit the change so it persists.
- **The `check` command's "Reminder" banners read from sidecars.**
  After dropping stale memos, the reminders disappear — that's the
  confirmation that the cleanup worked.
- **Memos cascade through the import DAG.** A memo on `lib/a.mjs`
  will show up as an ancestor reminder for `lib/b.mjs` if `b`
  imports `a`. Dropping the memo on `a` removes the cascade.
- **`--forget` on a deleted file** (e.g. `lib/cli.mjs` after merge
  into `lib/module.mjs`) will print `module not found` — the
  sidecar file must be deleted manually: `rm lib/cli.mjs.`