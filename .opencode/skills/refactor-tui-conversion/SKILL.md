---
name: refactor-tui-conversion
description: Guides an opencode agent in converting scripts/ modules from CLI to TUI classes. Use when converting a script from `new CLI(...)` to `new TUI(...)`, replacing direct Enquirer usage with cli.* helpers, and verifying the conversion with check/analyze/trail/present.
---

# Refactor TUI Conversion

## Purpose

Converts `scripts/*.mjs` modules from `new CLI(...)` to `new TUI(...)` so the
runtime clears the screen before running (interactive mode) and after exit,
giving full-screen interactive flows a clean terminal slate.

The `TUI` class (defined in `lib/module.mjs:295`) subclasses `Module` and
delegates to `CLI` for Commander arg parsing — the only behavioural difference
is `clearScreen` (default `true`): the runtime in `index.js:80` writes
`\x1B[2J\x1B[H` before and after the module runs when interactive.

## When to use

- The user asks to "convert a script to TUI" or "use the TUI class".
- A script has a `while (true)` Select menu loop, direct `new Enquirer.*`
  prompts, or `process.stdin.isTTY` gates that branch into interactive flows.
- You see a `TUI-conversion:` memo on a module (run `node index.js memo` or
  `node index.js analyze <script>` to view memos).

## TUI candidates (from recon)

Each of these has a `TUI-conversion:` memo describing why:

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
node index.js memo <script-path>        # view the TUI-conversion memo
node index.js analyze <script-path>     # print imports, main(), public members
```

Open the script and its lib helpers. Identify:
- Direct `new Enquirer.Select/Input/Confirm/MultiSelect/AutoComplete` — these
  should be replaced with `cli.select`/`cli.input`/`cli.confirm` where
  possible. The `cli.*` helpers live on the `_SharedCLI` class in
  `lib/module.mjs` and are available via the `cli` singleton, or via
  `this.select`/`this.confirm`/`this.input` on a `CLI`/`TUI` instance.
- `process.stdin.isTTY` checks — the `TUI` class handles interactive vs
  non-interactive via `cli.isInteractive()` internally; if the script has an
  explicit TTY gate, it can usually stay (TUI still parses args via
  Commander in non-interactive mode).
- `while (true)` menu loops — these are fine in a TUI; `clearScreen` will
  clean up on exit.

### 2. EDIT — Change the class and imports

In `scripts/<name>.mjs`:

```diff
- import { CLI } from '../lib/module.mjs';
+ import { TUI } from '../lib/module.mjs';
```

```diff
- export default new CLI('<name>.mjs', async (opts, positional) => {
+ export default new TUI('<name>.mjs', async (opts, positional) => {
      // ... main body unchanged ...
  }, meta).supportsDirectRunning(import.meta.url);
```

If the script imports `cli` for helpers, that still works — `TUI` delegates
to the same `sharedCLI` singleton. No change needed to `cli.*` calls.

If the script uses direct `new Enquirer.*`, replace with the equivalent
`cli.*` helper:
- `new Enquirer.Select({ message, choices })` → `await cli.select(message, choices)`
- `new Enquirer.Confirm({ message, initial })` → `await cli.confirm(message, initial)`
- `new Enquirer.Input({ message, initial, validate })` → `await cli.input(message, { initial, validate })`
- `new Enquirer.MultiSelect(...)` / `new Enquirer.AutoComplete(...)` — these
  have no `cli.*` equivalent; leave them as-is (they work fine under TUI).
  If the agent wants to add a `cli.multiSelect` / `cli.autoComplete` helper
  to `_SharedCLI`, that's a separate enhancement — not required for the
  conversion.

### 3. CHECK — Verify integrity

```bash
node index.js check
```

Must report `0 syntax failures, 0 integrity issues`. If there are
unused-import warnings (e.g. `Enquirer` no longer referenced after
replacing with `cli.*`), remove the unused imports and re-check.

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

Check that the `TUI-conversion:` memo still shows up in the trail for the
script. The memo should persist through the conversion (it's a sidecar
file, not part of the source).

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
`TUI-conversion:` memo since the conversion is done:

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
- `meta.clearScreen` (default `true`) — set to `false` to suppress the
  screen-clear behaviour if the script needs to leave output visible.

## Important notes

- **Do not change `lib/` helpers during conversion.** The lib helpers
  (`lib/article.mjs`, `lib/trail.mjs`, `lib/backend.mjs`, etc.) can keep
  using direct `new Enquirer.*` — the conversion is about the script's
  default export class, not the lib internals. The `cli.*` helpers are
  preferable for new code, but replacing existing Enquirer usage in lib
  files is a separate refactor.
- **The `cli` singleton works under both `CLI` and `TUI`.** Scripts that
  import `{ cli }` from `lib/module.mjs` don't need any import changes.
- **Non-interactive mode is unchanged.** `TUI` degrades to `CLI` behaviour
  (Commander arg parsing) when `cli.isInteractive()` is false — the screen
  clear is skipped and `main` receives `(opts, positional)` as usual.
- **One script per commit.** Each conversion should be a separate commit
  so the trail is clean and revertable.