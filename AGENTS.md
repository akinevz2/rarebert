# Rarebert agent guide

## Scratch and temporary work

Prefer `.opencode/system/` for any temporary or scratch work — intermediate
files, drafts, notes, captured output, partial diffs, anything disposable.
Treat it as the project's private `/tmp`: create subdirectories freely, never
commit anything under it, and clean up your own scratch files when a task is
done unless asked to keep them.

Do not write scratch files to the project root, `lib/`, `scripts/`, `src/`,
or `system/`. Use `.opencode/system/` exclusively for ephemeral output.

## Implementation Guidelines (for opencode sessions)

### Procedural Design & Sequential Structure in main()

When implementing a Rarebert system module's `main()` function:

1. **Entry point**: Function signature should be `async function main(args = [])`
2. **Sequential flow**: Each step should build on the previous, with clear state transitions
3. **Error handling**: Wrap critical sections in try/catch; log errors to stderr
4. **Command pattern**: Consider splitting into named subroutines if complexity > 50 lines

### Object-Oriented Datastructure Design

When designing data structures:

1. Prefer simple dicts/lists over full classes for scripts (simplicity)
2. Use objects with consistent keys/names across modules
3. Document the shape in docstrings or TypeScript annotations
4. For complex state, consider a `State` class at module level

### Declarative-Focused Implementation

When possible, favor declarative approaches:

1. **Config over code**: Let data drive behavior (JSON configs instead of if/else chains)
2. **Pure functions**: Make functions deterministic with no hidden state
3. **Immutable patterns**: Prefer creating new objects vs mutating existing ones
4. **Side effect isolation**: Keep I/O operations clearly separated

### Git Operations via lib/git.mjs

The `lib/git.mjs` module provides a whitelisted git interface:

```javascript
import * as git from '../lib/git.mjs';

// Stage all changes (safe wrapper)
git.add(['filename.js'], { all: true });

// Get status output
const status = git.git('status');
console.log(status.stdout); // stdout string
console.log(status.ok); // boolean success

// Create commit with message plan
git.git('commit', ['-m', 'formatted commit message']);
```

Use `git.git()` for any operation not directly wrapped. All operations are logged.

### Request Logging & Commit Message Instrumentation

Before commits, review the request history stored in `.last-module`:

1. The model receives `remember(name, content)` memos from previous failures/successes
2. When user makes direct requests, those statements accumulate as comments in module files
3. Check for `// REQUEST:` or `# TODO:` prefixes in source to understand intent
4. Use `make memo` command to inject observations into implementation

### Model Capabilities by Provider/VRAM

- **WS-RAREBOX (24GB)**: Can run large quantization models, most flexible
- **V9-MINI (16GB)**: Good for mid-sized models, suitable for most tasks
- **WS-VISION (8GB)**: Limited to q4 or q5 quantizations; best for smaller prompts

Use `--model PROVIDER/MODEL` to override default, e.g.:

```
node index.js edit mymodule --model ollama_wsvision/qwen3-coder:latest
```

### Signal handling & abort flow (ctrl-c / ctrl-d)

All process abort paths are centralized in `lib/cli.mjs`. Do not install
`SIGINT`/`SIGHUP`/`SIGTERM` listeners or call `process.exit(130)` outside
that module.

- `installSignalHandlers()` is called once at startup in `index.js`. It
  registers a single handler for `SIGINT`, `SIGHUP`, `SIGTERM`, and
  `process.on('exit')` that runs every registered `onAbort` callback (in
  registration order) and then exits with code 130.
- `onAbort(callback)` registers a cleanup callback. Use it for any work
  that must run on abort (e.g. restoring the git index, flushing memos).
  Returns an unsubscribe function. `lib/memo.mjs` registers `flush` this way.
- `AbortError` (exported from `lib/cli.mjs`) is the canonical way for a
  non-`cli.mjs` module to signal an abort. Enquirer prompts reject on
  ctrl-c/escape — wrap `await prompt.run()` in try/catch and
  `throw new AbortError()` from the catch. The `run(meta, main)` wrapper
  catches it and calls `abort()` once, which prints `\nAborted.` to stderr,
  runs the cleanup callbacks, and exits 130.
- `die(message, code)` routes the message to `console.log` when
  `code === EXIT_OK` and to `console.error` otherwise. Always use `die()`
  for terminal exits instead of calling `process.exit()` directly with a
  manual print.

### Console output streams

- `console.log` — regular program output: progress echoes (`$ opencode ...`),
  success markers (`✓ Created ...`), banners, status lines (`ok ./mod`),
  non-interactive fallback notices that are not errors, section lists.
- `console.error` — true errors (`Failed to launch ...`,
  `git commit exited with status N`), warnings
  (`memo: performing a forgetful remember ...`), and abort/die messages
  routed through `lib/cli.mjs`.
- `console.dir` — structured object dumps (used by `ok()`).

When in doubt, run `audit-consistency console-streams` to verify.

### Consistency audits

The `audit-consistency` skill (`.opencode/skills/audit-consistency/SKILL.md`)
exercises `make check` and `make edit` non-interactively to verify a named
topic across the codebase. Invoke it as `audit-consistency {topic}` with one
of: `console-streams`, `signal-handling`, `abort-flow`, `naming`. See the
skill body for the per-topic rules.
