"""Build a JSON training set from propaganda TSV files."""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

from devlib import parse_kv_args, require_arg_or_prompt, run


def tsv_suggestions() -> list[str]:
    """Suggest TSV files from current directory tree for FILE prompt."""
    found = sorted(Path.cwd().glob("**/*.tsv"))
    return [str(path) for path in found[:80]]


def normalize_spaces(text: str) -> str:
    """Collapse repeated whitespace into single spaces."""
    return re.sub(r"\s+", " ", text).strip()


def extract_span_and_clean(raw_data: str) -> tuple[str, str]:
    """Extract BOS/EOS span and clean marker-free text."""
    span_match = re.search(r"<BOS>\s*(.*?)\s*<EOS>", raw_data, flags=re.DOTALL)
    span = normalize_spaces(span_match.group(1)) if span_match else ""
    clean = normalize_spaces(raw_data.replace("<BOS>", "").replace("<EOS>", ""))
    return span, clean


def load_training_set(file_path: Path) -> list[dict[str, str]]:
    """Load TSV rows and map each one into the training-set JSON shape."""
    result: list[dict[str, str]] = []
    with file_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        for index, row in enumerate(reader):
            if not row:
                continue
            if index == 0 and row[0].strip().lower() in {"label", "class", "classification"}:
                continue

            classification = row[0].strip()
            raw_data = "\t".join(row[1:]).strip() if len(row) > 1 else ""
            span, clean = extract_span_and_clean(raw_data)

            result.append(
                {
                    "classification": classification,
                    "raw_data": raw_data,
                    "span": span,
                    "clean": clean,
                }
            )
    return result


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        file_value = require_arg_or_prompt(
            args,
            "FILE",
            "TSV file path (FILE)",
            suggestions=tsv_suggestions(),
        )
        file_path = Path(file_value)
        if not file_path.exists():
            raise FileNotFoundError(f"file not found: {file_path}")

        payload = load_training_set(file_path)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, FileNotFoundError) as exc:
        print(f"Error: {exc}")
        print("Usage: python3 get-training-set.py FILE=<path/to.tsv>")
        return 2


if __name__ == "__main__":
    raise SystemExit(run(main))
