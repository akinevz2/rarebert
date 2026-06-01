"""Send a prompt to an Ollama model.

Usage examples:
  python3 query.py WHOM=llama3.2 WHERE=localhost ASK="Hello"
  make query WHOM=llama3.2 WHERE=localhost ASK="Hello"
"""

from __future__ import annotations

import json
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from devlib import (
    env_or_arg,
    list_available_ollama_hosts,
    parse_kv_args,
    prompt_text,
    require_arg_or_prompt,
    run,
    run_with_spinner,
    select_ollama_host_tui,
)


def normalize_base_url(where_value: str) -> str:
    """Normalize WHERE into a full base URL.

    Accepted forms:
      localhost
      localhost:11434
      http://localhost:11434
    """
    where_value = where_value.strip().rstrip("/")
    if where_value.startswith(("http://", "https://")):
        return where_value

    host_port = where_value
    if re.search(r":\d+$", host_port):
        return f"http://{host_port}"

    return f"http://{host_port}:11434"


def query_ollama(base_url: str, model: str, prompt: str) -> str:
    """Call Ollama /api/generate and return response text."""
    endpoint = f"{base_url}/api/generate"
    payload = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode("utf-8")
    request = Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=None) as response:  # nosec B310: internal utility
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} from {endpoint}") from exc
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise RuntimeError(f"unable to reach {endpoint}: {reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON returned from {endpoint}") from exc

    text = data.get("response")
    if isinstance(text, str):
        return text

    raise RuntimeError(f"unexpected response shape from {endpoint}")


def discovered_model_suggestions() -> list[str]:
    """Collect model suggestions from persisted Ollama host scans."""
    names: list[str] = []
    seen: set[str] = set()
    for host in list_available_ollama_hosts():
        for model in host.get("models", []):
            candidate = str(model).strip()
            if candidate and candidate not in seen:
                seen.add(candidate)
                names.append(candidate)
    return names


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        where_value = env_or_arg(args, "WHERE")
        if not where_value:
            where_value = select_ollama_host_tui("Select an Ollama host for query")

        model_suggestions = discovered_model_suggestions()
        whom = env_or_arg(args, "WHOM")
        if not whom:
            whom = prompt_text("Model (WHOM)", suggestions=model_suggestions)

        ask = require_arg_or_prompt(args, "ASK", "Prompt (ASK)")
        base_url = normalize_base_url(where_value)
        answer = run_with_spinner("Waiting for model", query_ollama, base_url, whom, ask)
    except (ValueError, RuntimeError) as exc:
        print(f"Error: {exc}")
        print("Usage: python3 query.py WHOM=<model> WHERE=<host[:port]> ASK=<prompt>")
        return 2

    print(answer)
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
