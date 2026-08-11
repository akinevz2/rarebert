---
name: operate-presentation
description: Guides an opencode agent or developer in operating rarebert's presentation system — building a presentation JSON from a user request and walking the user's editor through each slide in indexed mode. Use when invoking or reasoning about the `present` command.
---

# Operate Presentation

## Purpose

Drives the `present` command end-to-end: gathers a user instruction, delegates
JSON slide construction to a headless opencode run, then walks the user's
editor through each slide one tab at a time, blocking on tab-close to advance.
The same flow can replay a previously-built presentation JSON from disk.

## When to use

- The user asks to "present", "walk me through", "give a slide tour", or
  otherwise wants an indexed tour of code changes/files.
- The user supplies `--file <path>` to replay a saved presentation JSON.
- You need to explain or debug the slide-walk flow, editor resolution, or the
  presentation JSON shape produced by `scripts/present.mjs` / `lib/present.mjs`.

## How to invoke

The runnable entry point is `scripts/present.mjs`, reached through the
project's CLI:

```bash
node index.js present [model] [--instruction <text>] [--base <ref>] [--head <ref>] [--file <path>]
```

Flags:

- `model` (positional, optional) — resolved via `lib/models.mjs`
  `models.resolve(positional[0])`. Overrides the default model used for the
  headless opencode run that builds the JSON.
- `--instruction <text>` — the "particularity of the request". If omitted, the
  command prompts the user interactively for it.
- `--base <ref>` / `--head <ref>` — git refs passed to
  `lib/present.mjs.generateSlides(base, head)` when generating slides from a
  diff (`git diff --unified=0 <base> <head>`). One slide per hunk.
- `--file <path>` — skip the opencode-build step entirely. Load a presentation
  JSON from `<path>` (or `-` for stdin) via `readPresentation(source)` and
  replay it through the same slide-walk flow.

## The slide-walk flow

1. **Prompt** — collect the instruction (interactive prompt or `--instruction`).
2. **Build JSON** — `scripts/present.mjs` spawns opencode headlessly
   (`ide.spawnHeadless`) with a prompt asking for a JSON presentation object.
   `extractJson` strips markdown fences and pulls the first `{...}` block.
3. **Parse** — the JSON is parsed into `{ title, slides: [...] }`.
4. **walkSlides** — for each slide, in index order:
   - Print the slide's `summary`.
   - Call `lib/present.mjs.presentSlide()` → `openAtLine()` opens the editor at
     `file:line` with `--wait`, blocking until the user closes the tab.
   - On tab-close, advance to the next index and repeat.
5. **Completion** — after the last slide, print completion.

Editor resolution (`resolveEditor`) honors, in order: `$VSCODE_BIN`, `$VISUAL`,
`$EDITOR`, falling back to `code`. VS Code uses `-g file:line:col` goto syntax
with `--wait` to block on tab close.

### endLine handling

When a slide's `endLine` differs from `line` and the editor is VS Code, the
start line is opened fire-and-forget and the end line is opened with `--wait`,
so both positions land in the editor's jump list.

## Notes on the JSON shape

The presentation JSON produced/consumed by the system has this shape:

```json
{
  "title": "<presentation title>",
  "slides": [
    { "file": "<relative path>", "line": <number>, "endLine": <number|null>, "summary": "<string>" }
  ]
}
```

- `file` is a repo-relative path.
- `line` is the 1-indexed start line to open.
- `endLine` is the optional end line (use `null` when not applicable).
- `summary` is the human-readable text printed before opening the slide.
- `readPresentation(source)` accepts a filesystem path or `-` (stdin).
- `generateSlides(base, head)` produces slides from `git diff --unified=0`
  hunks — one slide per hunk.