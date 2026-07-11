"""Render a tagged TSV file in a pager with tag-based color coding."""

from __future__ import annotations

import csv
import hashlib
import os
import shlex
import subprocess
import sys
import re
from pathlib import Path

from devlib import parse_kv_args, require_arg_or_prompt, run


RESET = "\033[0m"
BOLD = "\033[1m"

TAG_COLORS = {
    "not_propaganda": "\033[32m",
    "loaded_language": "\033[31m",
    "flag_waving": "\033[33m",
    "appeal_to_fear_prejudice": "\033[35m",
    "doubt": "\033[36m",
    "repetition": "\033[34m",
    "name_calling,labeling": "\033[91m",
    "causal_oversimplification": "\033[95m",
}

PALETTE = [
    "\033[31m",
    "\033[32m",
    "\033[33m",
    "\033[34m",
    "\033[35m",
    "\033[36m",
    "\033[91m",
    "\033[92m",
    "\033[93m",
    "\033[94m",
    "\033[95m",
    "\033[96m",
]

def tsv_suggestions() -> list[str]:
    """Suggest TSV files from current directory tree for FILE prompt."""
    found = sorted(Path.cwd().glob("**/*.tsv"))
    return [str(path) for path in found[:80]]


def tag_color(tag: str) -> str:
    """Return a stable ANSI color for a tag."""
    if tag in TAG_COLORS:
        return TAG_COLORS[tag]

    digest = hashlib.sha1(tag.encode("utf-8")).digest()
    return PALETTE[digest[0] % len(PALETTE)]


def format_row(tag: str, text: str, is_header: bool = False) -> str:
    """Format one TSV row with tag-based color."""
    if is_header:
        return f"{BOLD}{tag}{RESET}\t{text}"

    color = tag_color(tag)
    return f"{color}{tag}{RESET}\t{highlight_span(text, color)}"


def highlight_span(text: str, color: str) -> str:
    """Color the text between <BOS> and <EOS> markers."""
    if not text:
        return text

    def replace(match: re.Match[str]) -> str:
        return f"<BOS>{BOLD}{color}{match.group(1)}{RESET}<EOS>"

    return re.sub(r"<BOS>(.*?)<EOS>", replace, text)


def render_tsv(path: Path) -> str:
    """Convert a tagged TSV file to a colored text block."""
    output_lines: list[str] = []

    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        for line_number, row in enumerate(reader):
            if not row:
                continue

            if line_number == 0 and len(row) >= 2 and row[0].lower() == "label":
                output_lines.append(format_row(row[0], "\t".join(row[1:]), is_header=True))
                continue

            tag = row[0]
            text = "\t".join(row[1:]) if len(row) > 1 else ""
            output_lines.append(format_row(tag, text))

    return "\n".join(output_lines) + ("\n" if output_lines else "")


def choose_pager() -> list[str]:
    """Pick a pager that can handle ANSI colors."""
    pager = os.environ.get("PAGER", "").strip()
    if pager:
        return shlex.split(pager)

    if shutil_which("less"):
        return ["less", "-R"]
    if shutil_which("more"):
        return ["more"]
    return []


def shutil_which(command: str) -> str | None:
    """Small local wrapper around shutil.which to keep imports tight."""
    from shutil import which

    return which(command)


def display(text: str) -> int:
    """Send text to a pager when available, otherwise print to stdout."""
    pager = choose_pager()
    if not pager or not sys.stdout.isatty():
        sys.stdout.write(text)
        return 0

    try:
        process = subprocess.Popen(pager, stdin=subprocess.PIPE, text=True)
        assert process.stdin is not None
        process.stdin.write(text)
        process.stdin.close()
        return process.wait()
    except OSError:
        sys.stdout.write(text)
        return 0


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        file_value = require_arg_or_prompt(
            args,
            "FILE",
            "TSV file path (FILE)",
            suggestions=tsv_suggestions(),
        )
        path = Path(file_value)
        if not path.exists():
            raise FileNotFoundError(f"file not found: {path}")

        rendered = render_tsv(path)
        return display(rendered)
    except (ValueError, FileNotFoundError) as exc:
        print(f"Error: {exc}")
        print("Usage: python3 visualise-data.py FILE=<path/to/propaganda_dataset_v2.tsv>")
        return 2


if __name__ == "__main__":
    raise SystemExit(run(main))
