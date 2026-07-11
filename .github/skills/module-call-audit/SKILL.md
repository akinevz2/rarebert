---
name: module-call-audit
description: "Use when operating in rarebert with make-first execution, module exploration, remote notification error logging, and mandatory .log updates after each go. Triggers: make target discovery, module touch audit, dots/dotfiles error pinpointing, and execution trace reporting."
argument-hint: "Goal, target repo path, optional error source path"
user-invocable: true
---

Rule number 1: avoid segmentation
Rule number 2: avoid segmentation faults


# Module Call Audit Workflow

## Outcome
Produce reproducible module-level actions in the workspace, execute through make where possible, and keep a running audit in .log after every go.

## When To Use
- Explore functional Python modules in this repository.
- Run module behavior through make targets.
- Pinpoint remote notification errors for dot repositories.
- Maintain an accessible audit trail of touched modules and actions.

## Procedure
1. Anchor location:
- Set working directory to the workspace root.
- If currently inside a subfolder and the request asks to run from parent, prepend cd .. && exactly once.

2. Discover make-first entrypoints:
- Run make help.
- Choose targets from the listed module names before calling Python files directly.

3. Explore modules with lightweight reads:
- Read only the needed module files.
- Identify module purpose, inputs, outputs, and side effects.

4. Execute through make:
- Prefer make <target> with ARG or ARGS.
- If interactive prompts block progress, provide explicit arguments to avoid prompt mode.

5. Remote notification error pinpointing:
- Validate candidate paths in home (for example: ~/dots, ~/dotfiles).
- Use add-repo-error target to append timestamped entries into REPO/ERROR.ntfy.
- Verify resulting file exists and inspect top lines for error signatures.
- Treat HTTP return codes 243 and 254 as dangerous indicators and flag them immediately.

6. Audit every go in .log:
- Record modules touched (read, executed, edited).
- Record key command outcome (success/failure + target path).
- Print .log after each action batch.

## Decision Points
- If a requested home path does not exist: pick the first existing candidate and log the decision.
- If a make target prompts for input: rerun with explicit ARG/ARGS.
- If a module is revoked/disabled: stop using it and log the revocation status.
- If status code 243 or 254 appears in logs or responses: classify as dangerous and prioritize isolation/removal actions.

## Completion Checks
- Requested operation finished through make interface where available.
- Error sink path is verified when logging is requested.
- .log includes the latest module-touch entries.
- .log is displayed after the go.
