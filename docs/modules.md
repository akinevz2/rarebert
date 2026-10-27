# Modules

A **module** is a single file inside one of a project's **folders**.
The rarebert repository is one project, and it exposes five
constituent folders that modules live in:

| project    | folder          | extensions    | contents                                        |
| ---------- | --------------- | ------------- | ----------------------------------------------- |
| `root`     | `./`            | `.ts`         | the Bunli entry point (`launch.ts`)             |
| `scripts`  | `scripts/`      | `.ts`         | CLI commands (`memo`, `edit`, `check`, `list`, …) |
| `lib`      | `lib/`          | `.ts`         | the framework runtime (`core.ts`, …)            |
| `supports` | `lib/supports/` | `.js`, `.ts`  | per-language template modules                   |
| `src`      | `src/`          | `.py`         | project code                                    |

Nothing else in the tree is a module. `opencode.json`, `Makefile`, `AGENTS.md`
and the per-language library folders under `lib/{lang}/` are resources, not
modules.

## Design Language: CLI vs TUI Modules

Every runnable module (files in `scripts/*.ts`) should export a default
instance of either the `CLI` class or the `TUI` class from
`lib/runtime/CLI.ts` / `lib/runtime/TUI.ts` (runtime) — or the
compatibility shims `lib/module.ts` / `lib/core.ts` for tests.

### The Correct Shape

```ts
export default new CLI('foo.ts', main, meta).supportsDirectRunning();
// or
export default new TUI('foo.ts', main, meta).supportsDirectRunning();
```

`.supportsDirectRunning` is **deprecated and currently a no-op**: direct
execution (`bun scripts/foo.ts`) was retired with the Bunli migration.
Modules run exclusively through the Bunli entry (launch.ts), which resolves
the module by name (or via `exec <path-ref>`), preloads its memo trail
(`memo.loadForRun`), and runs it through `core.run()`. The no-arg call is
kept for shape compatibility; prefer dropping it.

### The `meta` object

Metas are declared with `defineMeta` (from `lib/runtime/CLI.ts` — the
barrel re-exports it):

```ts
const meta = defineMeta({ ... });
```

The generic-`const` modifier keeps flag string literals (`'--trace <name>'`)
narrow so `OptsOf<typeof meta>` / `Args<typeof meta>` derive real typed
keys. Declaring with a plain `satisfies ModuleMeta` instead widens every
flag property to `string` and collapses the derived opts object into an
index signature — don't.

### The `main` Callback

The `main` argument to `CLI` or `TUI` is an async function. Inline mains
(declared directly inside `new CLI('foo.ts', (opts, positional) => ...)`)
are contextually typed by the engine; standalone mains annotate their
parameters explicitly:

```ts
async function main(args: Args<typeof meta>, positional: Positional<typeof meta>) {
    ...
}
```

Where:

- `opts` is an `Arguments` instance — an `Array` subclass of the
  positionals with the schema-validated option values merged on top
  (camelCase keys, `--no-x` negation defaults applied). Unknown tokens
  land verbatim in `positional` when the meta sets
  `allowUnknownOption: true`
- `positional` is the plain array of positional / passthrough arguments

**Design Principle:** The `main` method should be as simple as possible.
Ideally, declare it as a `CLI` (to support non-interactive environments), with
its main method performing argument checks to decide which action to perform.

### Elevation Pattern

When user interaction is required, use the **elevation pattern**:

1. **Design for CLI first** - Have a `CLI` main that checks arguments
2. **Elevate to TUI** when needed by returning `exit(0, new TUI(...))`

Elevation occurs when:
a) There's no logical default action for the module
b) Performing an operation that requires user confirmation
c) The module's design is to interact with the user for menu-driven operations

```js
async function main(opts, positional) {
    // Check arguments first - CLI-convertible pathways
    if (opts.instruction) {
        // Non-interactive path - perform directly
        return exit(0);
    }

    if (!cli.isInteractive()) {
        return exit(1, () => console.error('Interactive mode required'));
    }

    // Elevate to TUI for user interaction
    return exit(
        0,
        new TUI(
            'foo.ts',            async (opts, positional) => {
                // Interactive workflow here
            },
            meta
        )
    );
}
```

**Note:** `TUI.execute()` already checks `isInteractive()` and fails gracefully,
so the non-interactive check before elevation is optional but recommended for
clearer error messages.

### TUI vs CLI Decision Matrix

Use `TUI` when:

- Menu-driven selection is core to the workflow
- Multiple branching paths require user input
- Interactive configuration is the primary use case

Use `CLI` (or elevate from `CLI`) when:

- Arguments fully specify the operation
- The module can work headlessly in CI/CD
- A simple flag can control behavior (`--force`, `--yes`, etc.)

**Example pattern** (from a CLI-first module's decision tree):

```js
// CLI-convertible: --force allows non-interactive overwrite
if (force || !isNonEmpty) {
    return exit(await performInstall(prefix, binDir));
}

// Elevate to TUI for confirmation prompt
return exit(0, new TUI('edit.ts', async () => {
    const overwrite = await cli.confirm(...);
    // ...
}));
```

### Note on API Stability

At the moment, only `exit()` and the main callback signature are finalized.
The shapes of `run()`, `wrap()`, `execute()`, `parseModuleArgv()`, and other
Module methods may evolve as the codebase develops.

## Discovery

All module discovery goes through `lib/runtime/Project.ts`:

- `project.discover()` returns the constituent folder descriptors
  (`{ key, rel, dir, label, exts }`). Each descriptor is the _interface_ used
  to construct modules; no absolute path is required.
- `project.discoverModules(dir, exts)` scans one folder and returns
  `{ name, path }` entries (root-relative paths).
- `project.projectByKey(key)` looks up a single constituent folder.

`lib/runtime/Module.ts` wraps the scan results in `Module` objects:

```js
new Module(project, file);
```

`project` is a constituent descriptor from `discover()` and `file` is the
module's filename (e.g. `'add.ts'`). The constructor derives everything else
from the folder + filename — the absolute path is computed internally and
never supplied by the caller:

```js
class Module {
    constructor(project, file) {
        this.project = project; // { key, rel, dir, label, exts }
        this.file = file; // 'add.ts'
        this.name = 'add'; // basename without extension
        this.ext = '.ts'; // file extension
        this.abs = path.join(project.dir, file); // internal
        this.path = rarebert.relPath(this.abs); // root-relative
        this.dir = project.rel; // 'scripts'
    }
}
```

`listAllModules()` in `lib/runtime/discovery.ts` is the registry every
command uses. It
walks every constituent folder from `discover()`, scans it with
`discoverModules()`, and builds a `Module` for each file.

## Loading

Modules are loaded as regular source files:

- **scripts/ and lib/** are Bun/TypeScript ES modules imported via their
  absolute path, dispatched by name through the Bunli entry (`launch.ts`).
- **src/** are Python programs run as subprocesses (`python3`).
- **supports/** are template modules imported by `lib/runtime/Language.ts`.

`bun launch.ts <name>` resolves a module by name or path through
`discoverModules()`, preloads its memo trail, and runs its exported `main()`
through `core.run()`. `bun launch.ts exec <path-ref>` runs a module by
path reference.

## The Generated Makefile

The root `Makefile` is a **generated artifact** — it is never written to
directly. It is produced by the project itself:

- `make reload` (→ `scripts/reload.ts` →
  `lib/runtime/makefile.ts#refreshMakefile`) regenerates the file from two
  inputs:
    1. **Discovery** — every module found in `scripts/` becomes one
       `bun launch.ts <name>` target, wired into `.PHONY`.
    2. **The template** — `EXTRA_TARGETS` in `lib/runtime/makefile.ts` holds
       the non-module targets (`deps`, `test`) that discovery cannot derive.
- The file is a _pure index_: no logic, no variables, no hand-maintained
  recipes. Anything not expressible as `bun launch.ts <name>` or a one-line
  extra target belongs in a lib/ module, not in the Makefile.

> **2026-10-23 status:** the Makefile is currently stale (targets call the
> removed `node index.js`) and `scripts/reload.ts` is a stub pending
> reimplementation — do not run `make` targets until the generator is rebuilt.

**Rule: do not edit the Makefile by hand.** Any hand-added target or tweak
is silently dropped the next time `make reload` runs. To add or change a
target:

1. scaffold a `scripts/<name>.ts` module (it gets a target automatically), or
2. add an entry to `EXTRA_TARGETS` in `lib/runtime/makefile.ts`, then
3. run `make reload` and commit the regenerated file.

## Memos

Each module can own a memo sidecar at `<abs>.` (the absolute path plus a `.`
suffix) written by `lib/memo.ts`. Because modules are identified
root-relative through the registry, memo files stay stable across the
path-based interface.

## Runtime

`Runtime` (defined in `lib/runtime/Runtime.ts`, with `run()`/`exit()` in
`lib/runtime/core.ts`) replaces the former single-shot
`executeAndExit` pattern with a recursive execution loop. It is the
core orchestrator that drives module execution, handles submodule
escalation (the elevation pattern), and manages producedValue display.

### What Runtime does

- Orchestrates the `execute → complete → re-execute` loop until an
  `ExitSignal` is resolved
- Maps `exit()` call arguments to `ExitSignal(exitCode, producedValue, onExit)` fields
- Displays `producedValue` via `console.dir()` (exit 0) or
  `console.error()` (non-zero exit code)
- When `onExit` returns a Module instance, re-executes that module
  (the elevation pattern: `return exit(0, new TUI(...))`)

### New entry point pattern

```js
// Instead of exported.executeAndExit(args):
return await Runtime(module).execute(args);
```

The `Runtime(module)` constructor wraps a Module instance, and
`.execute(args)` runs the recursive loop. This is the recommended
way to run a module through the Runtime system.

### Elevation pattern (still works)

```js
// Design for CLI first, elevate to TUI when needed:
return exit(
    0,
    new TUI(
        'foo.ts',
        async (opts, positional) => {
            // interactive workflow
        },
        meta
    )
);
```

`exit(0, new TUI(...))` produces an `ExitSignal` with an `onExit`
callback that returns the TUI Module. Runtime detects this and
re-executes the TUI, creating the elevation workflow.

### ExitSignal mapping table

| `exit()` args        | `ExitSignal` fields                                              |
| -------------------- | ---------------------------------------------------------------- |
| `exit(code)`         | `exitCode = code, producedValue = undefined, onExit = undefined` |
| `exit(code, onExit)` | `exitCode = code, producedValue = undefined, onExit = onExit`    |
| `exit(code, val)`    | `exitCode = code, producedValue = val, onExit = undefined`       |
| `exit(undefined)`    | `exitCode = 0, producedValue = undefined, onExit = undefined`    |
| `exit(string)`       | `exitCode = 1, producedValue = string, onExit = undefined`       |

### Module integration

- `Module.exit(result)` — thin wrapper that calls `result.complete()`;
  returns Module instance from `onExit` to trigger Runtime re-execution
- `Module.execute(args)` — runs `this.runner || this.main` callback
- `index.js runModule(ref, args)` — creates `new Runtime(exported)` and
  calls `runtime.execute(args)`
- `index.js main(opts, positional)` — calls `runModule(cmd, rest)` then
  `exit()` on the result

---

## Adding a module

`make add` scaffolds a new module. The project prompt is driven by
`rarebert.discover()`, so any of the five constituent folders can be the
target. A new module is created with `libs.createModule(project, name, ext)`,
which writes the boilerplate into the folder and wires the correct relative
import paths for that folder.
