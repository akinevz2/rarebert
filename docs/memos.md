# The memo system 

Implemented in lib/memo.mjs (1226 lines) centered around two classes:

Memo (line 21) - Value object for a single module's memo sidecar:

- owner - filename of the module this memo attaches to
- name - filename of the sidecar (e.g., scripts/install.mjs.)
- lastModified - timestamp of last write
- path - rarebert-relative path of owner + sidecar directory
- content - ordered array of memo note strings
- related - relative paths of memoised imports (oldest first)

Memory (line 36) - In-memory buffer + persistence manager:

- buffer: In-memory array tracking memos for current session
- flush() (line 352): Writes buffered memos to sidecar files in topological order (dependencies before dependents) using DFS
- installFlushHandlers() (line 407): Registers process.on('exit') and cli.onAbort() to auto-flush on process exit/abort (e.g., ctrl-C)
- loadMemos() (line 119): Loads existing memos from . sidecar files
- walkAll() (line 651): DFS traversal of full import graph to order memos by dependency - memoised modules appear in post-order (dependencies first)

- Each module can have a sidecar at <module-file>.** (e.g., scripts/install.mjs.)
- These are JSON: { name, content: [...], lastModified: ... }
- Discovered automatically via projects.discoverModules({ all: true })
- The . suffix ensures they're excluded from normal module discovery but picked up by memo indexing

Flag	Function
--add <path> <memo...>	Adds memo to module's sidecar
--drop <path> [indices]	Drops specific memos by index from a module
--forget <path>...	Removes all memos from specified modules
--commit [--yes] [--fresh]	Commits memos to refs/notes/memos git ref; --fresh clears working sidecars
--log [files...]	Shows git notes history
--recall <ref> [files...]	Restores memos from a git snapshot
(default, no flags)	Prints all memos as a DAG (dependency-annotated graph)