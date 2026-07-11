"""scan: collect ERROR.ws files and NOTIFY.ntfy reminders from a search tree."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from devlib import run


ERRORS_DIR = Path("ERRORS")
ERROR_FILE = "ERROR.ws"
NOTIFY_FILE = "NOTIFY.ntfy"
REMINDERS_PATH = Path("reminders.py")


def add_reminder(text: str) -> None:
    """Append a reminder to reminders.py's REMINDERS list."""
    source = REMINDERS_PATH.read_text(encoding="utf-8")
    escaped = text.replace('\\', '\\\\').replace('"', '\\"')
    entry = f'    "{escaped}",'

    match = re.search(r'^(\s+"[^"]*(?:"[^"]*")*[^"]*",?)\s*\]\s*,?$', source, re.MULTILINE)
    if not match:
        raise RuntimeError("Could not locate REMINDERS list in reminders.py")

    last_line = match.group(1)
    replacement = f"{last_line}\n{entry}\n]"
    new_source = source[:match.start()] + replacement + source[match.end():]
    REMINDERS_PATH.write_text(new_source, encoding="utf-8")


def collect_scan_roots() -> list[Path]:
    """Build the union of folders to scan for ERROR.ws and NOTIFY.ntfy files."""
    roots: list[Path] = []
    seen: set[Path] = set()

    def add(path: Path) -> None:
        resolved = path.resolve()
        if resolved not in seen and resolved.exists():
            seen.add(resolved)
            roots.append(resolved)

    # Current folder and every ancestor folder.
    current = Path(".").resolve()
    for ancestor in [current, *current.parents]:
        add(ancestor)

    # Immediate children of current folder.
    for child in current.iterdir():
        if child.is_dir():
            add(child)

    # Path from /home to /home/user, where user is current user's home.
    home = Path.home().resolve()
    add(Path("/home"))
    for ancestor in home.parents:
        add(ancestor)
        if ancestor == Path("/home"):
            break
    add(home)

    # First-child folders of each ancestor from /home to /home/user.
    for ancestor in list(roots):
        if ancestor == home:
            continue
        try:
            for child in ancestor.iterdir():
                if child.is_dir():
                    add(child)
        except PermissionError:
            continue

    return roots


def scan_for_files(roots: list[Path]) -> tuple[list[Path], list[Path]]:
    """Scan roots for ERROR.ws and NOTIFY.ntfy files, in traversal order."""
    error_files: list[Path] = []
    notify_files: list[Path] = []

    for root in roots:
        try:
            for path in sorted(root.iterdir()):
                if path.is_file():
                    if path.name == ERROR_FILE:
                        error_files.append(path)
                    elif path.name == NOTIFY_FILE:
                        notify_files.append(path)
        except PermissionError:
            continue

    return error_files, notify_files


def archive_error_file(source: Path, index: int) -> Path:
    """Copy an ERROR.ws into ERRORS/<n>.ws with a provenance header."""
    ERRORS_DIR.mkdir(parents=True, exist_ok=True)
    destination = ERRORS_DIR / f"{index}.ws"

    original = source.read_text(encoding="utf-8")
    header = f"{source.name}\n---\n"
    destination.write_text(header + original, encoding="utf-8")
    return destination


def main() -> int:
    if not REMINDERS_PATH.exists():
        print(f"Error: {REMINDERS_PATH} not found")
        return 2

    roots = collect_scan_roots()
    print(f"Scanning {len(roots)} directories...")

    error_files, notify_files = scan_for_files(roots)

    if error_files:
        print(f"\nFound {len(error_files)} ERROR.ws file(s):")
        for idx, source in enumerate(error_files, start=1):
            destination = archive_error_file(source, idx)
            print(f"  [{idx}] {source} -> {destination}")
            try:
                source.unlink()
                print(f"       moved {source}")
            except OSError as exc:
                print(f"       could not remove {source}: {exc}")
    else:
        print("\nNo ERROR.ws files found.")

    if notify_files:
        print(f"\nFound {len(notify_files)} NOTIFY.ntfy file(s):")
        for source in notify_files:
            text = source.read_text(encoding="utf-8").strip()
            print(f"  - {source}: {text[:120]}")
            if text:
                add_reminder(text)
    else:
        print("\nNo NOTIFY.ntfy files found.")

    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
