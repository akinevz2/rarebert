"""List known usable Ollama hosts and their installed models."""

from __future__ import annotations

from devlib import list_available_ollama_hosts, run


def main() -> int:
    hosts = list_available_ollama_hosts()
    if not hosts:
        print("No usable hosts found. Run: make check-hosts HOST=<ip-or-host>")
        return 0

    for host in hosts:
        endpoint = f"{host['host']}:{host['port']}"
        print(f"[{endpoint}]")
        models = host.get("models", [])
        if models:
            for model in models:
                print(f"  - {model}")
        else:
            print("  - (no models reported)")
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
