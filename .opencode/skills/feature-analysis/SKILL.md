---
name: feature-analysis
description: Delegate feature-request analysis and design/best-practices review to the tool-free analyst subagent before writing implementation code. Use when the user asks to implement a feature, add functionality, or wants design review and best practices first.
---

# Feature Analysis via Analyst Subagent

Before writing implementation code for a new feature or significant change, consult the `analyst` subagent (Task tool). The analyst runs on a completion-only model with no tools: it cannot read files, run commands, or access anything not included in your prompt.

## Workflow

1. Gather context yourself first: read the feature request, the relevant source files, and any project conventions (AGENTS.md, memos under .opencode/system/).
2. Launch the `analyst` subagent with a fully self-contained prompt containing:
   - The feature request verbatim
   - Relevant code excerpts, inlined (do not reference file paths alone — the analyst cannot open them)
   - Current architecture notes and constraints
   - Specific questions: approach options, trade-offs, risks, best practices, testing strategy
3. Integrate the returned analysis: summarize the recommendation for the user, note disagreements, then proceed with implementation if that was requested.
4. Only then write implementation code.

## Notes

- Never ask the analyst to read files or run commands — inline everything needed.
- For trivial changes, skip the delegation and proceed directly.
- The analyst complements the `delegate` and `brainstorm` skills: analyst first for design review, delegate for the local-LLM implementation steps.
