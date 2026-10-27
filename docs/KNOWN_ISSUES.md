# Known Issues

Outstanding tasks for the rarebert codebase, gathered from conversation
history and memo sidecars. Last updated: 2026-10-27.

> **2026-10-27 status note — TypeScript migration + language framework.**
> `lib/` is fully `.ts` and typechecks clean under `strict` (remaining tsc
> debt is implicit-any in legacy `scripts/`). The four language-support
> modules (`lib/supports/lang*.js`) load again after the
> `../languages.mjs` → `../runtime/Language.ts` import fix; `analyze`
> reports real bindings and `check` integrity now surfaces pre-existing
> reference mismatches that were vacuously green before.

## 0. Class-based file resolution in lib/ (raw strings → Module/Project)

**Status:** Partially tightened (2026-10-27, memo/depgraph + dispatch boundary);
the remaining sweep is not started.

**Directive:** library modules must resolve files through the runtime
abstractions (`Module`, `Project`, `rarebert`, `Language`) — not raw path
strings, ad-hoc stub objects, or hand-rolled resolution heuristics. New code
must follow this; existing call sites are tracked here for tightening.

**Sub-directive — whole-object passing:** never pass dismembered property
pairs (`script.path`, `script.name`, …) across a boundary; introduce the
typed class (e.g. `Script`, lib/runtime/Script.ts) and pass the whole
object. Done in the current sweep: `Project.resolveModuleRef` returns
`Script`; `Dispatcher.runModule`/`makeRunner`/`wrapModuleCommand` take
`Script`; `memo.loadForRun(script: Script)` stores the whole ref
(`Memory.runScript`) and `_isTrailRelevant` resolves the running module
from it.

Concrete residue to rewrite:

- `lib/memo.ts` — stringly-typed module references throughout:
  - `remember(moduleRef: string)`, `loadMemos(moduleRef: string)`,
    `loadMemosByPath(modulePath: string)`, `forgetByPath(moduleRelPath: string)`,
    `memoFilePathFor(moduleRef: string)` — each re-resolves by
    path/endsWith/name heuristics instead of receiving a `Module`
    (which already carries `path`/`abs`/`name`/`memoFile()`).
  - Sidecar path math duplicated as `rarebert.absPath(rel) + SUFFIX`
    instead of `Module.memoFile()` (e.g. `forgetByPath`, `_relatedMemos`,
    `loadAllMemos`, `applyDrop`'s `resolved.sidecar`).
  - `_isTrailRelevant` hand-constructs `scripts/${runScriptName}.ts` —
    DONE (2026-10-27): `Memory.runScript` holds the whole `Script` and the
    running module resolves via `byPath.get(runScript.path)`.
  - `recallImports(callerRef: string)` accepts abs path or file:// URL
    strings; should receive the running `Module` (currently receives
    `script.abs` from the `Script` object — partially tightened).
- `lib/depgraph.ts` — `GraphNode { path, abs }` is deliberately a minimal
  structural subset so it stays decoupled from `Module`; if `Module` gains
  the graph responsibilities this widens naturally, but the string keys
  (`importsOf`/`importersOf` maps) are path-string based by design and
  remain the one sanctioned raw-string surface.
- `lib/introspect.ts`, `scripts/check.ts`, `scripts/analyze.ts` — callers
  pass `mod.abs`/`mod.path` strings into resolution helpers
  (`resolveImportPath`, `introspectFile`); tighten to `Module`-consumers
  alongside the same sweep.

## 0c. API-shape & idiom sweep findings (2026-10-27 — report, not yet actioned)

**Sweep total:** 48 `TODO(whole-object): … — see §lib-classes` markers inline
across 12 files (lib/memo.ts 11, scripts/check.ts 9, scripts/analyze.ts 8,
lib/introspect.ts 7, lib/editor.ts 3, lib/bindings.ts 2, lib/server.ts 2,
scripts/memo.ts 2, launch.ts 1, lib/runtime/discovery.ts 1,
lib/depgraph.ts 1, scripts/open.ts 1).

Key findings awaiting the refactor sweep:

- **Double assertions** (`as unknown as X`) suggesting wrong types upstream:
  check.ts buildBindingGraph casts (1099, 1166) — type the return as `Graph`
  upstream; discovery.ts:226 nonInteractive cast; TUI.ts:188; Project.ts
  enquirer cast — fix `lib/types/enquirer.d.ts` (missing `Select` typing).
- **`any` in exported signatures**: Language.ts abstract methods +
  `LanguageImpl = any`; introspect `invokePrimitive`/`runTool`; CLI
  `Arguments extends Array<any>`, `main as any`; Module `main` + index
  signature; TUI internals; memo comparators/mappers.
- **Non-null assertions → guard clauses**: memo.ts:519 `readFileSync(file!)`
  (sibling guards!); depgraph.ts:105–106 `get()!` invariants; CLI.ts:279.
- **Duplicated helpers to collapse**: `camelCase` (launch.ts vs CLI.ts — they
  DIFFER on digit handling); `extOf`/`readSource` (bindings vs introspect);
  `resolveImportSource` (check) vs `resolveImportPath` (introspect) — same
  name, DIFFERENT candidate lists; `traceBinding` (check) ≈ introspect
  Trace.usage; `moduleChoices` vs `buildModuleChoices`; `findDirectoryTarget`
  ≈ `rarebert.projectByKey`; memo's two sidecar-timestamp mappers +
  `_moduleLastModified` ≈ `_readSidecarLastModified`; opencode-config read
  ×3 (backend/models/server); `groupArgs` vs the engine's
  `parseModuleArgv` (memo duplicates tokenization the zod engine owns —
  candidate: `ParsedInvocation.positionalGroups()`).
- **Type-shape upgrades**: branded `ModuleRef` union for memo's
  stringly-typed refs; string-literal unions for binding `kind`;
  `MemoDag` → plain `{ groups, totalCycles, cycles }` object;
  `ResolvedTarget.abs?` two-shapes-in-one; `SpawnedTui` → discriminated
  union.
- **Null-handling inconsistencies**: Project.ts:450 dead `??`;
  Module.ts fallback `allFolders[0]` conflates no-match with root;
  `scripts/open.ts:37` / `edit.ts` use `promptModule()` result without a
  null check while the parallel `resolveModule` path checks (latent crash);
  server.ts:674 dead `project` param.

**Suppressed circularity** (documented, do not annotate): Store↔Project cycle
blocks passing `home` whole into store APIs; depgraph path-string keys are
the sanctioned raw-string surface (§0).

## 0b. Rich memos (pinned for after the refactor merges to main)

**Status:** Pinned 2026-10-27 — not started. Deliberately out of scope for
the current memo-algorithm milestone.

**Goal:** unify memo content into a single `content` array that holds BOTH
human read-writeable string memos AND pre-definable / reusable memo shapes
— structured tuples interleaved with plain strings. Motivating shapes:

- line-reference tuples: "see line N for issue kind X" (e.g. a diagnostic
  finding anchored to a source line);
- code-smell tuples: smell kind + line number (+ optional symbol);
- other recurring tuple kinds produced by tooling (diagnostic memos
  currently encode this as flat strings like `line ?: ...` — the broken
  `--document` placeholders are the cautionary example).

Machinery sketch:

- A **shape registry**: named, reusable memo shapes with a kind id, a
  field tuple, and a renderer — definable per language/project so new
  shapes can be produced by the agent later (same philosophy as the
  language-support framework: scaffolding a shape extends every consumer).
- Sidecar `content` entries become `string | ShapeEntry`; consumers
  (`loadMemosWithTimestamps`, the DAG print, `--oldest`, `--commit`
  snapshots) must handle both — the loader already half-anticipates this
  (`typeof c === 'object'` fallback in `loadMemosWithTimestamps`).
- Rendering: the DAG print renders shape entries through the shape's
  formatter (interleaved with plain memos); aging/dedup rules may differ
  per shape (e.g. line-anchored diagnostics expire when the line moves —
  detectable via `analyze` source maps).
- Migration: existing string memos stay as-is (backward compatible);
  diagnostic memos (`line ?:`, `undefined-reference:`) are transient and
  get dropped once the underlying issue is fixed, per the AGENTS.md memo
  convention.

> **2026-10-23 status note — Bunli migration + module slim-down.** The entry
> is now the Bunli thin router (`launch.ts`): direct execution
> (`node index.js`, `supportsDirectRunning`) is gone, and `.mjs` artifacts
> were replaced by their `.ts` descendants. Sections referencing
> `article`/`commit`/`diff`/`implement`/`present`/`trail`/`undo` describe
> code that was **removed** (recoverable from git history); sections
> referencing `add`/`install`/`languages`/`onboard`/`project`/`run`/
> `status`/`update` describe **stubs** with documented headers. `make`
> targets are stale (`node index.js` no longer exists) until a future
> milestone implements `reload`.

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

### 1d. Rename underscore methods — DONE (2026-10)

All underscore methods in the legacy `lib/module.mjs` have been renamed in the
TypeScript runtime (`lib/runtime/`):
- `flagString` (CLI instance method)
- `typeParser` (CLI static method)
- `wrap` (CLI instance method)
- `parseArgv` (CLI instance method)
- `validateArgs` (module-level function in core.ts)
- `terminate` (Module instance method)

The `cli` singleton was deleted entirely — its helpers are free functions
in `lib/runtime/Module.ts` (`isInteractive`, `nonInteractive`, `abort`,
`onAbort`, `runInteractively`, `truncate`, `ok`, `fail`).

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
---

## 15. Template system: support-template.json relocation

**Status:** Not started. Memo on `lib/template.mjs`.

Move `support-template.json` from project root into `lib/supports/` and update related methods in `lib/template.mjs` and any consumers. The template defines the scaffold structure for `createLangTemplate()`.

---

## 16. Language template generation: createLangTemplate()

**Status:** Not started. Memo on `lib/languages.mjs` (formerly "rewrite opencodeGenerateTemplate").

Replace `languages.mjs::opencodeGenerateTemplate()` with `createLangTemplate()` in `lib/template.mjs`. The new method should scaffold a `lang*.js` support module from `lib/support-template.json` (after relocation to `lib/supports/`) without calling opencode. This replaces the rigid opencode-based template generation with a direct scaffold.

---

## 17. Flag parsing: --flag=value, -fvalue, -f value, short aliases

**Status:** Not started. 4 memos on `scripts/memo.mjs`.

Extend `groupArgs()` in `lib/memo.mjs` to support:
- `--flag=value` (prefix/equals syntax)
- `-fvalue` (infix short flag syntax)
- `-f value` (short flag with space)
- Short flag aliases (e.g., `-a` for `--add`, `-c` for `--commit`) for action flags

Current `groupArgs()` only recognizes `--flag` style long flags.

---

## 18. Test file: unused import of cmdDrop

**Status:** Not started. Memo on `test/memo-cmd-shapes.test.mjs`.

`cmdDrop` is imported from `../lib/memo.mjs` on line 3 but not referenced anywhere in the test file. Remove the import or use it in a test.

---

## 19. Runtime/exit/ExitSignal consolidation into lib/run.mjs — DONE

**Status:** Completed 2026-08-19. Supersedes section 1.

The Runtime/exit/ExitSignal system was moved from `lib/core.mjs` into
`lib/run.mjs` (thematically the "running" module). `lib/core.mjs` re-exports
the moved symbols so the 63 existing `from './core.mjs'` imports keep working.
Two bugs that broke `make open` (silent exit 0) were fixed during the move:

- `exit()` now treats a function as the first arg as the `onExit` callback
  (`exit(async () => {...})` in `index.js:133`).
- `ExitSignal.complete()` now uses a returned `ExitSignal` instead of dropping
  it (checks `instanceof ExitSignal` before the `.execute()` Module-chaining
  check).

A circular import (`core.mjs → run.mjs → projects.mjs → core.mjs`) was
resolved by making `SRC_DIR`/`DEFAULT_MODULE` lazy functions in `run.mjs`;
`scripts/run.mjs` calls `DEFAULT_MODULE()` instead of using the value
directly.

`index.js:130` was fixed: `new Runtime(runModule)` passed the dispatcher
*function* (no `.execute`), so Runtime could not loop. Now wrapped:
`new Runtime({ execute: (args) => runModule(args[0], args.slice(1)) })`.

All CLI/Module underscore methods were removed or renamed to public API;
`CLI.wrap`, `CLI.parseArgv`, `CLI.typeParser`, `CLI.flagString`,
`CLI.createCommand` are public methods on the `CLI` class in
`lib/runtime/CLI.ts`. The `cli` singleton was deleted.

**Verification:** 127 tests pass, 0 fail. `node index.js open` no longer
exits 0 silently (it now runs and reports non-TTY correctly).

---

## 20. scripts/symbols.mjs relocated to lib/symbols.mjs — DONE

**Status:** Completed 2026-08-19.

`scripts/symbols.mjs` was a library (glyph/ANSI constants), not a runnable
script. Moved to `lib/symbols.mjs`. Importers updated: `lib/module.mjs`,
`lib/present.mjs`, `lib/memo.mjs` (`./symbols.mjs`), and `scripts/check.mjs`
(`../lib/symbols.mjs`).

---

## 21. runtime.execute([]) return shape inconsistent across CLI modules

**Status:** Open. Memos recorded on `test/modules.test.mjs` (one per CLI).

`test/modules.test.mjs` records the current return shape of
`await new Runtime(mod).execute([])` for every CLI module. Some return a
number exitCode, some return `undefined`, some throw. The ASAP fix: every
`Module.execute()` must return an ExitSignal (or throw), never `undefined`.
Once fixed, flip the memo test from "record current behavior" to
`assert.equal(typeof result, 'number')`.

---

## 22. delegate skill: compact prompt requirement + model guidance

**Status:** Completed 2026-08-19.

`delegate` SKILL.md updated with: (a) prompt files must be <1 kB, at most two
sections (`## Goal` + one follow-up) — larger prompts stall non-SOTA local
models; (b) model selection table — `ollama/nemotron-3.5-lightning:latest`
for small-medium refactors, `ollama/laguna-s-2.1:q4_K_M` for large (verify
via `opencode models`; no bare `opencode/laguna-s-2.1` exists).

---

## 23. Subagent dispatch repeatedly stalls/cancels

**Status:** Recurring. Related to section 14.

During this session, `task` subagents dispatched to run `implement.mjs`
either cancelled immediately or returned empty results, and background
invocations applied broken partial edits (deleted class bodies from
`lib/core.mjs` without adding them to `lib/run.mjs`, plus a duplicate
`DATA_DIR` block). Recovery required direct orchestrator edits. The
delegate skill should document that when subagent dispatch fails
repeatedly, the orchestrator should fall back to direct edits rather than
retry indefinitely.

