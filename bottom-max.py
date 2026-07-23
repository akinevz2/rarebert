"""bottom-max: show last N lines/items of input (like tail).

Detects JSON array input and shows last N items, otherwise operates on raw lines."""

from __future__ import annotations

import json
import os
import sys
from devlib import run


def main() -> int:
    n = int(os.environ.get("ITEMS", "5"))
    
    # Check if stdin has data available (to avoid hanging when run directly)
    if sys.stdin.isatty():
        # No piped input, just exit gracefully
        return 0
    
    # Check if stdin has data available (to avoid hanging when run directly)
    if sys.stdin.isatty():
        # No piped input, just exit gracefully
        return 0
    
    # Read all input
    items = []
    try:
        while True:
            line = input()
            items.append(line)
    except EOFError:
        pass
    
    if not items:
        return 0
    
    full_text = "\n".join(items)
    stripped = full_text.strip()
    
    # Try to detect and parse JSON array
    try:
        data = json.loads(stripped)
        if isinstance(data, list):
            # Output last N items as formatted JSON
            result = data[-n:] if len(data) >= n else data
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
    except (json.JSONDecodeError, ValueError):
        pass
    
    # Fall back to raw item mode - show last N items
    for line in items[-n:]:
        print(line)
    
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
