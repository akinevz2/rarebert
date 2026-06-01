"""Shared utilities for generated development modules."""

from __future__ import annotations

import importlib
import json
import os
import readline
import sqlite3
import subprocess
import sys
import termios
import threading
import time
import tty
from datetime import datetime, timezone
from collections.abc import Iterable
from contextlib import contextmanager
from importlib.util import find_spec
from pathlib import Path
from typing import Any


DB_FILENAME = "rarebert.db"
LOCAL_DEPS_DIRNAME = ".rarebert_deps"
OLLAMA_HOSTS_NAMESPACE = "available_hosts"


def todo(feature: str) -> None:
    """Raise a clear placeholder error for unfinished functionality."""
    raise NotImplementedError(f"Implement: {feature}")


def run(main_func) -> int:
    """Run a main function with a consistent KeyboardInterrupt exit code."""
    try:
        return int(main_func())
    except KeyboardInterrupt:
        return 130


def parse_kv_args(argv: list[str]) -> dict[str, str]:
    """Parse KEY=VALUE arguments into a dictionary with upper-case keys."""
    parsed: dict[str, str] = {}
    for raw in argv:
        if "=" not in raw:
            raise ValueError(f"invalid argument '{raw}', expected KEY=VALUE")

        key, value = raw.split("=", 1)
        key = key.strip().upper()
        value = value.strip()
        if not key:
            raise ValueError(f"invalid argument '{raw}', missing key")
        parsed[key] = value
    return parsed


def arg_value(args: dict[str, str], key: str, default: str = "") -> str:
    """Read an upper-case argument value, returning default if unset/blank."""
    value = args.get(key, "").strip()
    if value:
        return value
    return default


def env_bool(name: str, default: bool = False) -> bool:
    """Read a boolean from environment variables."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_or_arg(args: dict[str, str], key: str, fallback: str = "") -> str:
    """Resolve value from args first, then environment, then fallback."""
    value = arg_value(args, key)
    if value:
        return value
    raw = os.getenv(key, "").strip()
    if raw:
        return raw
    return fallback


@contextmanager
def _with_readline_completer(options: list[str]):
    """Temporarily install a readline completer for TAB completion."""
    original_completer = readline.get_completer()
    original_delims = readline.get_completer_delims()

    sorted_options = sorted(set(options))

    def completer(text: str, state: int) -> str | None:
        matches = [opt for opt in sorted_options if opt.lower().startswith(text.lower())]
        if state < len(matches):
            return matches[state]
        return None

    readline.set_completer(completer)
    readline.parse_and_bind("tab: complete")
    readline.set_completer_delims("\n")
    try:
        yield
    finally:
        readline.set_completer(original_completer)
        readline.set_completer_delims(original_delims)


def prompt_text(
    prompt: str,
    default: str = "",
    suggestions: list[str] | None = None,
    allow_empty: bool = False,
) -> str:
    """Prompt user for free text with optional TAB autocomplete."""
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        if default or allow_empty:
            return default
        raise ValueError(f"missing required input: {prompt}")

    suffix = f" [{default}]" if default else ""
    label = f"{prompt}{suffix}: "

    with _with_readline_completer(suggestions or []):
        while True:
            entered = input(label).strip()
            if entered:
                return entered
            if default:
                return default
            if allow_empty:
                return ""
            print("A value is required.")


def _read_key() -> str:
    """Read one key press in raw mode."""
    fd = sys.stdin.fileno()
    old_attrs = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        first = sys.stdin.read(1)
        if first == "\x1b":
            second = sys.stdin.read(1)
            third = sys.stdin.read(1)
            return first + second + third
        return first
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)


def tui_select(
    options: list[str],
    prompt: str = "Select an option",
    default_index: int = 0,
) -> str:
    """Arrow-key interactive selector with query filter and TAB autocomplete."""
    if not options:
        raise ValueError("no options available for selection")

    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return options[max(0, min(default_index, len(options) - 1))]

    query = ""
    index = max(0, min(default_index, len(options) - 1))
    drawn_lines = 0

    def filtered() -> list[str]:
        if not query:
            return options
        lowered = query.lower()
        return [item for item in options if lowered in item.lower()]

    while True:
        matches = filtered()
        if not matches:
            index = 0
        else:
            index = max(0, min(index, len(matches) - 1))

        rows: list[str] = []
        rows.append(prompt)
        rows.append(f"Filter (TAB autocomplete, ENTER select, q cancel): {query}")
        visible = matches[:12] if matches else []
        if not visible:
            rows.append("  (no matches)")
        for idx, item in enumerate(visible):
            marker = ">" if idx == index else " "
            rows.append(f" {marker} {item}")

        if drawn_lines:
            sys.stdout.write(f"\x1b[{drawn_lines}F")

        for row in rows:
            sys.stdout.write("\r\x1b[2K" + row + "\n")

        for _ in range(max(0, drawn_lines - len(rows))):
            sys.stdout.write("\r\x1b[2K\n")

        sys.stdout.flush()
        drawn_lines = len(rows)

        key = _read_key()
        if key in {"\r", "\n"}:
            if not matches:
                continue
            sys.stdout.write(f"\x1b[{drawn_lines}F")
            for _ in range(drawn_lines):
                sys.stdout.write("\r\x1b[2K\n")
            sys.stdout.write(f"\x1b[{drawn_lines}F")
            sys.stdout.flush()
            return matches[index]
        if key == "\x1b[A":  # up
            index = max(0, index - 1)
        elif key == "\x1b[B":  # down
            index = min(max(len(matches) - 1, 0), index + 1)
        elif key == "\t":  # tab autocomplete to first startswith
            if query:
                starts = [item for item in options if item.lower().startswith(query.lower())]
                if starts:
                    query = starts[0]
            elif matches:
                query = matches[index]
        elif key in {"\x7f", "\b"}:  # backspace
            query = query[:-1]
            index = 0
        elif key.lower() == "q":
            raise ValueError("selection cancelled")
        elif len(key) == 1 and key.isprintable():
            query += key
            index = 0


def require_arg_or_prompt(
    args: dict[str, str],
    key: str,
    prompt: str,
    default: str = "",
    suggestions: list[str] | None = None,
) -> str:
    """Resolve a required arg, prompting via TUI when missing."""
    value = env_or_arg(args, key, default)
    if value.strip():
        return value.strip()
    return prompt_text(prompt, default=default, suggestions=suggestions, allow_empty=False)


def render_marquee_bar(stop_event: threading.Event, label: str = "Working") -> None:
    """Render an indefinite marquee-style ASCII progress bar."""
    if not sys.stdout.isatty():
        while not stop_event.wait(0.5):
            pass
        return

    width = 28
    block = 7
    pos = 0
    direction = 1

    while not stop_event.is_set():
        cells = [" "] * width
        for idx in range(block):
            at = pos + idx
            if 0 <= at < width:
                cells[at] = "="

        bar = "".join(cells)
        sys.stdout.write(f"\r{label} [{bar}]")
        sys.stdout.flush()

        time.sleep(0.08)
        pos += direction
        if pos <= 0:
            pos = 0
            direction = 1
        elif pos >= width - block:
            pos = width - block
            direction = -1

    sys.stdout.write("\r" + " " * (len(label) + width + 3) + "\r")
    sys.stdout.flush()


def run_with_spinner(label: str, fn, *args, **kwargs):
    """Run a function while showing an indefinite marquee spinner."""
    stop_event = threading.Event()
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box["value"] = fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc
        finally:
            stop_event.set()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    try:
        render_marquee_bar(stop_event, label=label)
    except KeyboardInterrupt as exc:
        stop_event.set()
        raise RuntimeError("operation interrupted by user") from exc

    thread.join()
    if "error" in box:
        raise RuntimeError(str(box["error"])) from box["error"]
    return box.get("value")


def database_path(base_dir: str | Path | None = None) -> Path:
    """Return the path to the project-local SQLite database."""
    root = Path(base_dir) if base_dir is not None else Path.cwd()
    return root / DB_FILENAME


@contextmanager
def db_connection(base_dir: str | Path | None = None) -> Iterable[sqlite3.Connection]:
    """Yield a SQLite connection with dict-like row access."""
    path = database_path(base_dir)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(base_dir: str | Path | None = None) -> Path:
    """Create required tables for abstract module persistence."""
    path = database_path(base_dir)
    with db_connection(base_dir) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kv_store (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (namespace, key)
            )
            """
        )
    return path


def save_data(namespace: str, key: str, value: Any, base_dir: str | Path | None = None) -> None:
    """Persist a JSON-serialisable value into rarebert.db."""
    if not namespace.strip() or not key.strip():
        raise ValueError("namespace and key must be non-empty")

    init_db(base_dir)
    payload = json.dumps(value)
    with db_connection(base_dir) as conn:
        conn.execute(
            """
            INSERT INTO kv_store (namespace, key, value_json, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(namespace, key)
            DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            """,
            (namespace, key, payload),
        )


def load_data(namespace: str, key: str, default: Any = None, base_dir: str | Path | None = None) -> Any:
    """Load a stored value by namespace/key, returning default when absent."""
    init_db(base_dir)
    with db_connection(base_dir) as conn:
        row = conn.execute(
            "SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?",
            (namespace, key),
        ).fetchone()

    if row is None:
        return default

    return json.loads(str(row["value_json"]))


def list_keys(namespace: str, base_dir: str | Path | None = None) -> list[str]:
    """Return all keys stored in a namespace."""
    init_db(base_dir)
    with db_connection(base_dir) as conn:
        rows = conn.execute(
            "SELECT key FROM kv_store WHERE namespace = ? ORDER BY key",
            (namespace,),
        ).fetchall()
    return [str(row["key"]) for row in rows]


def delete_data(namespace: str, key: str, base_dir: str | Path | None = None) -> bool:
    """Delete one namespaced value; returns True when an entry was removed."""
    init_db(base_dir)
    with db_connection(base_dir) as conn:
        result = conn.execute(
            "DELETE FROM kv_store WHERE namespace = ? AND key = ?",
            (namespace, key),
        )
        return result.rowcount > 0


def local_deps_path(base_dir: str | Path | None = None) -> Path:
    """Return the path for project-local third-party Python packages."""
    root = Path(base_dir) if base_dir is not None else Path.cwd()
    return root / LOCAL_DEPS_DIRNAME


def ensure_local_packages(
    requirements: list[tuple[str, str]],
    base_dir: str | Path | None = None,
) -> Path:
    """Install/import required packages into a project-local dependency folder.

    requirements entries are (pip_requirement, import_name).
    """
    target = local_deps_path(base_dir)
    target.mkdir(parents=True, exist_ok=True)

    if str(target) not in sys.path:
        sys.path.insert(0, str(target))

    missing_specs: list[str] = []
    for pip_spec, import_name in requirements:
        try:
            importlib.import_module(import_name)
        except ModuleNotFoundError:
            missing_specs.append(pip_spec)

    if missing_specs:
        if find_spec("pip") is None:
            try:
                subprocess.run(
                    [sys.executable, "-m", "ensurepip", "--upgrade"],
                    check=True,
                )
            except subprocess.CalledProcessError:
                # Debian-based images may omit ensurepip; install python3-pip as a fallback.
                subprocess.run(["sudo", "apt-get", "update"], check=True)
                subprocess.run(["sudo", "apt-get", "install", "-y", "python3-pip"], check=True)

        command = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--quiet",
            "--target",
            str(target),
            *missing_specs,
        ]
        try:
            subprocess.run(command, check=True)
        except subprocess.CalledProcessError as exc:
            # Some base images omit pip; bootstrap it on-demand without global shell changes.
            if "No module named pip" in str(exc):
                subprocess.run(
                    [sys.executable, "-m", "ensurepip", "--upgrade"],
                    check=True,
                )
                subprocess.run(command, check=True)
            else:
                raise

    # Ensure imports can resolve immediately after installation.
    importlib.invalidate_caches()
    return target


def save_available_ollama_host(host: str, port: int, models: list[str] | None = None) -> None:
    """Persist a reachable Ollama host into the shared SQLite store."""
    cleaned_host = host.strip()
    if not cleaned_host:
        raise ValueError("host must not be empty")

    key = f"{cleaned_host}:{port}"
    payload = {
        "host": cleaned_host,
        "port": int(port),
        "models": sorted(models or []),
        "last_seen_utc": datetime.now(timezone.utc).isoformat(),
    }
    save_data(OLLAMA_HOSTS_NAMESPACE, key, payload)


def list_available_ollama_hosts() -> list[dict[str, Any]]:
    """Return persisted Ollama hosts sorted by most recently seen first."""
    hosts: list[dict[str, Any]] = []
    for key in list_keys(OLLAMA_HOSTS_NAMESPACE):
        record = load_data(OLLAMA_HOSTS_NAMESPACE, key)
        if not isinstance(record, dict):
            continue
        host = str(record.get("host", "")).strip()
        port_value = record.get("port", 11434)
        try:
            port = int(port_value)
        except (TypeError, ValueError):
            port = 11434
        if not host:
            continue

        models = record.get("models", [])
        if not isinstance(models, list):
            models = []

        hosts.append(
            {
                "host": host,
                "port": port,
                "models": [str(model) for model in models],
                "last_seen_utc": str(record.get("last_seen_utc", "")),
            }
        )

    hosts.sort(key=lambda item: item.get("last_seen_utc", ""), reverse=True)
    return hosts


def select_ollama_host_tui(prompt: str = "Select an Ollama host") -> str:
    """Interactively select one persisted Ollama host and return host:port."""
    hosts = list_available_ollama_hosts()
    if not hosts:
        raise ValueError(
            "no available hosts in database; run check-hosts first to populate available-hosts"
        )

    choices: list[str] = []
    endpoint_by_choice: dict[str, str] = {}
    for item in hosts:
        models = item["models"]
        model_text = ", ".join(models[:3]) if models else "no models listed"
        if len(models) > 3:
            model_text += ", ..."
        endpoint = f"{item['host']}:{item['port']}"
        display = f"{endpoint} ({model_text})"
        endpoint_by_choice[display] = endpoint
        choices.append(display)

    selected = tui_select(choices, prompt=prompt, default_index=0)
    return endpoint_by_choice[selected]
