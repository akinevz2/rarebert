---
name: operate-multi-stage-refactor
description: Guides an opencode agent or developer in orchestrating a multi-stage refactor by integrating the `make refactor` (scripts/refactor.mjs + lib/bindings.mjs) and `make memo` (scripts/memo.mjs + lib/memo.mjs) subsystems into a single disciplined lifecycle — snapshot bindings, edit code, detect damage, auto-generate memos, commit, cleanup stale memos, repeat. Use when planning or executing a multi-step refactor of rarebert's scripts/.
---

# Operate Multi-Stage Refactor

## Purpose

Orchestrates a disciplined multi-stage refactor by chaining two subsystems:

- **Refactor subsystem** (`scripts/refactor.mjs` + `lib/bindings.mjs`, `make refactor`) — the ANALYSIS: snapshots the binding registry, measures drift after edits, simulates blast radius, and reconciles stale notes post-commit.
- **Memo subsystem** (`scripts/memo.mjs` + `lib/memo.mjs`, `make memo`) — the MEMORY: sidecar files per module that persist contextual notes and cascade through the import DAG as "Reminder" banners.

The lifecycle pins a known-good baseline, lets edits break imports, measures the damage, records memos describing what broke and what to fix, commits, then drops stale pre-stage memos so notes do not accumulate across stages.

## When to use

- The user asks for a "multi-stage refactor", "stepwise refactor", "refactor in stages", or describes a refactor too large for a single commit.
- You need to preview the blast radius of moving/renaming/extracting bindings before editing.
- You want damage reports plus auto-generated per-module memos to guide repairs.
- You are reasoning about `refactor snapshot|damage|select|cleanup` or how `make memo` integrates with `make refactor`.

## The multi-stage lifecycle

Each stage is one pass through the cycle. Loop back to step 2 for the next stage.

1. **PREPARE** — Get a clean working tree so the baseline pins to a clean commit:
   ```bash
   make commit
   ```

2. **SNAPSHOT** — Capture the binding registry + current memo state as a git note on HEAD (`refs/notes/refactor`). Refuses on a dirty tree. Defaults to `refactor snapshot` when no baseline exists:
   ```bash
   make refactor
   # equivalent: node index.js refactor snapshot
   ```

3. **PLAN (optional)** — What-if blast-radius analysis BEFORE editing. Records a memo on the source module noting the simulated change and affected files:
   ```bash
   node index.js refactor select --select <bindings> --from <file> [--to <file>] --op <move|rename|extract>
   ```

4. **EDIT** — The developer or agent edits the code. Imports may break; that is expected and measured in the next step.

5. **DETECT** — Diff current bindings vs baseline. Emits a damage report (broken imports / relocated bindings) and auto-generates per-module memo summaries via opencode:
   ```bash
   node index.js refactor damage [--format markdown|json|prompt] [--model <id>] [--no-memos]
   ```
   Use `--format prompt` for an LLM-ready repair job spec. Use `--no-memos` to skip auto memo generation.

6. **FIX** — Repair the broken imports using the damage report and the generated memos as guidance.

7. **INSPECT** — Review the current memo state. Auto-generated damage memos now sit alongside pre-existing ones:
   ```bash
   make memo                       # interactive: choose module, enter memo
   node index.js memo --all        # print all memos flat, oldest-first
   node index.js memo --log        # list memo snapshots in refs/notes/memos
   ```

8. **COMMIT** — Commit the refactor + any new memo sidecar files. HEAD moves forward by one:
   ```bash
   make commit
   ```

9. **CLEANUP** — Drop stale pre-snapshot memos on affected modules by matching content against the baseline memoState. Keeps the new damage-generated summaries. Defaults to baseline `HEAD~1` since HEAD moved forward:
   ```bash
   node index.js refactor cleanup
   ```

10. **PERSIST (optional)** — Snapshot memo sidecars to `refs/notes/memos`. `--fresh` clears working sidecars for a clean slate before the next stage:
    ```bash
    node index.js memo --commit [--yes] [--fresh]
    ```

11. **REPEAT** — Loop back to step 2 (snapshot). The new baseline captures the post-refactor state.

## The role of each subsystem

### Refactor — the ANALYSIS

| Subcommand   | Purpose                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `snapshot`   | Pin binding baseline + memo state as a note on HEAD. Clean tree only.    |
| `damage`     | Diff current vs baseline; emit report; auto-generate per-module memos.   |
| `select`     | What-if blast radius for move/rename/extract; records a blast-radius memo.|
| `resolve`    | Walk the import tree and print all resolved bindings (no snapshot/diff). |
| `cleanup`    | Post-commit: drop stale pre-snapshot memos on affected modules.          |

Options: `--entry <file>` (default `scripts/`), `--baseline <ref>` (default `HEAD`), `--format json|markdown|prompt`, `--select <bindings>`, `--from <file>`, `--to <file>`, `--op move|rename|extract`, `--model <id>`, `--no-memos`, `--verbose`.

No-args path: if a baseline note exists on HEAD/ancestor → `refactor resolve`. If no baseline → `refactor snapshot`.

Library: `lib/bindings.mjs` — `resolveBindings(entry)` walks the import tree and delegates language-specific parsing to `lib/supports/lang{ext}.js` via `lib/languages.mjs`. Exports `saveSnapshot`, `detectDamage`, `whatIf`, `generateDamageMemos`, `recordBlastRadiusMemo`, `cleanupMemos`. Never branches on language name.

### Memo — the MEMORY

Memos are sidecar files (module path + trailing dot, e.g. `scripts/refactor.mjs.`) storing JSON `{ name, content: [string...], lastModified }`. They cascade through the import DAG: when a module runs, memos from its transitive imports surface as "Reminder" banners.

| Operation                         | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| bare (no flags)                   | Interactive: choose a module, enter a memo.                    |
| `--add <path> <memo...>`          | Non-interactive add.                                           |
| `--all`                           | Print all memos flat (oldest-first); with file args, filter to those modules' ancestor traversal. |
| `--commit [--yes] [--fresh]`      | Snapshot all memos to `refs/notes/memos`. `--fresh` clears working sidecars. |
| `--log [files...]`                | List memo snapshots, optionally filtered by module.            |
| `--recall <ref> [files...]`       | Restore memos from a git-notes snapshot, unified with sidecars.|
| `--drop <module> [indices]`       | Drop specific memos by 1-based index.                          |
| `--forget <module...>`            | Remove ALL memos for one or more modules (deletes sidecar).    |

Library: `lib/memo.mjs` — `memo.remember(moduleRef, content)`, `memo.loadMemos(moduleRef)`, `memo.loadAllMemos()`, `memo.snapshot(label)`, `memo.restore(ref, files)`, `memo.walkAll()`, `memo.forgetAll()`. The memo singleton auto-prints a "Reminder" banner at startup listing memos for the running script and its imports.

## Notes

- **Git notes refs**: refactor baseline lives at `refs/notes/refactor`; memo snapshots live at `refs/notes/memos`. They are distinct namespaces — cleanup matches content against the baseline memoState, not the memo notes.
- **Baseline must be clean**: `refactor snapshot` refuses on a dirty working tree. Always run `make commit` first (step 1). The baseline pins the known-good binding registry AND the pre-existing memo sidecar state so post-commit cleanup can distinguish stale memos from new damage memos.
- **`--no-memos`**: skip auto memo generation on `damage` and skip cleanup matching. Use only when you want a raw damage report without the memory layer.
- **`--model <id>`**: override the opencode model used for auto memo generation, e.g. `--model ollama_wsvision/qwen3-coder:latest`. Provider/VRAM guidance in AGENTS.md.
- **Memo cascading**: damage memos written to a module's sidecar surface as "Reminder" banners for any script that imports it. This is how context propagates across stages without re-reading every file.
- **Cleanup default**: `refactor cleanup` defaults to baseline `HEAD~1` because HEAD advanced by one at step 8 (commit). Pass `--baseline <ref>` to target a different baseline.
- **Loop invariant**: at the top of each stage the working tree is clean and a fresh baseline is snapshotted. At the bottom, memos are either persisted (`memo --commit --fresh`) or carried forward intentionally.