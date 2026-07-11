"""add-notification: append an urgent reminder to reminders.py."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from devlib import arg_value, parse_kv_args, run


REMINDERS_PATH = Path("reminders.py")


def run_notify() -> None:
    """Call notify.py to print the updated reminders list."""
    subprocess.run([sys.executable, "notify.py"], check=True)


def add_urgent_reminder(text: str) -> None:
    """Insert URGENT=<text> as a new reminder in reminders.py's REMINDERS list."""
    source = REMINDERS_PATH.read_text(encoding="utf-8")

    escaped = text.replace('\\', '\\\\').replace('"', '\\"')
    entry = f'    "URGENT: {escaped}",'

    # Find the end of the REMINDERS list (last quoted entry followed by '],').
    match = re.search(r'^(\s+"[^"]*(?:"[^"]*")*[^"]*",?)\s*\]\s*,?$', source, re.MULTILINE)
    if not match:
        raise RuntimeError("Could not locate REMINDERS list in reminders.py")

    last_line = match.group(1)
    replacement = f"{last_line}\n{entry}\n]"
    new_source = source[:match.start()] + replacement + source[match.end():]
    REMINDERS_PATH.write_text(new_source, encoding="utf-8")


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        text = arg_value(args, "URGENT")
        if not text:
            raise ValueError("missing URGENT=<text>")
    except ValueError as exc:
        print(f"Error: {exc}")
        print("Usage: python3 add-notification.py URGENT='your urgent reminder'")
        return 2

    add_urgent_reminder(text)
    print(f"Added urgent reminder: {text}")
    run_notify()
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
