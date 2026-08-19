# Known Issues

Outstanding tasks for the rarebert codebase, gathered from conversation
history and memo sidecars. Last updated: 2026-08-19.

## 1. Execution-loop refactor (runModule / ExitSignal / handleResult)

**Status:** Not started on `refactor/runmodule-exit-loop` branch (working tree
reverted to merge baseline `1dc2489`). A git stash (`stash@{0}`) contains a WIP
attempt with bugs.

**Files:** `lib/core.mjs`, `lib/module.mjs`, `index.js`

**Goal:** Replace the single-shot `executeAndExit` (execute → exit →
process.exit) with a loop that re-executes Module instances until an ExitSignal
is resolved. Structurally fix the closure-trick bug by passing `args` to
submodules instead of the `(o = opts, p = positional)` workarounds.

### 1a. Add `Module.handleResult(result, args)` to `lib/module.mjs`

The method should:
- If `result instanceof Module` → `return this.handleResult(await result.execute(args), args)`
- If `result instanceof ExitSignal && result.isSubmodule() && result.submodule instanceof Module` → execute submodule with `args` (NOT no-args — this is the closure-trick fix), recurse on the result, run `wrapper.onExit` if present
- If `result instanceof ExitSignal` (no submodule) → `return await result.complete()`
- Otherwise → `return result` (raw value)

The method **returns values** — it does NOT call `process.exit()`. The
top-level caller is responsible for termination.

### 1b. Add `Module.terminate(value)` to `lib/module.mjs`

Type-aware process termination (the single exit point at the boundary):
- `number` → `process.exit(value)`
- `string` → `console.error(value); process.exit(1)`
- `undefined/null` → warn "last command finished without a safe exit value" + `process.exit(1)`
- `object/array` → `console.dir(value); process.exit(1)`

### 1c. Update `Module.exit()` and `executeAndExit()`

- `exit(result)` → thin wrapper: `return this.handleResult(result, [])`
- `executeAndExit(args)` → `const result = await this.execute(args); const code = await this.handleResult(result, args); this.terminate(code);`

### 1d. Rename underscore methods

All underscore methods in `lib/module.mjs` have no external callers. Rename:
- `_flagString` → `flagString` (Module class + cli singleton)
- `_typeParser` → `typeParser` (Module class + cli singleton)
- `_wrap` → `wrap` (CLI class)
- `_buildActionHandler` → `buildActionHandler` (CLI class)
- `_parseArgv` → `parseArgv` (CLI class)
- `_validateArgs` → `validateArgs` (module-level function)
- `_terminate` → `terminate` (Module class)

Update the comment on line 393 that references `CLI._wrap` → `CLI.wrap`.

### 1e. Simplify `ExitSignal.complete()` in `lib/core.mjs`

After `handleResult` intercepts Module submodules, `complete()`'s
submodule-execution branch (lines 44-81) becomes dead code for Module
submodules. It still handles function/thenable submodules as a fallback.
Add `// FIXME: too complex` marker (or simplify by removing the Module
submodule branch, keeping only cleanup + onExit + return code).

### 1f. Update `runModule()` in `index.js`

Currently calls `exported.executeAndExit(args)` (single-shot). The memo says
`runModule` should be the orchestrator. With `executeAndExit` now using
`handleResult` + `terminate`, this works as-is. Optionally, refactor to call
`execute` + `handleResult` + `terminate` directly for clarity.

**Memos:** `index.js` (3 refactor memos), `lib/core.mjs` (1 memo),
`lib/module.mjs` (2 refactor memos + 1 unused-import memo for `current`).

### 1g. Stash review issues

The git stash `stash@{0}` has bugs that must not be carried forward:
- `lib/projects.mjs`: `import { exit } from 'process'` — **wrong**, should be
  `from './core.mjs'`
- `lib/projects.mjs`: `listModules()` changed to `return exit(0)` — alters the
  void contract of the method
- `lib/module.mjs`: `const result = this.handleResult(result, [])` in `exit()` —
  variable shadowing SyntaxError
- `lib/module.mjs`: `handleResult` has a dead early return (`if (current
  instanceof ExitSignal) return current.code` before the submodule check) making
  the submodule branch unreachable
- `lib/module.mjs`: references undefined `wrapper` variable
- `lib/module.mjs`: recursive `handleResult` calls drop `args` (second arg
  defaults to `[]`), so multi-level escalations lose args
- `lib/module.mjs`: imports `current` from `./projects.mjs` but never uses it

---

## 2. scripts/list.mjs + index.js refactor

**Status:** Not started (working tree at baseline).

**Files:** `scripts/list.mjs`, `index.js`

### 2a. list.mjs — remove `"core" in opts` check

The `"core" in opts` check is unworkable: list's Commander meta does not
declare `--core` and has no `allowUnknownOption`, so Commander rejects it as
an unknown option. The `--core` flag is consumed by index.js's own Commander
(line 97-98: `rarebert.redirect(home.root)`), so list.mjs should always call
`rarebert.listModules(args)` — the redirect handles the `--core` semantics.

### 2b. list.mjs — replace `exit(async () => {...})` pattern

The `exit(async () => { return await rarebert.listModules(args); })` pattern
routes through `ExitSignal.complete()`'s function-submodule branch (the "FIXME:
too complex" path). Replace with direct `await rarebert.listModules(args);
return exit(0);` in the CLI main callback.

### 2c. index.js — import default CLI module from list.mjs

Currently imports `{ listModules }` (named export) and calls it directly at
line 105. The user wants index.js to import the default CLI module and escalate
via `return exit(listModule)`. The `exit(cliInstance)` pattern creates an
ExitSignal with `submodule = cliInstance` — `handleResult` detects this and
calls `cliInstance.execute(args)` with the forwarded args.

### 2d. list.mjs — restore `listModules` named export (if needed)

If index.js switches to `return exit(listModule)`, the named `listModules`
export may become unnecessary. If kept, it should be
`(args) => rarebert.listModules(args)` (not `home.listModules`).

**Memos:** none directly on list.mjs; index.js memos describe the runModule
loop (section 1).

---

## 3. `Module.create` static method bugs

**Status:** Not started.

**File:** `lib/module.mjs` (near end of file, `Module.create = function create(filePath)`)

Two bugs:
1. **Path resolution** — resolves relative to `lib/module.mjs`'s directory
   instead of the project root. Should use `rarebert.root` or `process.cwd()`.
2. **Wrong instance check** — checks `module instanceof Module` on the module
   namespace object instead of `module.default instanceof Module` on the
   default export.

The user wants `Module.create` to be usable to inspect refactored modules
(verify they're CLI/TUI instances).

---

## 4. Closure-trick bugs (8 scripts)

**Status:** Not started. These are mitigated by the `(o = opts, p = positional)`
default-param workaround in some scripts, but the structural fix is the
`handleResult` execution loop (section 1) which passes `args` to submodules.

**Root cause:** `ExitSignal.complete()` (lib/core.mjs:47) calls
`this.submodule.execute()` with NO args. Commander re-parses empty argv, so the
TUI's `opts` becomes `{}` and `positional` becomes `[]`, losing the outer CLI's
parsed values.

**Affected scripts:**
| Script | Memo line | Reads inside TUI |
|---|---|---|
| `scripts/onboard.mjs` | :18 | `opts`, `positional` |
| `scripts/implement.mjs` | :41 | `positional` (for `runInteractive`) |
| `scripts/present.mjs` | :24 | `opts.file`, `opts.instruction`, `positional[0]` |
| `scripts/trail.mjs` | :38 | `opts.limit` |
| `scripts/update.mjs` | :40 | `opts.force`, `opts.model` |
| `scripts/add.mjs` | :30 | `positional[0]` (modelArg) |
| `scripts/article.mjs` | :69 | `opts.preview`, `positional[0..1]` |
| `scripts/commit.mjs` | :98 | reads outer-scope vars (params are misleading) |

**Structural fix (via section 1):** `handleResult` calls
`submodule.execute(args)` with the original args, so the TUI's Commander
re-parses the correct argv. This makes the `(o = opts, p = positional)`
workarounds unnecessary — they can be reverted to plain `(opts, positional)`.

**Workaround (if section 1 is not done):** change TUI main to
`async (o = opts, p = positional) => {...}` so defaults close over the outer
CLI's parsed values.

---

## 5. Unused imports

**Status:** Detected by `make check` integrity audit. Not blocking but pollute
the check output.

| File | Line | Import | Source |
|---|---|---|---|
| `lib/module.mjs` | 6 | `current` | `./projects.mjs` |
| `lib/implement.mjs` | 3 | `cli` | `./module.mjs` |
| `lib/implement.mjs` | 3 | `AbortError` | `./module.mjs` |
| `scripts/add.mjs` | 4 | `cli` | `../lib/module.mjs` |
| `scripts/article.mjs` | 3 | `cli` | `../lib/module.mjs` |
| `scripts/edit.mjs` | 4 | `cli` | `../lib/module.mjs` |
| `scripts/install.mjs` | 8 | `cli` | `../lib/module.mjs` |
| `scripts/open.mjs` | 8 | `cli` | `../lib/module.mjs` |
| `scripts/commit.mjs` | 5 | `cli` | `../lib/git.mjs` |

---

## 6. Exit-handling migration (scripts/ and lib/)

**Status:** Documented in AGENTS.md "Unfinished Work" section. Not started.

`scripts/article.mjs:56` uses `process.exit(1)` directly — should use
`return exit(1, () => console.error(...))` to route through the exit callback
system so signal handlers and `onAbort` cleanup (memo flush, git-index
restore) run before the process ends.

`lib/article.mjs` has 12 `process.exit(1)` call sites (lines 142, 152, 155,
169, 179, 183, 242, 249, 317, 332, 342, 355). These need migration to return
error codes/throw `AbortError` so the script's CLI wrapper can call `exit()`.

Other `lib/` modules with `process.exit()`:
- `lib/present.mjs` (lines 81, 141, 146)
- `lib/opencode.mjs` (line 57)
- `lib/ide.mjs` (line 273)
- `lib/backend.mjs` (line 415)

`lib/server.mjs` (lines 133-135) — intentional socket-probe exits, leave as-is.
`scripts/run.mjs` and `scripts/trail.mjs` — bare `return;` after
`process.exit()` in child handlers, leave as-is (documented in AGENTS.md).

---

## 7. memo.mjs DAG parent-resolve bug

**Status:** Not started.

`lib/memo.mjs:187` (`_allImports(mod)`) calls `parseImports(mod.abs)` but
`mod.abs` is undefined when `mod` comes from `home.discoverModules()`, which
returns lightweight descriptors with only `{name, path}` — no `.abs` field.
This silently returns `[]`, so the memo DAG's parent-resolve graph is ALWAYS
empty for every module.

**Fix:** resolve the abs path via `rarebert.absPath(mod.path)` (or
`home.absPath`) instead of reading `mod.abs`.

**Verify:** `node index.js memo scripts/onboard.mjs` should show `├──
lib/backend.mjs`, `├── lib/core.mjs`, `├── lib/module.mjs` (those with memo
sidecars).

---

## 8. introspect.mjs trace limitations

**Status:** Not started.

- Trace resolves only top-level exports, not class methods.
  `core::setIntrospectCache` / `memo::flush` / `module::installSignalHandlers`
  report unresolved-name because they are class/instance methods, not
  module-level exports. Consider a `::` name form like
  `core::Store.setIntrospectCache` or have `traceBinding` walk class bodies.
- `lib/introspect.mjs:1092-1093` — `seen` and `_seen` referenced but not
  defined or imported (4 undefined-reference memos).

---

## 9. Terse-language subsystem (createLangTemplate)

**Status:** Not started. Memo placed on `lib/template.mjs` and `index.js`.

`languages.mjs::opencodeGenerateTemplate(lang)` produces rigid prompts for
opencode to generate language templates. Replace with a `createLangTemplate()`
method in `lib/template.mjs` that scaffolds a `lang*.js` support module from
`lib/support-template.json` without calling opencode.

The `opencodeGenerateTemplate` prompt was already softened (review-based
instead of rigid spec), but the ultimate goal is to replace it entirely with
`createLangTemplate()`.

**Memos:** `lib/template.mjs` (createLangTemplate), `index.js` (next refactor
target).

---

## 10. onboard.mjs non-interactive mode

**Status:** Partially done. `runOnboardNonInteractive` was added to
`lib/backend.mjs` and `--base-url`/`--model`/`--provider`/`--editor-type` flags
were added to `scripts/onboard.mjs` (in the merged origin/main commit
`97f342d`). The closure-trick workaround on the TUI escalation may still be
needed.

**Memos:** `scripts/onboard.mjs` (2 memos).

---

## 11. editor.mjs interactiveSelectActiveFiles → TUI module

**Status:** Not started.

`lib/editor.mjs:200` (`interactiveSelectActiveFiles`) should be converted from
an async method on the Editor class into its own TUI module, invoked via
`exit(new TUI('interactive-select.mjs', async () => {...}))` from
`resolveActiveFiles`. The selected entries would be returned through the
ExitSignal return-value protocol (section 1).

**Memo:** `lib/editor.mjs`.

---

## 12. libs.mjs Library class

**Status:** Not started.

Implement a `Library` class that all library methods can declare as a
convenience for further refactoring of functionality methods being declared as
mutable across the codebase.

**Memo:** `lib/libs.mjs`.

---

## 13. Delegate skill prompt spec improvement

**Status:** Not started.

The prompt specs written to `.opencode/system/stepN.txt` for `implement.mjs`
subagent dispatch should be intelligence-based, not rigid code-templates:
- **a)** Specify the list of files (not exhaustive)
- **b)** List intelligence: what's wrong/asked, contextual clues — no
  instructions on HOW to create the change
- **c)** Reminder to use `node index.js memo <file>` to view memos for context

The current approach writes exact code blocks to insert, which is too rigid
and doesn't let the local model reason about the implementation.

---

## 14. Subagent stability issue

**Status:** Recurring.

Subagents dispatched via `task` tool for `implement.mjs` invocations have
multiple times run out of solution space and reverted/stashed working tree
changes. This destroyed progress on the execution-loop refactor (section 1).
The delegate skill should warn about this failure mode and recommend:
- Committing working changes before dispatching a subagent
- Having the subagent run `git stash` only with explicit instruction
- Falling back to direct edits when subagent dispatch fails repeatedly