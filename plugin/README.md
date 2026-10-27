# rarebert-plugin

OpenCode plugin that surfaces rarebert's own tooling (`bun launch.ts` commands)
to the live session as tools — the bootstrap loop: as parts of rarebert get
fixed, the agent can immediately use them to fix the rest.

## Install

Wired through the project config (`opencode.jsonc` at the rarebert root):

```jsonc
{
    "plugins": ["./plugin"]
}
```

OpenCode watches config files and reloads plugins on save — no restart needed.
To force it: `/reload`.

Dependencies (`@opencode/plugin`, `typescript`, `bun-types`) are committed via
`bun.lock`; run `bun install` inside `plugin/` after a fresh checkout.

## Tools (namespace `rarebert`)

| Tool | Wraps | Notes |
|---|---|---|
| `rarebert_probe` | — | Live health check of every surfaced surface. Run first when results look suspicious. |
| `rarebert_check` | `bun launch.ts check` | Syntax + binding integrity. Scoped by `files`, or all modules. `--json`/`--struct`/`--trace`/`--memos`; `--strict` opts into the noisy in-file reference scan. |
| `rarebert_analyze` | `bun launch.ts analyze` | Source map / dependency trace / import graph. |
| `rarebert_memo` | `bun launch.ts memo` | Memo read/mutate. Refuses whole-sidecar `--forget <module>` unless deliberate. |

All four surfaces report live via `rarebert_probe` (was: analyze/bindings
degraded while `lib/supports/lang*.js` still imported the deleted
`../languages.mjs` paths — fixed).

## The bootstrap loop

1. Fix a part of rarebert.
2. Verify with `rarebert_check` (syntax + binding integrity) and scoped
   `rarebert_analyze`.
3. Leave a memo on the touched module via `rarebert_memo`
   (`--add <module> <text>`) documenting what changed and any pinned
   contracts — rich-memo shapes like `@see-line(42, race in flush
   ordering)` or `@smell(7, long function)` interleave with plain strings.
4. Use `rarebert_analyze --trace module::name` to trace dependencies before
   the next edit.

Memos are local-only sidecar files (`<file>.`, gitignored) — commit them
with `--commit` to make them recoverable via git notes.

## Development

```sh
cd plugin && bun install
bun run typecheck
```

Pattern reference: this follows the same local-directory plugin layout as
`~/.config/opencode/opencode-screencast` (package.json `main: index.ts`,
`@opencode/plugin` dependency, tool transform under a namespace).
