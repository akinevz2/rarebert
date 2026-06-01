"""Check one or more hosts for a listening Ollama instance and list models.

Usage examples:
  python3 check-hosts.py HOST=localhost
  python3 check-hosts.py HOSTS=localhost,192.168.1.10 PORT=11434
"""

from __future__ import annotations

import json
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from devlib import env_or_arg, parse_kv_args, prompt_text, run, save_available_ollama_host


def parse_hosts(args: dict[str, str]) -> list[str]:
    """Derive host list from HOST or HOSTS arguments."""
    hosts: list[str] = []

    if "HOST" in args and args["HOST"]:
        hosts.append(args["HOST"])

    if "HOSTS" in args and args["HOSTS"]:
        hosts.extend(part.strip() for part in args["HOSTS"].split(",") if part.strip())

    if not hosts:
        hosts = ["localhost"]

    deduped: list[str] = []
    seen: set[str] = set()
    for host in hosts:
        if host not in seen:
            seen.add(host)
            deduped.append(host)

    return deduped


def parse_port(args: dict[str, str]) -> int:
    """Read and validate PORT argument."""
    raw_port = args.get("PORT", "11434")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ValueError(f"PORT must be an integer, got '{raw_port}'") from exc

    if port < 1 or port > 65535:
        raise ValueError(f"PORT must be in range 1-65535, got '{raw_port}'")

    return port


def request_ollama_models(host: str, port: int, timeout: float = 3.0) -> list[str]:
    """Return model names from an Ollama instance or raise an informative error."""
    url = f"http://{host}:{port}/api/tags"
    try:
        with urlopen(url, timeout=timeout) as response:  # nosec B310: internal utility
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} from {url}") from exc
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise RuntimeError(f"unable to reach {url}: {reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON returned from {url}") from exc

    models = data.get("models")
    if not isinstance(models, list):
        raise RuntimeError(f"unexpected response shape from {url}")

    names: list[str] = []
    for entry in models:
        if isinstance(entry, dict):
            name = entry.get("name")
            if isinstance(name, str) and name:
                names.append(name)

    return names


def print_host_report(host: str, port: int) -> list[str] | None:
    """Print health/model status for one host; return model list when reachable."""
    print(f"[{host}:{port}]")
    try:
        models = request_ollama_models(host, port)
    except RuntimeError as exc:
        print(f"  status: unavailable ({exc})")
        return None

    print("  status: listening")
    if models:
        print("  models:")
        for model in models:
            print(f"    - {model}")
    else:
        print("  models: (none)")

    return models


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])

        if not env_or_arg(args, "HOST") and not env_or_arg(args, "HOSTS"):
            entered = prompt_text(
                "Host (HOST) or comma-separated hosts (HOSTS)",
                default="localhost",
            )
            if "," in entered:
                args["HOSTS"] = entered
            else:
                args["HOST"] = entered

        if not env_or_arg(args, "PORT"):
            args["PORT"] = prompt_text("Port (PORT)", default="11434")

        hosts = parse_hosts(args)
        port = parse_port(args)
    except ValueError as exc:
        print(f"Error: {exc}")
        print("Usage: python3 check-hosts.py HOST=<name> [PORT=11434]")
        print("   or: python3 check-hosts.py HOSTS=<h1,h2,...> [PORT=11434]")
        return 2

    had_failure = False
    for host in hosts:
        models = print_host_report(host, port)
        if models is None:
            had_failure = True
            continue

        save_available_ollama_host(host=host, port=port, models=models)

    return 1 if had_failure else 0


if __name__ == "__main__":
    raise SystemExit(run(main))
