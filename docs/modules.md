# Modules

A **module** is a single file inside one of a project's **folders**.
The rarebert repository is one project, and it exposes five
constituent folders that modules live in:

| project    | folder          | extensions    | contents                                  |
| ---------- | --------------- | ------------- | ----------------------------------------- |
| `root`     | `./`            | `.mjs`, `.js` | the CLI entrypoint (`index.js`)           |
| `scripts`  | `scripts/`      | `.mjs`, `.js` | CLI commands (`add`, `edit`, `commit`, …) |
| `lib`      | `lib/`          | `.mjs`, `.js` | the framework runtime (`core.mjs`, …)     |
| `supports` | `lib/supports/` | `.js`         | per-language template modules             |
| `src`      | `src/`          | `.py`         | project code run via `make run`           |

Nothing else in the tree is a module. `opencode.json`, `Makefile`, `AGENTS.md`
and the per-language library folders under `lib/{lang}/` are resources, not
modules.

## Design Language: CLI vs TUI Modules

Every runnable module (files in `scripts/*.mjs`) should export a default
instance of either the `CLI` class or the `TUI` class from `lib/module.mjs`.

### The Correct Shape

```js
export default new CLI('foo.mjs', main, meta).supportsDirectRunning(import.meta.url);
// or
export default new TUI('foo.mjs', main, meta).supportsDirectRunning(import.meta.url);
```

The `.supportsDirectRunning(import.meta.url)` call is **required** for modules
that can be run directly via `node scripts/foo.mjs` (as opposed to only through
`node index.js foo`).

### The `main` Callback

The `main` argument to `CLI` or `TUI` is an async function with signature:

```js
async (opts, positional) => { ... }
```

Where:

- `opts` is the parsed options object from Commander flags
- `positional` is the array of positional arguments

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
            'foo.mjs',
            async (opts, positional) => {
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

**Example pattern** (from `scripts/install.mjs`):

```js
// CLI-convertible: --force allows non-interactive overwrite
if (force || !isNonEmpty) {
    return exit(await performInstall(prefix, binDir));
}

// Elevate to TUI for confirmation prompt
return exit(0, new TUI('install.mjs', async () => {
    const overwrite = await cli.confirm(...);
    // ...
}));
```

### Note on API Stability

At the moment, only `exit()` and the main callback signature are finalized.
The shapes of `run()`, `_wrap()`, `execute()`, `createCommand()`, and other
Module methods may evolve as the codebase develops.

## Discovery

All module discovery goes through `lib/projects.mjs`:

- `project.discover()` returns the constituent folder descriptors
  (`{ key, rel, dir, label, exts }`). Each descriptor is the _interface_ used
  to construct modules; no absolute path is required.
- `project.discoverModules(dir, exts)` scans one folder and returns
  `{ name, path }` entries (root-relative paths).
- `project.projectByKey(key)` looks up a single constituent folder.

`lib/modules.mjs` wraps the scan results in `Module` objects:

```js
new Module(project, file);
```

`project` is a constituent descriptor from `discover()` and `file` is the
module's filename (e.g. `'add.mjs'`). The constructor derives everything else
from the folder + filename — the absolute path is computed internally and
never supplied by the caller:

```js
class Module {
    constructor(project, file) {
        this.project = project; // { key, rel, dir, label, exts }
        this.file = file; // 'add.mjs'
        this.name = 'add'; // basename without extension
        this.ext = '.mjs'; // file extension
        this.abs = path.join(project.dir, file); // internal
        this.path = rarebert.relPath(this.abs); // root-relative
        this.dir = project.rel; // 'scripts'
    }
}
```

`listAllModules()` in `lib/modules.mjs` is the registry every command uses. It
walks every constituent folder from `discover()`, scans it with
`discoverModules()`, and builds a `Module` for each file.

## Loading

Modules are loaded as regular source files:

- **scripts/ and lib/** are Node.js ES modules imported via their absolute
  path (`import('file://…')`), dispatched by name from `index.js`.
- **src/** are Python programs run as subprocesses (`python3`).
- **supports/** are `.js` template modules imported by `lib/languages.mjs`.

`node index.js <name>` resolves a module by name or path through
`discoverModules()` and calls its exported `main()`.

## The Generated Makefile

The root `Makefile` is a **generated artifact** — it is never written to
directly. It is produced by the project itself:

- `make reload` (→ `scripts/reload.mjs` → `lib/makefile.mjs#refreshMakefile`)
  regenerates the file from two inputs:
    1. **Discovery** — every module found in `scripts/` becomes one
       `node index.js <name>` target, wired into `.PHONY`.
    2. **The template** — `EXTRA_TARGETS` in `lib/makefile.mjs` holds the
       non-module targets (`deps`, `test`) that discovery cannot derive.
- The file is a _pure index_: no logic, no variables, no hand-maintained
  recipes. Anything not expressible as `node index.js <name>` or a one-line
  extra target belongs in a lib/ module, not in the Makefile.

**Rule: do not edit the Makefile by hand.** Any hand-added target or tweak
is silently dropped the next time `make reload` runs. To add or change a
target:

1. scaffold a `scripts/<name>.mjs` module (it gets a target automatically), or
2. add an entry to `EXTRA_TARGETS` in `lib/makefile.mjs`, then
3. run `make reload` and commit the regenerated file.

## Memos

Each module can own a memo sidecar at `<abs>.` (the absolute path plus a `.`
suffix) written by `lib/memo.mjs`. Because modules are identified
root-relative through the registry, memo files stay stable across the
path-based interface.

## Adding a module

`make add` scaffolds a new module. The project prompt is driven by
`rarebert.discover()`, so any of the five constituent folders can be the
target. A new module is created with `libs.createModule(project, name, ext)`,
which writes the boilerplate into the folder and wires the correct relative
import paths for that folder.
