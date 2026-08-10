# Modules

A **module** is a single file inside one of a project's **constituent
folders**. The rarebert repository is one project, and it exposes five
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
