---
name: subagent-step-template
description: Template for specifying delegation step prompts for subagent execution via implement.mjs
---

# Subagent Step Prompt Template

## Purpose

This template defines the structure for a delegation step prompt that can be used with `implement.mjs` to delegate code editing tasks to a local LLM model. Each step prompt is self-contained and targets a specific, independent change.

## Step Prompt Structure

A step prompt file (e.g., `.opencode/system/step1.txt`) should follow this exact format:

```
### Task Description
<description of what needs to be done>

### Target File(s)
<relative path to file(s) to edit>

### Change Details
- **What to change**: <specific code change or addition>
- **Where in file**: <line number or code context, e.g., "after line 42", "in the parse method">
- **What NOT to change**: <any constraints or existing code that must remain unchanged>
- **Code patterns to follow**: <any existing patterns from neighboring code, e.g., "use console.dir({ tui, cli }) as shown in module.mjs:1105">

### Constraints
- <constraint 1>
- <constraint 2>
- <constraint 3>

### Verification
After implementation, verify with:
- `node --check <file>`
- Any relevant `make check` or test command

### Example

```
### Task Description
Add a create() method in module.mjs that accepts a relative path argument

### Target File(s)
lib/module.mjs

### Change Details
- **What to change**: Add a static create() method to the Module class
- **Where in file**: At the end of the file, after the tui singleton
- **What NOT to change**: Do not modify existing Module class methods or the tui singleton
- **Code patterns to follow**: Follow the existing code style in module.mjs, use import() for dynamic import, console.warn for warnings, console.dir for output

### Constraints
- Method must accept a single relative path argument
- Must use dynamic import() syntax
- Must check if result is instanceof Module and log warning if not
- Must print result with console.dir({ tui, cli })
- Must catch and log import errors

### Verification
- `node --check lib/module.mjs`
- Manual test: `node -e "import('./lib/module.mjs').then(m => Module.create('./scripts/commit.mjs'))"`
```

## Subagent Execution Instructions

When passing this prompt to a subagent via `implement.mjs`, include these explicit instructions:

```
Run this command: node scripts/implement.mjs <target-file> -m ollama/<model> --auto --prompt "$(cat .opencode/system/stepN.txt)"

Do NOT edit files directly. The implement.mjs command invokes the local LLM via `opencode run --auto` which performs the edits. You only run the command and report output.

You MAY fix trivial syntax errors (missing semicolons, unused imports) directly. You must NOT perform architectural changes — report divergence and suggest fixup steps instead.

If the implement.mjs output diverges from the instruction (wrong files changed, different approach taken, partial implementation), do NOT proceed to verification. Instead, retry the implement.mjs command with the same prompt. If the second attempt also diverges, report the divergence to the orchestrating agent and suggest fixup steps.

Use NO timeout shorter than 1800s (30 min). A long-running command is normal for local ollama models. Do NOT assume the backend is unavailable if the command takes a long time.

Skip the stdout/stderr report if implement.mjs exited successfully (exit 0 and no error output) — simply confirm success. Only report the literal stdout/stderr when the command failed, diverged from the instruction, or produced warnings/diagnostics.
```

## Workflow Integration

1. **Create step prompt**: Write the step prompt to `.opencode/system/stepN.txt` following the template above
2. **Dispatch subagent**: Launch a `task` subagent of type `general` with the implement.mjs command
3. **Verify**: After subagent returns, run `node --check` on modified files and verify changes match the step instruction
4. **Handle divergence**: If changes diverge from the instruction, add fixup/corrective todos and dispatch via implement.mjs
5. **Final verification**: After all todos complete, re-verify with `node --check` on every touched file

## Checklist for Step Prompt Quality

- [ ] Task description is clear and self-contained
- [ ] Target file path is correct and relative to project root
- [ ] Change details specify exact location (line numbers or code context)
- [ ] Constraints are explicit about what NOT to change
- [ ] Code patterns reference existing patterns in the codebase
- [ ] Verification commands are specified and runnable
- [ ] No architectural assumptions or design decisions are included