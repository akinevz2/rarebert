---
name: delegate
description: Subagent patterns for opencode run with local or cloud models.
---

# Delegate

## Purpose

Launches `task` subagents that execute `opencode run` with a chosen model for file-editing work. The subagent runs the command and returns the literal output — it does NOT run verification commands (`node --check`, `grep`, etc.). Verification is the orchestrating agent's responsibility.

## Workflow

### Step 1 — Ask the user which model to use

Before launching any subagent, ask the user which model to run with:

- **Cloud**: `opencode/glm-5.2` — faster, higher quality reasoning, costs credits
- **Local**: `ollama/laguna-xs-2.1:q8_0` — slower, free, runs on local hardware

Use the `question` tool. If the user has already specified a model in their request, skip this step.

### Step 2 — Write the phase prompt to scratch

Write the implementation prompt to `.opencode/system/phaseN-<name>.md` (or `prompt.md` for a single phase). The prompt must be:

- **Self-contained**: each `opencode run` call is stateless. Include all context: file paths (relative to project root, e.g. `lib/core.mjs`), exact code blocks, constraints, and data-structure shapes.
- **Explicit about constraints**: state what NOT to change, code style to follow, and what to preserve.
- **Include exact code blocks**: provide the full code to insert, not descriptions.

### Step 3 — Launch the subagent

Launch a `task` subagent of type `general`. The subagent's ONLY job is to run the command and return its literal output. It must NOT run `node --check`, `grep`, or any other verification — it returns the raw `opencode run` result.

Subagent prompt template:

```
You are an implementation runner. Your job is to execute a single opencode run
command and return its literal output. Do NOT run any other commands (no
node --check, no grep, no git diff). Just run the command and report back the
raw output.

Run this command from /workspaces/development/personal/rarebert:

opencode run "$(cat .opencode/system/<prompt-file>)" -m <model> --auto

Use a 1440000ms timeout (24 minutes). Slower quantized models on large prompts
can take 20+ minutes. If the command times out, report that it timed out and
show whatever partial output was captured.

Report back: the literal stdout/stderr of the opencode run command. Do not
summarize or interpret — return the raw output.
```

### Step 4 — Verify yourself

After the subagent returns, the orchestrating agent runs verification:

```bash
node --check <each-touched-file>
grep -n "<expected-symbol>" <file-path>
git diff --name-only
```

If verification fails, either fix manually or re-launch the subagent with a corrected prompt.

### Step 5 — Parallelize independent phases

Independent phases (no data dependency between them) can be launched in the same message as multiple `task` tool calls — they run concurrently. Dependent phases must be sequential: wait for the prior subagent, verify, then launch the next.

## Command reference

```bash
opencode run "$(cat <prompt-file>)" -m <provider/model-id> --auto
```

- `--auto` — auto-approve permissions (required for non-interactive edits)
- `-m <model>` — model id with provider prefix
- Timeout: minimum 1440000ms (24 min) for local quantized models; cloud models are faster

## Models

| Model | Provider | Use case |
|-------|----------|----------|
| `opencode/glm-5.2` | opencode (cloud) | Fast, high-quality reasoning; costs credits |
| `ollama/laguna-xs-2.1:q8_0` | ollama (local) | Free, runs on local hardware; slower |

## Key principles

1. **Subagents only run the command** — they return literal output, no verification.
2. **Orchestrating agent verifies** — run `node --check` + `grep` yourself after the subagent returns.
3. **Self-contained prompts** — each `opencode run` call is stateless.
4. **Ask the user first** — confirm cloud vs local model before launching.
