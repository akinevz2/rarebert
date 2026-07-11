"""add-repo-error: append a repository error note from an editor session."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from devlib import env_or_arg, parse_kv_args, run


ERROR_NTNY = "ERROR.ntfy"
ERROR_WS = "ERROR.ws"
MAKEFILE_LOG = "Makefile.log"


DEFAULT_MAKEFILE_LOG_RECIPE = """.PHONY: print install
print:
\t@stat ERROR.ntfy | grep -F 'ERROR.ntfy' || true
\t@cat ERROR.ntfy || true

install:
\t@if [ ! -f Makefile.log ]; then echo "Makefile.log not found"; exit 1; fi
\t@if [ -f Makefile ]; then \\
\t\tcat Makefile.log >> Makefile; \\
\t\trm Makefile.log; \\
\t\techo "Merged Makefile.log recipes into existing Makefile"; \\
\telse \\
\t\tmv Makefile.log Makefile; \\
\t\techo "Renamed Makefile.log to Makefile"; \\
\tfi
"""


def ensure_makefile_log_recipe() -> None:
    """Ensure Makefile.log exists and contains recipes if empty."""
    log_path = Path(MAKEFILE_LOG)
    if not log_path.exists() or log_path.stat().st_size == 0:
        log_path.write_text(DEFAULT_MAKEFILE_LOG_RECIPE, encoding="utf-8")


def create_symlink(local_name: Path, target: Path) -> None:
    """Replace local_name with a symlink pointing to target."""
    if local_name.exists() or local_name.is_symlink():
        local_name.unlink()
    local_name.symlink_to(target)


def validate_repo(path_str: str) -> Path:
    """Validate REPO exists on the filesystem and is non-empty."""
    repo = Path(path_str)
    if not repo.exists():
        raise ValueError(f"REPO does not exist: {repo}")
    if not repo.is_dir():
        raise ValueError(f"REPO is not a directory: {repo}")
    if not any(repo.iterdir()):
        raise ValueError(f"REPO is empty: {repo}")
    return repo


def next_local_archive_name() -> Path:
    """Return the next available ERROR.ws.N name in the current directory."""
    index = 1
    while True:
        candidate = Path(f"{ERROR_WS}.{index}")
        if not candidate.exists():
            return candidate
        index += 1


def open_editor(path: Path) -> None:
    """Open a text editor for the given file, blocking until it closes."""
    editor = os.environ.get("EDITOR", os.environ.get("VISUAL", "")).strip()
    if not editor:
        if shutil.which("vim"):
            editor = "vim"
        elif shutil.which("vi"):
            editor = "vi"
        else:
            editor = "code --wait"

    subprocess.run([*editor.split(), str(path)], check=False)


def append_error_note(repo: Path, note: str) -> None:
    """Append the note to ERROR.ntfy in the repository directory."""
    target = repo / ERROR_NTNY
    timestamp = datetime.now(timezone.utc).isoformat()
    with target.open("a", encoding="utf-8") as handle:
        handle.write(f"---\n{timestamp}\n{note}\n")


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        repo_path = env_or_arg(args, "REPO")
        if not repo_path:
            raise ValueError("missing REPO=<path>")
        repo = validate_repo(repo_path)

        ensure_makefile_log_recipe()

        error_path_str = env_or_arg(args, "ERROR")
        if error_path_str:
            note = Path(error_path_str).read_text(encoding="utf-8")
        else:
            draft = repo / ERROR_WS
            if not draft.exists():
                draft.write_text("", encoding="utf-8")
            else:
                archive_name = next_local_archive_name()
                shutil.move(str(draft), str(archive_name))
                draft.write_text("", encoding="utf-8")

            local_link = Path(ERROR_NTNY)
            create_symlink(local_link, draft)
            open_editor(local_link)

            if not draft.exists():
                raise ValueError(f"Editor did not create {draft}")
            note = draft.read_text(encoding="utf-8")
    except ValueError as exc:
        print(f"Error: {exc}")
        print("Usage: python3 add-repo-error.py REPO=<path> [ERROR=<file>]")
        return 2

    append_error_note(repo, note)

    print(f"Appended error note to {repo / ERROR_NTNY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
