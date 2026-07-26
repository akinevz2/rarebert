"""Shared utilities for generated development modules."""

from __future__ import annotations

import importlib
import json
import os
import readline
import re
import subprocess
import sys
import signal
import termios
import threading
import time
import tty
from contextlib import contextmanager
from importlib.util import find_spec
from pathlib import Path
from typing import Optional


LOCAL_DEPS_DIRNAME = ".rarebert_deps"
CONFIG_FILENAME = "config.json"

signal.signal(signal.SIGPIPE, signal.SIG_DFL)


class AppConfig:
    """File-backed JSON configuration shared by every rarebert module.

    The loader reads ``config.json`` from the current working directory on
    first access and caches the parsed blob.  Keys prefixed with ``_`` are
    treated as documentation and stripped from the public view.  Missing
    files cause an informative error so misconfigured deployments fail fast.
    """

    def __init__(self, raw: dict[str, object], source: Path) -> None:
        self._raw = raw
        self._source = source

    @classmethod
    def load(cls, path: Optional[Path] = None) -> "AppConfig":
        """Load config from ``path`` (default: ``./config.json``)."""
        target = Path(path) if path else Path.cwd() / CONFIG_FILENAME
        if not target.is_file():
            raise FileNotFoundError(
                f"config.json not found at {target}; expected central configuration"
            )
        with target.open("r", encoding="utf-8") as handle:
            return cls(json.load(handle), target)

    @property
    def source(self) -> Path:
        """Path the configuration was loaded from."""
        return self._source

    def section(self, name: str) -> dict[str, object]:
        """Return a configuration section, raising if missing."""
        if name not in self._raw:
            raise KeyError(f"missing config section '{name}' in {self._source}")
        return self._raw[name]

    def get(self, dotted_path: str, default: object = None) -> object:
        """Resolve a dotted path like ``paths.db_filename``."""
        node: object = self._raw
        for part in dotted_path.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node


_DEFAULT_CONFIG: Optional[AppConfig] = None


def get_config() -> AppConfig:
    """Return the process-wide ``AppConfig`` (lazy-loaded)."""
    global _DEFAULT_CONFIG
    if _DEFAULT_CONFIG is None:
        _DEFAULT_CONFIG = AppConfig.load()
    return _DEFAULT_CONFIG


def reset_config_cache() -> None:
    """Forget the cached config (useful for tests)."""
    global _DEFAULT_CONFIG
    _DEFAULT_CONFIG = None


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
        # Prioritize prefix matches, then fallback to generic substring matches.
        prefix = [item for item in options if item.lower().startswith(lowered)]
        contains = [
            item for item in options if lowered in item.lower() and not item.lower().startswith(lowered)
        ]
        return prefix + contains

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
    offset = 0

    while not stop_event.is_set():
        cells = [" "] * width
        for idx in range(block):
            # Wrap so the block continuously moves left-to-right without bouncing.
            at = (offset + idx) % width
            cells[at] = "="

        bar = "".join(cells)
        sys.stdout.write(f"\r{label} [{bar}]")
        sys.stdout.flush()

        time.sleep(0.08)
        offset = (offset + 1) % width

    sys.stdout.write("\r" + " " * (len(label) + width + 3) + "\r")
    sys.stdout.flush()


def run_with_spinner(label: str, fn, *args, **kwargs):
    """Run a function while showing an indefinite marquee spinner."""
    stop_event = threading.Event()
    box: dict[str, object] = {}

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


def has_piped_input() -> bool:
    """Check if stdin has piped input available.

    Uses select to non-blocking check for data on stdin. Returns True when
    stdin is not a TTY (i.e., data was redirected from a file or pipe).

    Returns:
        True if piped/redirected input is available, False otherwise.
    """
    import select
    return bool(select.select([sys.stdin], [], [], 0.0)[0])
