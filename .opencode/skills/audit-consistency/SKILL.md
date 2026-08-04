---
name: audit-consistency
description: Use when the user asks to audit, review, or enforce consistency of a topic across the RAREBERT codebase. Runs `make check` and `make edit` non-interactively, then reports drift, console.error misuse, signal-handling gaps, and other {topic} consistency violations.
---

# audit-consistency

This skill verifies a named consistency topic across the Rarebert codebase
by exercising the project's own tooling, then editing violations in place.

`{topic}` is the sole argument and scopes the audit. Examples:

- `audit-consistency console-streams` — regular messages on stdout, errors/warnings on stderr only
- `audit-consistency signal-handling` — central SIGINT/SIGHUP/SIGTERM handling via `lib/cli.mjs`
- `audit-consistency abort-flow` — `AbortError` thrown from prompts, caught by `run()`; no ad-hoc `process.exit(130)`
- `audit-consistency naming` — module/file name conventions

## Procedure

Run these in order. Each step must be non-interactive (no TTY prompts) so the
skill can be invoked headlessly.

1. **Static check** — run `make check` from the project root.

    ```
    make check
    ```

    This executes `node --check` on every module in `lib/` and `scripts/`,
    records syntax failures as memos, and exits non-zero on any failure. Treat
    non-zero as a blocker: fix the syntax before continuing.

2. **Targeted re-edit** — run `make edit` with the topic as the module
   argument and a non-interactive model resolved from `opencode.json`.

    ```
    node index.js edit <topic-representative-file> <model-from-opencode.json>
    ```

    Pick the representative file as the one most likely to anchor the topic
    (e.g. `lib/cli.mjs` for `signal-handling`, `scripts/implement.mjs` for
    `console-streams`). The skill caller supplies `{topic}`; map it to a file
    yourself using Grep/Glob before invoking `edit`. If `{topic}` already maps
    to a concrete path, use that path directly.

3. **Consistency sweep** — using Grep, scan the codebase for violations of
   the topic. Common patterns per topic:

    - `console-streams`: `rg "console\.error"` then classify each hit. Regular
      progress/info/success messages must move to `console.log`; only true
      errors and warnings stay on `console.error`.
    - `signal-handling`: `rg "process\.on\((SIGINT|SIGHUP|SIGTERM)"` — any
      handler outside `lib/cli.mjs` is a violation; route it through
      `onAbort(cb)` from `lib/cli.mjs` instead.
    - `abort-flow`: `rg "process\.exit\(130\)"` outside `lib/cli.mjs` —
      replace with `throw new AbortError()` and let `run()`'s catch handle it.
    - `naming`: `rg "normalizeModuleName"` and verify each call site.

4. **Apply fixes** — edit each violating file with the Edit tool. Do not
   introduce new patterns; mirror what `lib/cli.mjs` already does.

5. **Re-verify** — re-run `make check` and `npx prettier --check` on every
   file touched. Both must pass before the skill reports success.

6. **Report** — summarize in the final message:
    - files changed (path:line)
    - category of each fix (e.g. "console.error -> console.log", "ad-hoc SIGINT -> onAbort")
    - whether `make check` and `prettier --check` pass

## Topic-specific rules

### console-streams

- `console.log` — regular program output, progress echoes (`$ opencode ...`),
  success markers (`✓ Created ...`), banners, non-interactive fallback
  notices that are not errors.
- `console.error` — true errors (`Failed to launch ...`, `git commit exited
with status N`), warnings (`memo: performing a forgetful remember ...`),
  and abort/die messages routed through `lib/cli.mjs`.
- `console.dir` — structured object dumps (already used by `ok()`).
- The `die(message, code)` helper in `lib/cli.mjs` routes to `console.log`
  when `code === EXIT_OK` and `console.error` otherwise. Always use `die()`
  for terminal exits instead of calling `process.exit()` directly with a
  manual print.

### signal-handling

- `installSignalHandlers()` from `lib/cli.mjs` is called once at startup in
  `index.js`. Do not install `SIGINT`/`SIGHUP`/`SIGTERM` listeners anywhere
  else.
- Cleanup-on-abort is registered via `onAbort(callback)`. Callbacks run once
  in registration order on any abort path (signal, `die()`, `nonInteractive()`).
- `lib/memo.mjs` registers its `flush()` via `onAbort(flush)` plus
  `process.on('exit', flush)`. This is the canonical pattern for
  flush-on-exit semantics.

### abort-flow

- Enquirer prompts reject on ctrl-c/escape. Wrap the `await prompt.run()` in
  try/catch and `throw new AbortError()` from the catch — do not call
  `process.exit(130)` directly.
- `AbortError` propagates to the `run(meta, main)` wrapper in `lib/cli.mjs`,
  which calls `abort()` once (printing `\nAborted.` to stderr and exiting
  130 after running cleanup callbacks).
- Only `lib/cli.mjs` may call `process.exit(130)` (via `abort()` /
  `die(..., EXIT_ABORT)`). Every other module signals abort by throwing
  `AbortError`.

## Verification commands

```
make check
npx prettier --check lib/ scripts/ index.js
```

Both must exit 0. If `make check` records memos for a file you edited, the
syntax fix is incomplete — read the memo via `node index.js memo` and
re-edit.
