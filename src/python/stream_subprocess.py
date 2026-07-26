"""stream_subprocess: SSE/HTTP bridge that streams `make` targets and a Python REPL.

Launched as a child process by ``extra-rare-agentic-bert.py``. Read its config
from the same ``config.json`` so the launcher and bridge agree on host/port.

Endpoints:
    POST /                -> legacy fire-and-forget JSON execution of a make target.
    GET  /stream?target=  -> Server-Sent Events stream of `make <target>` output.
    GET  /repl            -> Server-Sent Events stream of an interactive
                             ``python3 -i -u`` session (uses a PTY so
                             readline / prompts work).
    POST /repl/in         -> write one line of input to the active REPL's stdin.
    GET  /api/targets     -> JSON list of make targets discovered from the Makefile.
    GET  /health          -> 200 OK if the bridge is alive.
    GET  /status          -> JSON status (pid, uptime, active sessions).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pty
import select
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs


# ─── Paths & defaults ────────────────────────────────────────────────────────

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent
CONFIG_PATH = _REPO_ROOT / "config.json"

DEFAULTS: dict[str, Any] = {
    "host": "127.0.0.1",
    "port": 8338,
    "make_timeout_seconds": 300,
    "post_path": "/",
    "field_make_target": "make_target",
    "status_ok": "success",
    "output_field": "output",
    "makefile": "Makefile",
}


def load_config(host: str | None, port: int | None) -> dict[str, Any]:
    cfg = dict(DEFAULTS)
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("rest_server"), dict):
            for k, v in data["rest_server"].items():
                if isinstance(v, (str, int, float)):
                    cfg[k] = v
    except FileNotFoundError:
        print(f"[bridge] config.json not found at {CONFIG_PATH}; using defaults",
              file=sys.stderr)
    except json.JSONDecodeError as exc:
        print(f"[bridge] config.json invalid: {exc}; using defaults",
              file=sys.stderr)
    # CLI overrides win.
    if host is not None:
        cfg["host"] = host
    if port is not None:
        cfg["port"] = port
    return cfg


# ─── Global state ────────────────────────────────────────────────────────────

_last_activity = time.monotonic()
_activity_lock = threading.Lock()
_active_sessions: dict[str, "StreamingSession"] = {}
_should_terminate = threading.Event()


def _touch_activity() -> None:
    global _last_activity
    with _activity_lock:
        _last_activity = time.monotonic()


# ─── Streaming primitives ────────────────────────────────────────────────────

@dataclass
class StreamingSession:
    """Tracks one live subprocess tied to a client (SSE stream or REPL)."""

    session_id: str
    target: str = ""
    process: subprocess.Popen | None = None
    pty_master_fd: int = -1
    stop_event: threading.Event = field(default_factory=threading.Event)
    is_pty: bool = False
    _handler: Any = None  # set via .bind()

    def bind(self, handler: "RESTRequestHandler") -> None:
        self._handler = handler

    def emit_line(self, line: str) -> None:
        self._handler._sse_event("line", json.dumps({"line": line}))

    def emit_bytes(self, chunk: bytes) -> None:
        encoded = base64.b64encode(chunk).decode("ascii")
        self._handler._sse_event("bytes", json.dumps({"data": encoded}))

    def mark_done(self, returncode: int | None) -> None:
        rc = returncode if returncode is not None else -1
        try:
            self._handler._sse_event("done", json.dumps({"returncode": rc}))
        except _ClientGone:
            pass

    def terminate(self) -> None:
        self.stop_event.set()
        if self.process is not None and self.process.poll() is None:
            try:
                self.process.terminate()
            except Exception:
                pass
        if self.pty_master_fd >= 0:
            try:
                os.close(self.pty_master_fd)
            except Exception:
                pass
            self.pty_master_fd = -1


class _ClientGone(Exception):
    """Raised internally when the SSE client disconnects."""


def _iter_popen_lines(proc: subprocess.Popen) -> Iterator[str]:
    assert proc.stdout is not None
    for raw in proc.stdout:
        yield raw


def _iter_pty_bytes(master_fd: int) -> Iterator[bytes]:
    while True:
        try:
            r, _, _ = select.select([master_fd], [], [], 0.1)
        except (OSError, ValueError):
            return
        if not r:
            if not _should_terminate.is_set():
                continue
            return
        try:
            chunk = os.read(master_fd, 4096)
        except OSError:
            return
        if not chunk:
            return
        yield chunk


def spawn_make_streaming(target: str, session: StreamingSession) -> None:
    try:
        proc = subprocess.Popen(
            ["make", target],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as exc:
        session.emit_line(f"error: {exc}")
        session.mark_done(returncode=127)
        return
    session.process = proc
    for line in _iter_popen_lines(proc):
        if session.stop_event.is_set():
            proc.terminate()
            break
        session.emit_line(line.rstrip("\n"))
    proc.wait()
    session.mark_done(returncode=proc.returncode)


def spawn_repl(session: StreamingSession) -> None:
    master_fd, slave_fd = pty.openpty()
    session.pty_master_fd = master_fd
    session.is_pty = True

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["TERM"] = "xterm-256color"

    try:
        proc = subprocess.Popen(
            ["python3", "-i", "-u"],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            preexec_fn=os.setsid,
        )
    finally:
        os.close(slave_fd)
    session.process = proc

    for chunk in _iter_pty_bytes(master_fd):
        if session.stop_event.is_set():
            break
        try:
            session.emit_bytes(chunk)
        except Exception:
            break

    proc.wait()
    try:
        os.close(master_fd)
    except Exception:
        pass
    session.pty_master_fd = -1
    session.mark_done(returncode=proc.returncode)


def write_to_repl(session: StreamingSession, data: bytes) -> None:
    if session.pty_master_fd < 0:
        return
    try:
        os.write(session.pty_master_fd, data)
    except OSError:
        pass


# ─── Legacy helpers ──────────────────────────────────────────────────────────

def run_make_target(target: str, timeout: int) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["make", target],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        success = result.returncode == 0
        if not success:
            return (False, f"Make error for '{target}': {result.stderr}")
        return (success, result.stdout)
    except subprocess.TimeoutExpired:
        return (False, f"Timeout executing make {target}")
    except Exception as exc:
        return (False, str(exc))


def _discover_makefile_targets(makefile_name: str) -> list[str]:
    makefile = Path(makefile_name)
    if not makefile.is_absolute():
        makefile = _REPO_ROOT / makefile_name
    if not makefile.exists():
        return []
    targets: list[str] = []
    for raw in makefile.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(".PHONY"):
            continue
        if ":" in line and not line.startswith("\t") and "=" not in line.split(":")[0]:
            head = line.split(":", 1)[0].strip()
            if head and head.replace("_", "").isalnum():
                targets.append(head)
    return targets


# ─── HTTP handler ────────────────────────────────────────────────────────────

class RESTRequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the bridge."""

    server_version = "RarebertBridge/1.0"

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write(f"[bridge] {self.address_string()} {format % args}\n")

    # ── helpers ──────────────────────────────────────────────────────────────

    def _send_json(self, status_code: int, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse_start(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _sse_event(self, event: str, data: str) -> None:
        payload = f"event: {event}\ndata: {data}\n\n".encode("utf-8")
        try:
            self.wfile.write(payload)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise _ClientGone()

    def _parse_qs(self) -> dict[str, str]:
        parsed = urlparse(self.path)
        out: dict[str, str] = {}
        for k, v in parse_qs(parsed.query).items():
            if v:
                out[k] = v[0]
        return out

    # ── GET routes ───────────────────────────────────────────────────────────

    def do_GET(self) -> None:
        _touch_activity()
        path = urlparse(self.path).path

        if path == "/health":
            self._send_json(200, {"status": "ok"})
        elif path == "/status":
            self._send_json(200, {
                "pid": os.getpid(),
                "uptime": time.monotonic() - _last_activity,
                "active_sessions": list(_active_sessions.keys()),
            })
        elif path == "/api/targets":
            self._send_json(200, {
                "targets": _discover_makefile_targets(CONFIG["makefile"]),
            })
        elif path == "/stream":
            self._handle_stream()
        elif path == "/repl":
            self._handle_repl()
        else:
            self._send_json(404, {"error": f"Unknown path: {path}"})

    def _handle_stream(self) -> None:
        qs = self._parse_qs()
        target = qs.get("target", "").strip()
        if not target:
            self._send_json(400, {"error": "Missing 'target' query param"})
            return

        session_id = f"stream-{target}-{os.getpid()}-{time.monotonic_ns()}"
        session = StreamingSession(session_id=session_id, target=target)
        session.bind(self)
        _active_sessions[session_id] = session

        self._send_sse_start()
        self._sse_event("open", json.dumps({"session": session_id, "target": target}))

        try:
            spawn_make_streaming(target, session)
        except _ClientGone:
            pass
        finally:
            session.terminate()
            _active_sessions.pop(session_id, None)

    def _handle_repl(self) -> None:
        session_id = f"repl-{os.getpid()}-{time.monotonic_ns()}"
        session = StreamingSession(session_id=session_id, target="__repl__")
        session.bind(self)
        _active_sessions[session_id] = session

        self._send_sse_start()
        self._sse_event("open", json.dumps({"session": session_id, "mode": "repl"}))

        try:
            spawn_repl(session)
        except _ClientGone:
            pass
        finally:
            session.terminate()
            _active_sessions.pop(session_id, None)

    # ── POST routes ──────────────────────────────────────────────────────────

    def do_POST(self) -> None:
        _touch_activity()
        path = urlparse(self.path).path

        if path == CONFIG["post_path"]:
            self._handle_legacy_post()
        elif path == "/repl/in":
            self._handle_repl_input()
        else:
            self._send_json(404, {"error": f"Unknown path: {path}"})

    def _handle_legacy_post(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as exc:
            self._send_json(400, {"error": f"Bad request: {exc}"})
            return

        field = CONFIG["field_make_target"]
        target = data.get(field, "")
        if not target:
            self._send_json(400, {"error": f"Missing '{field}' field"})
            return

        success, output = run_make_target(target, int(CONFIG["make_timeout_seconds"]))
        if not success:
            self._send_json(500, {
                "error": f"Target '{target}' failed",
                CONFIG["output_field"]: output.splitlines() if output else [],
            })
            return

        if target == "join-stages":
            self._send_json(200, {
                CONFIG["status_ok"]: CONFIG["status_ok"],
                "target": target,
                CONFIG["output_field"]: output.splitlines() if output else [],
            })
            threading.Thread(
                target=lambda: (time.sleep(0.1), _should_terminate.set()),
                daemon=True,
            ).start()
            return

        self._send_json(200, {
            CONFIG["status_ok"]: CONFIG["status_ok"],
            "target": target,
            CONFIG["output_field"]: output.splitlines() if output else [],
        })

    def _handle_repl_input(self) -> None:
        repl_sessions = [s for s in _active_sessions.values() if s.target == "__repl__"]
        if not repl_sessions:
            self._send_json(409, {"error": "No active REPL session"})
            return
        session = repl_sessions[-1]
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = self.rfile.read(length) if length else b""
        except Exception as exc:
            self._send_json(400, {"error": f"Bad request: {exc}"})
            return
        write_to_repl(session, payload)
        self._send_json(200, {"status": "ok", "bytes": len(payload)})


# ─── Entry point ─────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Rarebert SSE bridge")
    parser.add_argument("--host", default=None,
                        help="override config.json host")
    parser.add_argument("--port", type=int, default=None,
                        help="override config.json port")
    args = parser.parse_args()

    global CONFIG
    CONFIG = load_config(args.host, args.port)

    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    host = str(CONFIG["host"])
    port = int(CONFIG["port"])

    try:
        server = ThreadingHTTPServer((host, port), RESTRequestHandler)
    except OSError as exc:
        print(f"[bridge] cannot bind {host}:{port} -> {exc}", file=sys.stderr)
        return 1

    print(f"[bridge] listening on http://{host}:{port}", file=sys.stderr)
    print(f"[bridge] pid={os.getpid()}", file=sys.stderr)

    try:
        while not _should_terminate.is_set():
            server.handle_request()
    finally:
        for session in list(_active_sessions.values()):
            session.terminate()
        server.server_close()
        print("[bridge] stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())