"""extra-rare-agentic-bert: stack launcher for the rarebert desktop shell.

Responsibilities (simplified scope):
    1. Read the ``rest_server`` + new ``streaming`` blocks from ``config.json``.
    2. Launch the Python SSE bridge (formerly inline HTTP; now extracted into
       the same module as ``stream_subprocess.py``).
    3. Launch the Vite dev server for the Vue frontend.
    4. Tee both children's stdout/stderr to this process's stdout so the Scala
       Swing host can capture and display them in its log panel.
    5. Forward SIGINT/SIGTERM to both children, shut them down cleanly on exit.

Endpoints previously implemented here (``POST /``, ``/stream``, ``/repl``,
``/api/targets``, ``/health``) now live in ``stream_subprocess.py``, which is
launched as a child process below.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


# ─── Paths ───────────────────────────────────────────────────────────────────

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent
CONFIG_PATH = _REPO_ROOT / "config.json"

BRIDGE_SCRIPT = _HERE / "stream_subprocess.py"
VIEWER_DIR = _REPO_ROOT / "nlp-pipeline-viewer"


# ─── Configuration ───────────────────────────────────────────────────────────

DEFAULTS: dict[str, Any] = {
    "host": "127.0.0.1",
    "port": 8338,
    "shutdown_grace_seconds": 0.0,
    "vite_port": 5173,
    "log_prefix_vite": "[vite]",
    "log_prefix_bridge": "[bridge]",
}


def load_config() -> dict[str, Any]:
    cfg = dict(DEFAULTS)
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            for section in ("rest_server", "streaming"):
                if isinstance(data.get(section), dict):
                    for k, v in data[section].items():
                        if isinstance(v, (str, int, float)):
                            cfg[k] = v
    except FileNotFoundError:
        print(f"[launcher] config.json not found at {CONFIG_PATH}; using defaults",
              file=sys.stderr)
    except json.JSONDecodeError as exc:
        print(f"[launcher] config.json invalid: {exc}; using defaults",
              file=sys.stderr)
    return cfg


CONFIG = load_config()


# ─── Child process management ────────────────────────────────────────────────

class Child:
    """Wraps a subprocess with a line-level log forwarder."""

    def __init__(self, name: str, proc: subprocess.Popen, prefix: str) -> None:
        self.name = name
        self.proc = proc
        self.prefix = prefix
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start_logging(self) -> None:
        for stream, label in ((self.proc.stdout, "out"), (self.proc.stderr, "err")):
            if stream is None:
                continue
            t = threading.Thread(
                target=self._pump,
                args=(stream, label),
                name=f"{self.name}-{label}",
                daemon=True,
            )
            t.start()
            self._threads.append(t)

    def _pump(self, stream, label: str) -> None:
        for line in iter(stream.readline, b""):
            if self._stop.is_set():
                break
            try:
                text = line.decode("utf-8", errors="replace").rstrip()
            except Exception:
                text = repr(line)
            print(f"{self.prefix} {text}", flush=True)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def terminate(self, grace: float = 2.0) -> None:
        self._stop.set()
        if self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass
        try:
            self.proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            try:
                self.proc.kill()
            except Exception:
                pass


def _spawn_bridge() -> Child:
    if not BRIDGE_SCRIPT.exists():
        raise FileNotFoundError(f"bridge script missing: {BRIDGE_SCRIPT}")
    cmd = [
        sys.executable,
        str(BRIDGE_SCRIPT),
        "--host", str(CONFIG["host"]),
        "--port", str(CONFIG["port"]),
    ]
    print(f"[launcher] starting bridge: {' '.join(cmd)}", file=sys.stderr)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(_REPO_ROOT),
    )
    return Child("bridge", proc, str(CONFIG.get("log_prefix_bridge") or "[bridge]"))


def _spawn_vite() -> Child | None:
    if not VIEWER_DIR.exists():
        print(f"[launcher] viewer dir missing: {VIEWER_DIR}", file=sys.stderr)
        return None
    npm = shutil.which("npm")
    if npm is None:
        print("[launcher] npm not found on PATH; skipping Vite", file=sys.stderr)
        return None
    cmd = [
        npm, "run", "dev", "--", "--port", str(CONFIG["vite_port"]),
    ]
    print(f"[launcher] starting vite: {' '.join(cmd)}", file=sys.stderr)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(VIEWER_DIR),
    )
    return Child("vite", proc, str(CONFIG.get("log_prefix_vite") or "[vite]"))


def _wait_for_port(host: str, port: int, timeout: float = 30.0) -> bool:
    """Return True once TCP ``host:port`` accepts connections, else False."""
    import socket
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.25)
    return False


# ─── Signal handling ─────────────────────────────────────────────────────────

_children: list[Child] = []
_shutdown = threading.Event()


def _install_signal_handlers() -> None:
    def _handler(signum, frame):  # noqa: ARG001
        print(f"[launcher] received signal {signum}; shutting down",
              file=sys.stderr)
        _shutdown.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            pass


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    _install_signal_handlers()

    bridge = _spawn_bridge()
    bridge.start_logging()
    _children.append(bridge)

    vite = _spawn_vite()
    if vite is not None:
        vite.start_logging()
        _children.append(vite)

    # Block until the bridge accepts connections (or timeout).
    if _wait_for_port(str(CONFIG["host"]), int(CONFIG["port"]), timeout=15.0):
        print(
            f"[launcher] bridge ready at "
            f"http://{CONFIG['host']}:{CONFIG['port']}",
            file=sys.stderr,
        )
    else:
        print("[launcher] bridge failed to open port in time",
              file=sys.stderr)

    # Park here until either a child dies or we receive a shutdown signal.
    try:
        while not _shutdown.is_set():
            for child in _children:
                if not child.alive():
                    print(f"[launcher] {child.name} exited unexpectedly",
                          file=sys.stderr)
                    _shutdown.set()
                    break
            time.sleep(0.5)
    except KeyboardInterrupt:
        _shutdown.set()
    finally:
        for child in _children:
            child.terminate()
        print("[launcher] stopped", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())