---
name: refactor-tui-conversion
description: Guides an opencode agent in converting scripts/ modules from CLI to TUI classes, applying the closure trick for arg forwarding on CLI->TUI escalations. Use when converting a script from `new CLI(...)` to `new TUI(...)`, replacing direct Enquirer usage with tui.* helpers, fixing the (opts, positional) forwarding bug via closure-trick defaults, and verifying the conversion with check/analyze/trail/present.
---

# Refactor TUI Conversion

## Purpose

Converting `scripts/*.mjs` modules from `new CLI(...)` to `new TUI(...)` so the
runtime clears the screen before running (interactive mode) and after exit,
giving full-screen interactive flows a clean terminal slate.

The `TUI` class (defined in `lib/module.mjs:510`) subclasses `CLI` and
inherits Commander arg parsing — the only behavioural difference is
`clearScreen` (default `false` unless `meta.clearScreen` is set): the
runtime writes `\x1B[2J\x1B[H` after the module runs when interactive.

## The escalation bug (critical context)

When a CLI module escalates to a TUI via `return exit(new TUI(...))`, the
TUI's `main` callback declares `(opts, positional)` but **never receives
the outer CLI's parsed args**. This is because `ExitSignal.complete()`
(`lib/core.mjs:47`) calls `this.submodule.execute()` with **no arguments**.
The TUI's `execute()` defaults `args` to `[]`, Commander re-parses an
empty argv, and `main` gets `opts = {}` and `positional = []` — the
outer CLI's parsed values are lost.

### The closure trick fix

Every TUI `main` callback that needs the outer CLI's `opts` or
`positional` must use **closure-trick default parameters** so the
defaults resolve against the enclosing CLI `main` scope:

```javascript
export default new CLI('example.mjs', async (opts, positional) => {
    return exit(new TUI('example.mjs', async (o = opts, p = positional) => {
        // o and p default to the outer CLI's opts/positional
        // because ExitSignal.complete() calls execute() with no args,
        // Commander re-parses empty argv, and the defaults kick in.
    }, meta));
}, meta).supportsDirectRunning(import.meta.url);
```

If the TUI body does NOT use `opts` or `positional` (e.g. it only reads
outer-scope variables captured via closure), drop the params entirely:
`async () => { ... }`. This is the canonical pattern from
`scripts/analyze.mjs:51` and `scripts/install.mjs:93`.

### Modules already fixed with the closure trick

| Script | Escalation site | Pattern |
|---|---|---|
| `scripts/implement.mjs` | line 62 | `async (o = opts, p = positional) => {...}` |
| `scripts/article.mjs` | line 72 | `async (o = opts, p = positional) => {...}` |
| `scripts/commit.mjs` | line 98 | `async (o = opts, p = positional) => {...}` |
| `scripts/analyze.mjs` | line 51 | `async () => {...}` (no params needed) |
| `scripts/install.mjs` | line 93 | `async () => {...}` (no params needed) |
| `scripts/undo.mjs` | line 28 | `async () => {...}` (no params needed) |

### Modules still needing the closure trick

| Script | Escalation site | Issue |
|---|---|---|
| `scripts/onboard.mjs` | line 18 | TUI reads `opts.force`, `positional.includes('--force')` |
| `scripts/present.mjs` | line 24 | TUI reads `opts.file`, `opts.instruction`, `positional[0]` |
| `scripts/add.mjs` | line 30 | TUI reads `positional[0]` as modelArg |
| `scripts/trail.mjs` | line 38 | TUI reads `opts.limit` (Commander default not applied) |
| `scripts/update.mjs` | line 40 | TUI reads `opts.force`, `opts.model` |

Each of these has a `REFACTOR: closure-trick` memo describing the exact
fix. Run `node index.js memo <script-path>` to view.

## When to use

- The user asks to "convert a script to TUI" or "use the TUI class".
- A script has a `while (true)` Select menu loop, direct `new Enquirer.*`
  prompts, or `process.stdin.isTTY` gates that branch into interactive flows.
- You see a `REFACTOR: closure-trick` memo on a module (run `node index.js memo`
  or `node index.js analyze <script>` to view memos).
- You see a `TUI-conversion:` memo on a module.

## TUI candidates (from recon)

Each of these has a memo describing why:

| Script | Signal |
|---|---|
| `scripts/article.mjs` | `while (true)` Select menu + `process.stdin.isTTY` gate |
| `scripts/trail.mjs` | `while (true)` Select loop with custom keybindings |
| `scripts/commit.mjs` | `process.stdin.isTTY` gate + direct `new Enquirer.Confirm` |
| `scripts/edit.mjs` | Launches opencode full TUI via `ide.spawnTui` |
| `scripts/open.mjs` | Bootstraps opencode full TUI at project root |
| `scripts/implement.mjs` | `cli.isInteractive()` branches into `while (true)` REPL |
| `scripts/add.mjs` | Multi-step wizard with direct `Enquirer.Input`/`MultiSelect` in lib helpers |
| `scripts/present.mjs` | Editor-driven slide walkthrough, blocks per-slide |
| `scripts/status.mjs` | **Already TUI** — reference implementation |
| `scripts/onboard.mjs` | Multi-step wizard with direct `Enquirer.MultiSelect` in `lib/backend.mjs` |

## The conversion procedure

Each conversion is one pass through these steps. Work on one script at a
time, verify, then move to the next.

### 1. RECON — Read the memo and the script

```bash
node index.js memo <script-path>        # view the REFACTOR/TUI-conversion memo
node index.js analyze <script-path>     # print imports, main(), public members
```

Open the script and its lib helpers. Identify:
- Direct `new Enquirer.Select/Input/Confirm/MultiSelect/AutoComplete` — these
  should be replaced with `tui.select`/`tui.input`/`tui.confirm` where
  possible. The interactive prompt helpers live on the `TUI` class in
  `lib/module.mjs` and are available via the `tui` singleton, or via
  `this.select`/`this.confirm`/`this.input` on a `CLI`/`TUI` instance.
  (The `cli` singleton is non-interactive only — signal handling, abort,
  truncate, isInteractive, createCommand, parse, etc.)
- `process.stdin.isTTY` checks — the `TUI` class handles interactive vs
  non-interactive via `cli.isInteractive()` internally; if the script has an
  explicit TTY gate, it can usually stay (TUI still parses args via
  Commander in non-interactive mode).
- `while (true)` menu loops — these are fine in a TUI; `clearScreen` will
  clean up on exit.
- **CLI→TUI escalations** — any `return exit(new TUI(...))` inside the
  script's `main` callback. These MUST use the closure trick (see above).

### 2. EDIT — Change the class, imports, and apply the closure trick

In `scripts/<name>.mjs`:

```diff
- import { CLI } from '../lib/module.mjs';
+ import { TUI } from '../lib/module.mjs';
```

For a direct CLI→TUI conversion (no escalation):
```diff
- export default new CLI('<name>.mjs', async (opts, positional) => {
+ export default new TUI('<name>.mjs', async (opts, positional) => {
      // ... main body unchanged ...
  }, meta).supportsDirectRunning(import.meta.url);
```

For a CLI module that escalates to a TUI (has `return exit(new TUI(...))`):
```diff
  export default new CLI('<name>.mjs', async (opts, positional) => {
-     return exit(new TUI('<name>.mjs', async (opts, positional) => {
+     return exit(new TUI('<name>.mjs', async (o = opts, p = positional) => {
          // o and p close over the outer CLI's opts/positional
      }, meta));
  }, meta).supportsDirectRunning(import.meta.url);
```

If the TUI body doesn't use opts/positional, drop the params:
```diff
-     return exit(new TUI('<name>.mjs', async (opts, positional) => {
+     return exit(new TUI('<name>.mjs', async () => {
          // outer-scope variables (modelArg, verbose, etc.) are already
          // captured via closure — no params needed
      }, meta));
```

If the script imports `cli` for non-interactive helpers (signal handling,
abort, truncate, isInteractive, createCommand, parse), that still works —
`TUI` delegates to the same `CLI` singleton. No change needed to those
`cli.*` calls. For interactive prompts, import and use `tui` instead.

If the script uses direct `new Enquirer.*`, replace with the equivalent
`tui.*` helper:
- `new Enquirer.Select({ message, choices })` → `await tui.select(message, choices)`
- `new Enquirer.Confirm({ message, initial })` → `await tui.confirm(message, initial)`
- `new Enquirer.Input({ message, initial, validate })` → `await tui.input(message, { initial, validate })`
- `new Enquirer.MultiSelect(...)` / `new Enquirer.AutoComplete(...)` — these
  have no `tui.*` equivalent; leave them as-is (they work fine under TUI).
  If the agent wants to add a `tui.multiSelect` / `tui.autoComplete` helper
  to `TUI`, that's a separate enhancement — not required for the conversion.

### 3. CHECK — Verify integrity

```bash
node index.js check
```

Must report `0 syntax failures, 0 integrity issues`. If there are
unused-import warnings (e.g. `Enquirer` no longer referenced after
replacing with `tui.*`), remove the unused imports and re-check.

### 4. ANALYZE — Inspect the converted module

```bash
node index.js analyze <script-path>
```

Confirm the imports list no longer includes `Enquirer` (if all direct uses
were replaced) and the `main()` span looks correct.

### 5. TRAIL — Verify memo cascade

```bash
node index.js trail <script-path>
```

Check that the `REFACTOR:` or `TUI-conversion:` memo still shows up in the
trail for the script. The memo should persist through the conversion (it's a
sidecar file, not part of the source).

### 6. PRESENT (optional) — Visual diff walkthrough

If the conversion involved non-trivial changes, generate a presentation of
the diff to walk through the changes slide-by-slide:

```bash
node index.js present
```

This opens each changed hunk in `$EDITOR` at the relevant line, blocking
until you close the tab — useful for reviewing the conversion visually.

### 7. COMMIT

```bash
make commit
```

Or `node index.js commit` — the commit module will summarise the changes
via opencode and commit with an editor-reviewed message.

### 8. CLEANUP MEMO

After the conversion is committed and verified, remove the
`REFACTOR: closure-trick` or `TUI-conversion:` memo since the conversion
is done:

```bash
node index.js memo --forget <script-path>
```

## Reference implementation

`scripts/status.mjs` is the only script already using `new TUI(...)`. Its
structure is the canonical pattern:

```javascript
import { TUI } from '../lib/module.mjs';

export default new TUI('status.mjs', async (opts, positional) => {
    // ... stages ...
    return exit(0);
}, meta).supportsDirectRunning(import.meta.url);
```

The `TUI` constructor signature is identical to `CLI`:
`new TUI(file, main, meta)`. The `meta` object supports the same fields
(`name`, `description`, `usage`, `options`, `args`, `subcommands`,
`allowUnknownOption`, `skipHelpIntercept`). One additional field:
- `meta.clearScreen` (default `false`) — set to `true` to enable the
  screen-clear behaviour after the module runs.

## The runtime call chain

For reference, the full Module runtime call chain (from `index.js` entry
and `supportsDirectRunning()`) is documented in 34 `CALL-CHAIN:` memos on
`lib/run.mjs`. Run `node index.js memo lib/run.mjs` to view. Key links:

```
index.js::main → index.js::runModule → Module::executeAndExit
→ Module::execute → CLI::_wrap → CLI::_buildActionHandler
→ main(opts, positional) → exit(new TUI(...))
→ ExitSignal::complete → TUI::execute → CLI::execute → TUI main
```

The escalation bug site is `ExitSignal::complete` (`lib/core.mjs:47`):
`this.submodule.execute()` is called with no args. The closure trick
works around this by making the TUI main's default params resolve against
the enclosing CLI main scope.

The underscore-prefixed methods (`_wrap`, `_buildActionHandler`,
`_flagString`, `_typeParser`, `_parseArgv`) are targeted for removal in a
future simplification pass — they are not idiomatic JavaScript. Until that
refactor, the closure trick is the sanctioned workaround.

## Important notes

- **Always apply the closure trick on CLI→TUI escalations.** This is the
  most important part of the conversion. Without it, the TUI silently
  loses the outer CLI's parsed args.
- **Do not change `lib/` helpers during conversion.** The lib helpers
  (`lib/article.mjs`, `lib/trail.mjs`, `lib/backend.mjs`, etc.) can keep
  using direct `new Enquirer.*` — the conversion is about the script's
  default export class, not the lib internals. The `tui.*` helpers are
  preferable for new code, but replacing existing Enquirer usage in lib
  files is a separate refactor.
- **`cli` is non-interactive only; `tui` has the interactive prompts.**
  The `cli` singleton (`lib/module.mjs`) retains signal handling, abort,
  `isInteractive`, `nonInteractive`, `truncate`, `createCommand`, `parse`,
  etc. — but NO interactive Enquirer prompts. For `confirm`/`input`/`select`,
  import `{ tui }` from `lib/module.mjs` and call `tui.confirm`/
  `tui.input`/`tui.select`, or use `this.confirm`/`this.input`/
  `this.select` on a `CLI`/`TUI` instance. Scripts that import `{ cli }`
  for non-interactive helpers don't need any import changes to those
  `cli.*` calls; add `tui` to the import only when interactive prompts
  are used.
- **Non-interactive mode is unchanged.** `TUI` degrades to `CLI` behaviour
  (Commander arg parsing) when `cli.isInteractive()` is false — the screen
  clear is skipped and `main` receives `(opts, positional)` as usual.
  However, `TUI::execute` (`lib/module.mjs:528`) hard-fails with
  `tui: <path> requires an interactive terminal` when stdin is not a TTY,
  so TUI modules cannot run in non-interactive/piped contexts at all.
- **One script per commit.** Each conversion should be a separate commit
  so the trail is clean and revertable.
- **All opencode-spawning scripts should have `-m, --model <id>`.** The
  default model is resolved via `models.resolveDefault()` (reads
  `opencode.json`/`opencode.jsonc`, prefers `config.model`, falls back to
  first-provider/first-model). The `--model` flag overrides this. If the
  specified model is not found in the config, `models.validateModel()`
  returns a descriptive error and the process exits with status 1.
  Model id format is `provider/model` as declared in the config — e.g.
  `ollama/laguna-xs-2.1:q8_0`. The provider name is whatever key is used
  under `provider` in `opencode.jsonc` (not necessarily `"ollama"`).
- **Local ollama models are SLOW.** When using `scripts/implement.mjs` (or
  any script that spawns `opencode run`) with a local ollama model, the
  `spawnSync` call is synchronous and can take 5-15 minutes per invocation
  as the LLM reads files, reasons, and writes code. Do NOT set a short
  timeout on the bash call — use at least 1800s (30 min) or no timeout at
  all. Do NOT assume the backend is unavailable if a call takes a long
  time — only an immediate error (connection refused, model not found)
  indicates a real failure. A long-running command is normal, not a
  failure.