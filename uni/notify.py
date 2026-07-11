"""notify: generated module scaffold."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from devlib import run


# Default editor on this system is VS Code with blocking wait.
DEFAULT_EDITOR = "code --wait"


def resolve_editor() -> str:
    """Resolve the user's preferred editor, falling back to DEFAULT_EDITOR."""
    editor = os.environ.get("EDITOR", os.environ.get("VISUAL", "")).strip()
    if editor:
        return editor
    if shutil.which("vim"):
        return "vim"
    if shutil.which("vi"):
        return "vi"
    return DEFAULT_EDITOR


def resolve_symlink(link: Path) -> Path | None:
    """Resolve a symlink target, returning None if the link is broken."""
    if not link.is_symlink():
        return None
    target = link.resolve()
    return target if target.exists() else None


def find_ws_directories() -> list[Path]:
    """Find directories referenced by local .ntfy symlink files."""
    directories: list[Path] = []
    seen: set[Path] = set()

    for ntfy in Path(".").glob("*.ntfy"):
        target = resolve_symlink(ntfy)
        if target is None:
            continue
        directory = target.parent
        if directory not in seen:
            seen.add(directory)
            directories.append(directory)

    return directories


def open_editor(directory: Path) -> None:
    """Open the user-preferred editor at the given directory."""
    editor = resolve_editor()

    if editor in {"vim", "vi"}:
        subprocess.run([editor], cwd=str(directory), check=False)
    else:
        subprocess.run([*editor.split(), "."], cwd=str(directory), check=False)


def main() -> int:
    # Import here to avoid circular imports if reminders.py ever imports from us.
    from reminders import REMINDERS

    print("Reminders:")
    for reminder in REMINDERS:
        print(f"  - {reminder}")

    directories = find_ws_directories()
    if directories:
        print("\nNotification draft directories:")
        for directory in directories:
            print(f"  - {directory}")
        for directory in directories:
            open_editor(directory)
    else:
        print("\nNo .ntfy links found.")

    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
