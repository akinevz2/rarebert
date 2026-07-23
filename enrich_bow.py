"""enrich_bow: enrich JSON objects by adding span words as bag-of-words features.

Reads a stream of JSON objects from stdin and adds extracted span words
to each object, keyed by classification type."""

from __future__ import annotations

import json
import re
import sys
from devlib import run


def split_into_words(text: str) -> list[str]:
    """Split text into individual words (tokens), preserving original case."""
    # Use regex to extract word tokens, including contractions like "won't", "can't"
    # Match sequences of alphanumeric characters and apostrophes within words
    return re.findall(r"\b[a-zA-Z0-9]+(?:'[a-zA-Z0-9]+)?\b", text)


def enrich_item(item: dict) -> dict:
    """Enrich a single item with span words as bag-of-words features."""
    classification = item.get("classification", "not_propaganda")
    span = item.get("span", "")

    # Split span into individual words
    words = split_into_words(span)

    # Create enriched item copy
    enriched = dict(item)

    # Add bag-of-words field using the classification key directly (e.g., "not_propaganda")
    if classification not in enriched:
        enriched[classification] = []

    # Extend the existing list or create new one
    enriched[classification].extend(words)

    return enriched


def load_json_stream(stream) -> list[dict]:
    """Load JSON objects from a stream (line-delimited or array format)."""
    content = ""
    for line in stream:
        content += line
    
    stripped = content.strip()
    if not stripped:
        return []
    
    # Try to parse as single JSON value first
    try:
        data = json.loads(stripped)
        if isinstance(data, list):
            return data
        elif isinstance(data, dict):
            return [data]
    except json.JSONDecodeError:
        pass
    
    # Fall back to line-delimited JSON parsing
    items = []
    for line in stripped.split("\n"):
        line = line.strip()
        if not line or line in ("[", "]", ","):
            continue
        # Remove trailing comma if present
        if line.endswith(","):
            line = line[:-1]
        try:
            item = json.loads(line)
            items.append(item)
        except json.JSONDecodeError:
            continue
    
    return items


def main() -> int:
    try:
        # Load all JSON objects from stdin
        items = load_json_stream(sys.stdin)
        
        if not items:
            print("[]", file=sys.stderr)
            return 0
        
        # Enrich each item with span words
        enriched_items = [enrich_item(item) for item in items]
        
        # Output as JSON array
        print(json.dumps(enriched_items, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run(main))
