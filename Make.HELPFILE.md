# Make Helpfile

This document describes selected make targets as functional transformations.

## Target Mappings

### notify
PSEUDOCODE:
notify() -> (print(REMINDERS), open(D))
where D = set of directories referenced by local .ntfy symlinks

Behavior:
- Print reminders from `reminders.py`.
- Resolve local `.ntfy` symlink targets.
- Open each resolved target directory in the preferred editor.

### query
PSEUDOCODE:
query(WHERE, WHOM, ASK) -> ANSWER

Behavior:
- Resolve Ollama host and model (interactive fallback if omitted).
- Send a non-streaming request to `/api/generate`.
- Print the returned response text.

### reminders
PSEUDOCODE:
reminders(REMINDERS) -> reminders.rs

Behavior:
- Serialize reminders as newline-separated text.
- Verify `reminders.rs` byte-for-byte against expected content.
- Rewrite only when content differs.
- Print reminders.

### scan
PSEUDOCODE:
scan(Roots) -> (Archive(ERROR.ws), Extend(REMINDERS))

Behavior:
- Build scan roots from current directory, ancestors, children, and home-related paths.
- Collect `ERROR.ws` and `NOTIFY.ntfy` files.
- Archive each `ERROR.ws` to `ERRORS/<n>.ws`, then attempt removal of source file.
- Append each non-empty `NOTIFY.ntfy` message into reminders list.

### visualise-data
PSEUDOCODE:
visualise_data(TSV(label, text)) -> ANSI_colored_text -> pager_or_stdout

Behavior:
- Parse TSV rows.
- Apply deterministic color per tag.
- Highlight content between `<BOS>` and `<EOS>`.
- Render via pager (`less -R` preferred) or stdout fallback.

## Dispatch Rule

In this repository:
PSEUDOCODE:
for each registered target t:
	make t => python3 t.py
