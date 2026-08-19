---
name: delegate
description: Orchestrates multi-stage refactors where the orchestrating agent holds the plan and subagents execute one step at a time via scripts/implement.mjs, which invokes the local LLM through opencode run. Use when planning or executing a multi-step code refactor in rarebert where the local ollama model should perform the actual file edits.
---

# Delegate

## Purpose

Orchestrates a multi-stage refactor by splitting work between two roles:

- **Orchestrating agent** — holds the plan, creates todos, spawns subagents one step at a time, verifies after each step, and steers when the LLM output diverges from the plan.
- **Subagent** — runs a single `node scripts/implement.mjs <files> -m ollama/laguna-xs-2.1:q8_0 --prompt "<one step>"` command per todo, reports the raw output, and may perform minor syntax fixups. Does NOT perform large architectural edits directly.

The local LLM (invoked through `implement.mjs` → `opencode run --auto`) does the actual code editing. This preserves cloud credits, uses local compute for implementation, and keeps the orchestrating agent's context free of large code blocks.

## When to use

- The user asks for a multi-step refactor, bugfix, or feature implementation in rarebert.
- The task can be broken into discrete steps, each targeting specific files.
- You want the local ollama model to perform the actual code edits.
- The task size warrants todo tracking and stepwise verification.

## When NOT to use

- Simple single-edit tasks — do them directly.
- Tasks requiring real-time debugging or interactive prompts (implement.mjs non-interactive mode has no TTY).
- When the local ollama backend is confirmed unavailable (connection refused, model not found — an immediate error, not a long-running command).

## The orchestrator-subagent contract

### Orchestrating agent responsibilities

1. **Plan** — read memos, analyze code, design the multi-step plan. Create todos via `todowrite`.
2. **Dispatch** — for each todo, spawn a `task` subagent of type `general` with a prompt that instructs it to run a single `implement.mjs` invocation.
3. **Verify** — after each subagent returns, run `node --check` on changed files, `git diff --name-only`, and check the output matches expectations.
4. **Steer on divergence** — if the LLM's output diverges from the plan (different approach, missed files, extra changes), do NOT edit directly. Instead, add fixup todos that are also dispatched through `implement.mjs`. Only edit directly if the fixup is a trivial one-line syntax correction that the LLM repeatedly gets wrong.
5. **Final verification** — after all todos complete, re-verify the entire set of changes with `node --check` on every touched file.

### Subagent responsibilities

1. **Run the command** — execute the exact `node scripts/implement.mjs <files> -m ollama/laguna-xs-2.1:q8_0 --prompt "<step instruction>"` command given in the prompt.
2. **Report raw output** — return the literal stdout/stderr of the `implement.mjs` invocation. Do not summarize or interpret.
3. **Minor fixups allowed** — if the LLM output has a trivial syntax error (missing semicolon, wrong import name, unused import), the subagent may fix it directly with the edit tool. These must be one-line corrections, not architectural changes.
4. **No large direct edits** — the subagent must NOT rewrite functions, move code blocks, add new methods, or perform any change that alters program logic. All such changes go through `implement.mjs`.
5. **Extend todos on drift** — if the `implement.mjs` output diverges significantly from the step instruction (wrong files changed, different approach taken, partial implementation), the subagent should report the divergence and suggest fixup steps. The orchestrating agent then adds these as new todos dispatched through `implement.mjs`.

## Workflow

### Step 1 — Plan and create todos

The orchestrating agent reads the relevant memos, analyzes the codebase, and designs a multi-step plan. Each step must specify:

- **Files to edit** — the module paths passed as positional args to `implement.mjs`.
- **Instruction** — a self-contained prompt for the local LLM describing what to do in this one step. Must include: what to change, where in the file, what NOT to change, and any code patterns to follow from neighboring files.

Create todos via `todowrite`.

### Step 2 — Write the step prompt to scratch

For each step, write the instruction to `.opencode/system/stepN.txt` so the subagent can pass it to `implement.mjs` via `--prompt`. This keeps the subagent prompt clean and avoids shell-escaping issues with long instructions.

```
.opencode/system/step1.txt — "Add runOnboardNonInteractive method to lib/backend.mjs ..."
.opencode/system/step2.txt — "Add --base-url, --model, --provider, --editor-type flags to scripts/onboard.mjs ..."
```

**Prompt size is critical.** Local non-SOTA models (laguna-xs, nemotron-lightning)
stall or produce poor output when the `--prompt` content exceeds ~1 kB. A 5 kB
prompt file will overload them. Keep every step prompt file **under 1 kB** and
**at most two short sections**:

1. **`## Goal`** — one or two sentences stating what the step achieves.
2. **One follow-up section** (your choice: `## Changes`, `## Steps`, `## Bugs`,
   etc.) — a compact bullet list of the specific edits. No prose paragraphs,
   no code blocks longer than 3-4 lines, no "What NOT to change" walls of text.

Rules for compact prompts:
- Reference existing code by `file:line` — never paste whole functions.
- Omit "What NOT to change" unless a specific, concrete footgun demands it
  (one bullet max).
- Skip verification instructions in the prompt file — verification is the
  orchestrator's job, not the local model's.
- Prefer many tiny steps over one big step. Split a 5 kB plan into 4-5
  sub-1 kB steps and dispatch each separately.
- If a step genuinely needs more context, that is a signal to use the
  large-refactor model (`ollama/laguna-s-2.1:q4_K_M`) for that one step.

### Step 3 — Spawn the subagent for each step

Launch a `task` subagent of type `general`. The subagent prompt must:

- Explicitly instruct: "Run this command: `node scripts/implement.mjs <files> -m ollama/laguna-xs-2.1:q8_0 --prompt \"$(cat .opencode/system/stepN.txt)\"`"
- State: "Do NOT edit files directly. The implement.mjs command invokes the local LLM which performs the edits. You only run the command and report output."
- State: "You MAY fix trivial syntax errors (missing semicolons, unused imports) directly. You must NOT perform architectural changes — report divergence and suggest fixup steps instead."
- State: "Use NO timeout shorter than 1800s (30 min). A long-running command is normal for local ollama models. Do NOT assume the backend is unavailable if the command takes a long time."
- Request: "Skip the stdout/stderr report if implement.mjs exited successfully (exit 0 and no error output) — simply confirm success. Only report the literal stdout/stderr when the command failed, diverged from the instruction, or produced warnings/diagnostics."

### Step 4 — Verify after each step

After the subagent returns:

```bash
node --check <each-touched-file>
git diff --name-only
git diff <touched-file>
```

Check that the changes match the step's instruction. If they don't, decide:
- **Minor mismatch** (syntax, formatting, missed a line) → add a fixup todo, dispatch via `implement.mjs`.
- **Major divergence** (different approach, wrong files) → add a corrective todo with a more specific instruction, dispatch via `implement.mjs`.
- **Complete failure** (implement.mjs errored immediately) → check if the backend is truly down. If so, fall back to direct edits as a last resort.

### Step 5 — Final verification

After all todos (including fixups) are complete:

```bash
node --check <all-modified-files>
node index.js check    # if available
git diff --stat
```

### Step 6 — Commit (if requested)

```bash
make commit
# or: node index.js commit
```

## implement.mjs command reference

```bash
node scripts/implement.mjs <module-path>... [--prompt <instruction>] [instruction] [-m <model>]
```

- **Module paths** — positional args that resolve to files/modules via `editor.resolveTargetArg`. Any positional that does NOT resolve is treated as the instruction (if `--prompt` is not set).
- **`--prompt <text>`** — the instruction for the local LLM. Takes precedence over trailing-arg inference.
- **`-m <model>`** — model id in `provider/model` format (e.g. `ollama/laguna-xs-2.1:q8_0`). Overrides the default from `opencode.jsonc`.
- **No `--model` flag** — `implement.mjs` resolves the default via `models.resolveDefault()` (reads `opencode.jsonc`, prefers `config.model`, falls back to first-provider/first-model).
- **Non-interactive mode** — when stdin is not a TTY, `implement.mjs` runs `opencode run --auto` headlessly (synchronous `spawnSync`).
- **Interactive mode** — when stdin is a TTY, launches the opencode full TUI with the instruction as `--prompt`.

## Timeout rules

Local ollama models are SLOW. A single `implement.mjs` invocation can take 5-15 minutes as the LLM reads files, reasons, and writes code.

- **Minimum timeout**: 1800s (30 min). Anything shorter will kill legitimate work.
- **Preferred**: no timeout at all — let the command complete naturally.
- **Never assume the backend is down from a long-running command.** Only an immediate error (connection refused, model not found, opencode crash) indicates a real failure.
- If a command times out at 1800s, retry with no timeout. The model may have been processing a large file.

## Divergence handling

When the LLM's output does not match the step instruction:

| Divergence type | Action |
|---|---|
| Trivial syntax error (missing semicolon, unused import) | Subagent fixes directly |
| Missing a small change (one function, one flag) | Add fixup todo, dispatch via `implement.mjs` |
| Wrong approach (different design than planned) | Add corrective todo with a more specific instruction referencing the exact code patterns to follow, dispatch via `implement.mjs` |
| Partial implementation (some files done, others not) | Add continuation todo for the remaining files, dispatch via `implement.mjs` |
| Complete failure (implement.mjs errored) | Check backend availability. If truly down, fall back to direct edits as last resort. |

The key principle: **steer by adjusting the next instruction, not by editing directly.** The orchestrating agent's job is to reason about the plan and verify; the local LLM's job is to write the code.

## Model resolution

`implement.mjs` resolves the model in this order:
1. `-m`/`--model` flag (highest priority)
2. `models.resolveDefault()` — reads `opencode.jsonc`, prefers `config.model`, falls back to first-provider/first-model
3. `models.lastChosenModel()` — checks the SQLite store for a previously chosen model

The model id format is `<provider>/<model>` as declared in `opencode.jsonc` — e.g. `ollama/laguna-xs-2.1:q8_0`. The provider name is whatever key is used under `provider` in the config.

If the specified model is not found, `models.validateModel()` returns a descriptive error and the process exits with status 1 before spawning opencode.

## Model selection guidance

Choose the local model by refactor size. Verify the exact model string with
`opencode models` before first use in a session (model tags change between
installs).

| Refactor size | Recommended model | Notes |
|---|---|---|
| Small–medium (single module, focused edit) | `ollama/nemotron-3.5-lightning:latest` | Better performance and resource utilisation than `laguna-xs-2.1:q8_0` for directed refactors. Preferred default for delegate steps. |
| Large (multi-file, architectural moves) | `ollama/laguna-s-2.1:q4_K_M` | Larger quantization model; verify availability via `opencode models` first (there is no bare `opencode/laguna-s-2.1` — the local tag is `ollama/laguna-s-2.1:q4_K_M`, the cloud free tier is `opencode/laguna-s-2.1-free`). |
| Legacy fallback | `ollama/laguna-xs-2.1:q8_0` | The original delegate default. Works but slower/less efficient than nemotron for directed tasks. |

**Context overload caveat:** long, dense step prompts can stall smaller local
models (e.g. `laguna-xs-2.1`). If a delegate invocation hangs, retry with
`ollama/nemotron-3.5-lightning:latest` and a trimmed, focused instruction
before falling back to the cloud model. Keep step instructions self-contained
but avoid pasting large code blocks — reference file:line locations instead.

## Relationship to other skills

- **brainstorm** — uses cloud models for planning, then deploys implementation via delegate. The delegate skill described here is the implementation half of that workflow.
- **operate-multi-stage-refactor** — the binding-snapshot + damage-detection lifecycle. Delegate handles the code-editing half; operate-multi-stage-refactor handles the verification + memo lifecycle.
- **refactor-tui-conversion** — the TUI conversion procedure. Each conversion step is a delegate invocation.