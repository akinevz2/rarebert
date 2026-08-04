# Rarebert agent guide

## Scratch and temporary work

Prefer `.opencode/system/` for any temporary or scratch work — intermediate
files, drafts, notes, captured output, partial diffs, anything disposable.
Treat it as the project's private `/tmp`: create subdirectories freely, never
commit anything under it, and clean up your own scratch files when a task is
done unless asked to keep them.

Do not write scratch files to the project root, `lib/`, `scripts/`, `src/`,
or `system/`. Use `.opencode/system/` exclusively for ephemeral output.