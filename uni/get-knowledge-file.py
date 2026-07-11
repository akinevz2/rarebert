"""Interactive browser for knowledge lexicon entries in rarebert.db."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from devlib import init_db, list_keys, load_data, prompt_text, run, tui_select


NAMESPACE = "knowledge_lexicon"
DB_PATH = "rarebert.db"


def _parse_key(key: str) -> tuple[str, str]:
    """Split key format word:technique into parts."""
    if ":" not in key:
        return key.strip(), ""
    word, technique = key.split(":", 1)
    return word.strip(), technique.strip()


def _namespace_keys() -> list[str]:
    """Return sorted keys for the configured namespace."""
    init_db()
    return list_keys(NAMESPACE)


def _read_value(prompt: str, suggestions: list[str] | None = None, allow_empty: bool = False) -> str:
    """Read interactive value with prompt_text, falling back to stdin when non-TTY."""
    if sys.stdin.isatty() and sys.stdout.isatty():
        return prompt_text(prompt, suggestions=suggestions, allow_empty=allow_empty)

    line = sys.stdin.readline()
    if line == "":
        if allow_empty:
            return ""
        raise ValueError(f"missing required input: {prompt}")
    value = line.strip()
    if value:
        return value
    if allow_empty:
        return ""
    raise ValueError(f"missing required input: {prompt}")


def _record_for_key(key: str) -> dict[str, Any] | None:
    """Load one record and ensure dictionary shape."""
    value = load_data(NAMESPACE, key)
    if isinstance(value, dict):
        return value
    return None


def _occurrence_count(record: dict[str, Any]) -> int:
    """Best-effort occurrence count extraction from record payload."""
    for field in ("occurrence_count", "count", "occurrences"):
        raw = record.get(field)
        if isinstance(raw, int):
            return raw
    context = record.get("context")
    if isinstance(context, list):
        return len(context)
    return 1


def _source_file(record: dict[str, Any]) -> str:
    """Best-effort source file extraction from dataset metadata."""
    dataset = record.get("dataset")
    if isinstance(dataset, str) and dataset.strip():
        return dataset.strip()
    if isinstance(dataset, dict):
        for candidate in ("file", "path", "source"):
            value = dataset.get(candidate)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return "unknown"


def menu_get() -> None:
    """Given one word:technique key, pretty print the record JSON."""
    keys = _namespace_keys()
    if not keys:
        print(f"No keys in namespace '{NAMESPACE}'.")
        return

    key = _read_value("Key (word:technique)", suggestions=keys)
    if key not in keys:
        print(f"Key not found: {key}")
        return

    record = _record_for_key(key)
    if record is None:
        print(f"No JSON object found for key: {key}")
        return

    print(json.dumps(record, ensure_ascii=False, indent=2))


def menu_search() -> None:
    """Given a word, list all stored word:technique variants."""
    keys = _namespace_keys()
    if not keys:
        print(f"No keys in namespace '{NAMESPACE}'.")
        return

    words = sorted({word for word, _ in (_parse_key(key) for key in keys) if word})
    word = _read_value("Word", suggestions=words)
    variants = sorted(key for key in keys if _parse_key(key)[0] == word)

    if not variants:
        print(f"No technique variants found for word: {word}")
        return

    print(f"Technique variants for '{word}':")
    for entry in variants:
        print(f"- {entry}")


def menu_list() -> None:
    """Browse alphabet -> words -> technique tree with count and source file."""
    keys = _namespace_keys()
    if not keys:
        print(f"No keys in namespace '{NAMESPACE}'.")
        return

    words = sorted({word for word, _ in (_parse_key(key) for key in keys) if word})
    if not words:
        print("No valid word:technique keys found.")
        return

    letters = sorted({word[0].upper() for word in words if word})
    print("Alphabet:")
    print(" ".join(letters))

    if sys.stdin.isatty() and sys.stdout.isatty():
        selected_letter = tui_select(letters, prompt="Select letter", default_index=0)
    else:
        selected_letter = _read_value("Selected letter", suggestions=letters).upper()

    filtered_words = sorted(
        word for word in words if word and word[0].upper() == selected_letter.upper()
    )
    if not filtered_words:
        print(f"No words found for letter: {selected_letter}")
        return

    print(f"Words starting with {selected_letter.upper()}:")
    for word in filtered_words:
        print(f"- {word}")

    if sys.stdin.isatty() and sys.stdout.isatty():
        selected_word = tui_select(filtered_words, prompt="Select word", default_index=0)
    else:
        selected_word = _read_value("Selected word", suggestions=filtered_words)

    matching_keys = sorted(key for key in keys if _parse_key(key)[0] == selected_word)
    if not matching_keys:
        print(f"No entries found for word: {selected_word}")
        return

    print(f"{selected_word}")
    for index, key in enumerate(matching_keys):
        _, technique = _parse_key(key)
        record = _record_for_key(key) or {}
        count = _occurrence_count(record)
        source = _source_file(record)
        branch = "└-" if index == len(matching_keys) - 1 else "|-"
        print(f"  {branch} {technique}  (count={count}, source={source})")


def menu_dump() -> None:
    """Stream the full namespace as one JSON array to stdout."""
    keys = _namespace_keys()

    sys.stdout.write("[")
    first = True
    for key in keys:
        record = _record_for_key(key)
        if record is None:
            continue

        entry = {"key": key, "value": record}
        if not first:
            sys.stdout.write(",\n")
        else:
            sys.stdout.write("\n")
        sys.stdout.write(json.dumps(entry, ensure_ascii=False))
        first = False

    if not first:
        sys.stdout.write("\n")
    sys.stdout.write("]\n")


def interactive_menu() -> int:
    """Run modal submenu loop until user exits."""
    options = ["LIST", "GET", "SEARCH", "DUMP", "EXIT"]

    while True:
        if sys.stdin.isatty() and sys.stdout.isatty():
            choice = tui_select(options, prompt="get-knowledge-file menu", default_index=0)
        else:
            choice = _read_value("Menu choice", suggestions=options).upper()

        if choice == "LIST":
            menu_list()
        elif choice == "GET":
            menu_get()
        elif choice == "SEARCH":
            menu_search()
        elif choice == "DUMP":
            menu_dump()
        elif choice == "EXIT":
            return 0
        else:
            print(f"Unknown menu option: {choice}")


def main() -> int:
    if not Path(DB_PATH).exists():
        init_db()
    return interactive_menu()


if __name__ == "__main__":
    raise SystemExit(run(main))
