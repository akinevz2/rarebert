"""stream_subprocess: SSE/HTTP bridge that streams ``make`` targets and a Python REPL.

Launched as a child process by ``extra-rare-agentic-bert.py``.  The bridge
is structured around a handful of small classes:

    * :class:`Channel`      — protocol-specific sink for events
      (``SseChannel`` writes to an HTTP response, ``MemoryChannel`` is a
      test double).
    * :class:`Shell`        — validates one command line into an argv list
      (``MakeShell``, ``PythonReplShell``).
    * :class:`Command`      — spawns one subprocess and pumps output
      (``SubprocessCommand``, ``ReplCommand``).
    * :class:`Session`      — owns one ``Command`` + one ``Channel`` and
      threads the output.
    * :class:`SessionRegistry` — central map of live sessions.
    * :class:`BridgeHTTPHandler` — tiny router, knows only URLs.

Endpoints (unchanged from the original):
    POST /                -> legacy fire-and-forget JSON execution.
    GET  /stream?target=  -> SSE stream of ``make <target>`` output.
    GET  /repl            -> SSE stream of an interactive Python session.
    POST /repl/in         -> write one line of input to the active REPL.
    POST /api/run-stream  -> SSE stream of a sandboxed ``make`` command.
    GET  /api/targets     -> JSON list of make targets.
    GET  /health          -> 200 OK if the bridge is alive.
    GET  /status          -> JSON status.
    POST /shutdown        -> graceful exit.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pty
import re
import select
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, ClassVar
from urllib.parse import parse_qs, urlparse


# ─── Paths & config ──────────────────────────────────────────────────────────

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
    if host is not None:
        cfg["host"] = host
    if port is not None:
        cfg["port"] = port
    return cfg


CONFIG: dict[str, Any] = load_config(None, None)


# ─── Exceptions ──────────────────────────────────────────────────────────────

class BridgeError(Exception):
    """Base class for bridge-originated errors."""


class ShellError(BridgeError):
    """The shell rejected a command line."""


class CommandError(BridgeError):
    """Spawning or driving a subprocess failed."""


class _ClientGone(BridgeError):
    """The SSE/HTTP client disconnected mid-stream."""


# ─── Channel ─────────────────────────────────────────────────────────────────

class Channel(ABC):
    """Sink for output events from a :class:`Command`.

    Subclasses know how to transport events to the outside world
    (SSE, websocket, in-memory list for tests, ...).  The bridge
    itself never instantiates one — :class:`Session` asks the route
    handler for one and passes it on.
    """

    @abstractmethod
    def open(self, meta: dict[str, Any]) -> None:
        """Begin a session; ``meta`` is sent verbatim as an ``open`` frame."""

    @abstractmethod
    def emit_line(self, line: str) -> None:
        """Forward one line of stdout (or stderr) text."""

    @abstractmethod
    def emit_bytes(self, chunk: bytes) -> None:
        """Forward raw bytes (used by the PTY-backed REPL channel)."""

    @abstractmethod
    def emit_done(self, returncode: int, **extra: Any) -> None:
        """Mark the session finished; ``returncode`` is the child's exit code."""

    @abstractmethod
    def close(self) -> None:
        """Tear down the transport (flush buffers, close socket, ...)."""


class SseChannel(Channel):
    """Write events as ``text/event-stream`` to an HTTP handler."""

    def __init__(self, handler: BaseHTTPRequestHandler) -> None:
        self._handler = handler
        self._closed = False

    def _write(self, event: str, payload: dict[str, Any]) -> None:
        body = f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
        try:
            self._handler.wfile.write(body)
            self._handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise _ClientGone()

    def open(self, meta: dict[str, Any]) -> None:
        self._handler.send_response(200)
        self._handler.send_header("Content-Type", "text/event-stream")
        self._handler.send_header("Cache-Control", "no-cache")
        self._handler.send_header("Connection", "keep-alive")
        self._handler.send_header("X-Accel-Buffering", "no")
        self._handler.end_headers()
        self._write("open", meta)

    def emit_line(self, line: str) -> None:
        self._write("line", {"line": line})

    def emit_bytes(self, chunk: bytes) -> None:
        self._write("bytes", {"data": base64.b64encode(chunk).decode("ascii")})

    def emit_done(self, returncode: int, **extra: Any) -> None:
        payload: dict[str, Any] = {"returncode": returncode}
        payload.update(extra)
        try:
            self._write("done", payload)
        except _ClientGone:
            pass

    def close(self) -> None:
        # The HTTP response stream stays open; we just stop emitting.
        self._closed = True


class MemoryChannel(Channel):
    """In-memory event recorder for tests.  No transport involved."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.closed = False

    def open(self, meta: dict[str, Any]) -> None:
        self.events.append(("open", meta))

    def emit_line(self, line: str) -> None:
        self.events.append(("line", {"line": line}))

    def emit_bytes(self, chunk: bytes) -> None:
        self.events.append(("bytes", {"data": chunk}))

    def emit_done(self, returncode: int, **extra: Any) -> None:
        payload: dict[str, Any] = {"returncode": returncode}
        payload.update(extra)
        self.events.append(("done", payload))

    def close(self) -> None:
        self.closed = True


# ─── Shell ───────────────────────────────────────────────────────────────────

class Shell(ABC):
    """Translate a single command line into a safe argv list.

    A shell enforces:
      * the literal-binary prefix (``make``, ``python3``, ...),
      * a token whitelist (no shell metacharacters), and
      * a maximum token count.

    The HTTP route decides which shell to invoke; the shell never sees
    the network.  Adding a new binary means writing a new subclass and
    adding it to :data:`SHELLS`.
    """

    name: ClassVar[str]
    binary: ClassVar[str]
    max_tokens: ClassVar[int] = 16
    token_re: ClassVar[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9_./=@%+,:-]+$")

    @abstractmethod
    def validate(self, line: str) -> list[str] | None:
        """Return ``None`` for empty/comment lines, or the validated argv."""

    @classmethod
    def split(cls, line: str) -> list[str]:
        try:
            return shlex.split(line, posix=True)
        except ValueError as exc:
            raise ShellError(f"parse error: {exc}") from exc

    @classmethod
    def check_tokens(cls, tokens: list[str]) -> None:
        if len(tokens) > cls.max_tokens:
            raise ShellError(f"too many tokens (max {cls.max_tokens})")
        for tok in tokens[1:]:
            if not cls.token_re.match(tok):
                raise ShellError(f"disallowed character in token: {tok!r}")


class MakeShell(Shell):
    """Sandboxed ``make`` shell.  Only ``make <target> [KEY=VALUE]...``."""

    name = "make"
    binary = "make"

    def validate(self, line: str) -> list[str] | None:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            return None
        tokens = self.split(stripped)
        if not tokens:
            return None
        if tokens[0] != self.binary:
            raise ShellError(f"only `{self.binary}` commands are allowed in this shell")
        self.check_tokens(tokens)
        return tokens


SHELLS: dict[str, Shell] = {"make": MakeShell()}


def shell_for(name: str) -> Shell:
    try:
        return SHELLS[name]
    except KeyError as exc:
        raise ShellError(f"unknown shell: {name!r}") from exc


# ─── Command ─────────────────────────────────────────────────────────────────

class Command(ABC):
    """Spawns one child and pumps its output through a :class:`Channel`."""

    def __init__(self, argv: list[str], cwd: Path | None = None) -> None:
        self.argv = list(argv)
        self.cwd = cwd

    @abstractmethod
    def execute(self, channel: Channel, stop: threading.Event) -> int:
        """Run the command to completion.  Returns the child's exit code."""

    def cancel(self) -> None:
        """Best-effort early termination.  Default is a no-op for subclasses
        that don't keep handles after :meth:`execute` returns."""


class SubprocessCommand(Command):
    """Spawn a child with merged stdout/stderr, line-buffered."""

    def __init__(self, argv: list[str], cwd: Path | None = None) -> None:
        super().__init__(argv, cwd)
        self._proc: subprocess.Popen | None = None

    def execute(self, channel: Channel, stop: threading.Event) -> int:
        try:
            self._proc = subprocess.Popen(
                self.argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=str(self.cwd) if self.cwd else None,
            )
        except FileNotFoundError as exc:
            channel.emit_line(f"\x1b[31merror: {exc}\x1b[0m")
            return 127
        except Exception as exc:
            channel.emit_line(f"\x1b[31merror: {exc}\x1b[0m")
            return 1

        assert self._proc.stdout is not None
        try:
            for raw in self._proc.stdout:
                if stop.is_set():
                    self._proc.terminate()
                    break
                channel.emit_line(raw.rstrip("\n"))
        finally:
            self._proc.wait()
        rc = self._proc.returncode if self._proc.returncode is not None else -1
        return rc

    def cancel(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.terminate()
            except Exception:
                pass


class ReplCommand(Command):
    """Spawn ``python3 -i -u`` under a PTY so readline / prompts work."""

    def __init__(self, argv: list[str] | None = None, cwd: Path | None = None) -> None:
        super().__init__(argv or ["python3", "-i", "-u"], cwd)
        self._proc: subprocess.Popen | None = None
        self._pty_master_fd: int = -1

    @property
    def pty_master_fd(self) -> int:
        return self._pty_master_fd

    def write_input(self, data: bytes) -> None:
        if self._pty_master_fd < 0:
            return
        try:
            os.write(self._pty_master_fd, data)
        except OSError:
            pass

    def execute(self, channel: Channel, stop: threading.Event) -> int:
        master_fd, slave_fd = pty.openpty()
        self._pty_master_fd = master_fd

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["TERM"] = "xterm-256color"

        try:
            self._proc = subprocess.Popen(
                self.argv,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                env=env,
                preexec_fn=os.setsid,
                cwd=str(self.cwd) if self.cwd else None,
            )
        finally:
            os.close(slave_fd)

        try:
            while not stop.is_set():
                r, _, _ = select.select([master_fd], [], [], 0.1)
                if not r:
                    continue
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                channel.emit_bytes(chunk)
        finally:
            try:
                self._proc.wait()
            except Exception:
                pass
            try:
                os.close(master_fd)
            except Exception:
                pass
            self._pty_master_fd = -1

        return self._proc.returncode if self._proc.returncode is not None else -1

    def cancel(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.terminate()
            except Exception:
                pass
        if self._pty_master_fd >= 0:
            try:
                os.close(self._pty_master_fd)
            except Exception:
                pass
            self._pty_master_fd = -1


# ─── Session & Registry ─────────────────────────────────────────────────────

class Session:
    """One in-flight (Command, Channel) pair, run on a worker thread."""

    def __init__(
        self,
        command: Command,
        channel: Channel,
        session_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        self.session_id = session_id or f"ses-{os.getpid()}-{time.monotonic_ns()}"
        self.command = command
        self.channel = channel
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._returncode: int | None = None
        self._meta: dict[str, Any] = meta or {}

    def start(self) -> None:
        """Spawn the worker thread and return immediately."""
        self.channel.open({"session": self.session_id, **self._meta})
        self._thread = threading.Thread(
            target=self._run, name=f"session-{self.session_id}", daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        try:
            self._returncode = self.command.execute(self.channel, self._stop)
        except _ClientGone:
            self._returncode = -1
        except Exception as exc:
            self.channel.emit_line(f"\x1b[31minternal error: {exc}\x1b[0m")
            self._returncode = 1
        finally:
            self.channel.emit_done(self._returncode if self._returncode is not None else -1)
            self.channel.close()

    def cancel(self) -> None:
        self._stop.set()
        self.command.cancel()

    def join(self, timeout: float | None = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)


class SessionRegistry:
    """Thread-safe map of ``session_id -> Session``."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def register(self, session: Session) -> None:
        with self._lock:
            self._sessions[session.session_id] = session

    def unregister(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def get(self, session_id: str) -> Session | None:
        with self._lock:
            return self._sessions.get(session_id)

    def find_by_target(self, target: str) -> Session | None:
        """Return the most recently registered session whose ``meta`` advertises
        the given ``target`` string.  Used by ``POST /repl/in`` to find the
        active REPL."""
        with self._lock:
            for session in reversed(self._sessions.values()):
                if session._meta.get("target") == target:
                    return session
        return None

    def all_ids(self) -> list[str]:
        with self._lock:
            return list(self._sessions.keys())


# Process-wide singleton — small enough not to need DI.
REGISTRY = SessionRegistry()


# ─── HTTP routing ────────────────────────────────────────────────────────────

class RouteHandler(ABC):
    """One route, one handler object.  Subclasses implement :meth:`handle`."""

    @abstractmethod
    def handle(self, bridge: "BridgeHTTPHandler") -> None: ...


class HealthHandler(RouteHandler):
    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        bridge._send_json(200, {"status": "ok"})


class StatusHandler(RouteHandler):
    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        bridge._send_json(200, {
            "pid": os.getpid(),
            "uptime": time.monotonic() - _last_activity,
            "active_sessions": REGISTRY.all_ids(),
        })


class TargetsHandler(RouteHandler):
    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        bridge._send_json(200, {
            "targets": _discover_makefile_targets(CONFIG["makefile"]),
        })


class LegacyPostHandler(RouteHandler):
    """POST / — fire-and-forget make execution, returns JSON, no streaming."""

    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        try:
            length = int(bridge.headers.get("Content-Length", 0))
            raw = bridge.rfile.read(length) if length else b""
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as exc:
            bridge._send_json(400, {"error": f"Bad request: {exc}"})
            return

        field = CONFIG["field_make_target"]
        target = data.get(field, "")
        if not target:
            bridge._send_json(400, {"error": f"Missing '{field}' field"})
            return

        success, output = run_make_target(target, int(CONFIG["make_timeout_seconds"]))
        if not success:
            bridge._send_json(500, {
                "error": f"Target '{target}' failed",
                CONFIG["output_field"]: output.splitlines() if output else [],
            })
            return

        if target == "join-stages":
            bridge._send_json(200, {
                CONFIG["status_ok"]: CONFIG["status_ok"],
                "target": target,
                CONFIG["output_field"]: output.splitlines() if output else [],
            })
            threading.Thread(
                target=lambda: (time.sleep(0.1), _should_terminate.set()),
                daemon=True,
            ).start()
            return

        bridge._send_json(200, {
            CONFIG["status_ok"]: CONFIG["status_ok"],
            "target": target,
            CONFIG["output_field"]: output.splitlines() if output else [],
        })


class ShutdownHandler(RouteHandler):
    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        # Drain any request body so the client doesn't see a reset.
        try:
            length = int(bridge.headers.get("Content-Length", 0))
            if length:
                bridge.rfile.read(length)
        except Exception:
            pass
        bridge._send_json(200, {"status": "shutting_down"})
        # Set the flag on a fresh thread so the response flushes first.
        threading.Thread(
            target=lambda: (time.sleep(0.05), _should_terminate.set()),
            daemon=True,
        ).start()


class ViteProxyHandler(RouteHandler):
    """Reverse-proxy any unmatched GET to the Vite dev server.

    The launcher (``extra-rare-agentic-bert.py``) passes the Vite URL
    via ``--vite-url`` so the bridge can mount the Vue app at
    ``http://127.0.0.1:8338/`` as a convenience — same shell, same
    xterm.js, same HMR — without forcing users to remember a second
    port.

    Failures are surfaced as JSON 502s so a misconfigured upstream
    shows up clearly in the browser rather than as an opaque HTTP
    error.
    """

    # Hop-by-hop headers that must not be forwarded (RFC 7230 §6.1).
    _SKIP_REQUEST_HEADERS = frozenset({
        "host", "content-length", "connection", "keep-alive",
        "proxy-authenticate", "proxy-authorization", "te", "trailers",
        "transfer-encoding", "upgrade",
    })
    _SKIP_RESPONSE_HEADERS = frozenset({
        "connection", "keep-alive", "proxy-authenticate",
        "proxy-authorization", "te", "trailers", "transfer-encoding",
        "upgrade", "server",
    })

    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        vite_url = _vite_upstream()
        if not vite_url:
            bridge._send_json(503, {"error": "vite upstream not configured"})
            return

        # Build the upstream URL.  Preserve the original path + query
        # so deep links like ``/?target=help`` survive the hop.
        parsed = urlparse(bridge.path)
        target = f"{vite_url}{parsed.path}"
        if parsed.query:
            target = f"{target}?{parsed.query}"

        # Forward request headers, minus hop-by-hop.
        fwd_headers: dict[str, str] = {}
        for key, value in bridge.headers.items():
            if key.lower() in self._SKIP_REQUEST_HEADERS:
                continue
            fwd_headers[key] = value

        req = urllib.request.Request(target, headers=fwd_headers, method="GET")

        status: int
        body: bytes
        upstream_headers: Any
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                status = resp.status
                body = resp.read()
                upstream_headers = resp.headers
        except urllib.error.HTTPError as exc:
            # Vite itself returned an error (e.g. 404 for an asset).
            # Forward it through verbatim so the browser sees the same
            # status Vite produced.
            status = exc.code
            body = exc.read() if hasattr(exc, "read") else b""
            upstream_headers = getattr(exc, "headers", {}) or {}
        except (urllib.error.URLError, socket.timeout, ConnectionRefusedError, OSError) as exc:
            bridge._send_json(502, {
                "error": "vite upstream unreachable",
                "upstream": vite_url,
                "detail": str(exc),
            })
            return

        bridge.send_response(status)
        # Forward content-type / content-length / cache-control so the
        # browser handles JS modules, HMR pings, etc. correctly.
        for key, value in upstream_headers.items():
            if key.lower() in self._SKIP_RESPONSE_HEADERS:
                continue
            bridge.send_header(key, value)
        bridge.send_header("Content-Length", str(len(body)))
        bridge.end_headers()
        bridge.wfile.write(body)


# ─── Vite upstream discovery ─────────────────────────────────────────────────

def _vite_upstream() -> str:
    """Resolve the Vite dev server URL from CLI flag, env, or default.

    Priority:
      1. ``--vite-url`` CLI flag (set by the launcher).
      2. ``RAREBERT_VITE_URL`` env var.
      3. ``http://127.0.0.1:5173`` (Vite default).
    """
    return _VITE_URL


_VITE_URL = ""


class _LegacyMakeStreamHandler(RouteHandler):
    """GET /stream?target=<name> — original SSE make execution."""

    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        qs = parse_qs(urlparse(bridge.path).query)
        target = (qs.get("target") or [""])[0].strip()
        if not target:
            bridge._send_json(400, {"error": "Missing 'target' query param"})
            return
        try:
            argv = shell_for("make").validate(f"make {target}")
        except ShellError as exc:
            bridge._send_json(400, {"error": str(exc)})
            return
        if argv is None:
            bridge._send_json(400, {"error": "empty target"})
            return
        channel = SseChannel(bridge)
        command = SubprocessCommand(argv, cwd=_REPO_ROOT)
        session = Session(command, channel, meta={"target": target, "argv": argv})
        REGISTRY.register(session)
        try:
            session.start()
            session.join()
        finally:
            REGISTRY.unregister(session.session_id)


class _LegacyReplStreamHandler(RouteHandler):
    """GET /repl — interactive Python REPL over SSE (PTY-backed)."""

    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        channel = SseChannel(bridge)
        command = ReplCommand()
        session = Session(command, channel, meta={"target": "__repl__"})
        REGISTRY.register(session)
        try:
            session.start()
            session.join()
        finally:
            REGISTRY.unregister(session.session_id)


class ReplInputHandler(RouteHandler):
    """POST /repl/in — write one line of input to the active REPL session."""

    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        session = REGISTRY.find_by_target("__repl__")
        if session is None:
            bridge._send_json(409, {"error": "No active REPL session"})
            return
        try:
            length = int(bridge.headers.get("Content-Length", 0))
            payload = bridge.rfile.read(length) if length else b""
        except Exception as exc:
            bridge._send_json(400, {"error": f"Bad request: {exc}"})
            return
        if not isinstance(session.command, ReplCommand):
            bridge._send_json(409, {"error": "Active session is not a REPL"})
            return
        session.command.write_input(payload)
        bridge._send_json(200, {"status": "ok", "bytes": len(payload)})


class RunStreamHandler(RouteHandler):
    """POST /api/run-stream — sandboxed shell, SSE-streamed output.

    Body: ``{"command": "make it-learn-language", "shell": "make"}``.
    Output: text/event-stream with ``event: open | line | bytes | done``.
    """

    def handle(self, bridge: "BridgeHTTPHandler") -> None:
        try:
            length = int(bridge.headers.get("Content-Length", 0))
            raw = bridge.rfile.read(length) if length else b""
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as exc:
            bridge._send_json(400, {"error": f"Bad JSON: {exc}"})
            return

        shell_name = payload.get("shell") or "make"
        line = payload.get("command") or ""

        try:
            shell = shell_for(shell_name)
        except ShellError as exc:
            bridge._send_json(400, {"error": str(exc)})
            return

        try:
            argv = shell.validate(line)
        except ShellError as exc:
            channel = SseChannel(bridge)
            channel.open({"session": "rejected", "argv": [], "shell": shell_name})
            channel.emit_line(f"\x1b[31m{line}: {exc}\x1b[0m")
            channel.emit_done(2, rejected=True)
            channel.close()
            return

        if argv is None:
            channel = SseChannel(bridge)
            channel.open({"session": "noop", "argv": [], "shell": shell_name})
            channel.emit_done(0, noop=True)
            channel.close()
            return

        channel = SseChannel(bridge)
        command = SubprocessCommand(argv, cwd=_REPO_ROOT)
        session = Session(command, channel, meta={
            "target": argv[1] if len(argv) > 1 else "",
            "argv": argv,
            "shell": shell_name,
        })
        REGISTRY.register(session)
        try:
            session.start()
            session.join()
        finally:
            REGISTRY.unregister(session.session_id)


# Routing table — single source of truth.
ROUTES: dict[tuple[str, str], RouteHandler] = {
    ("GET",  "/health"):         HealthHandler(),
    ("GET",  "/status"):         StatusHandler(),
    ("GET",  "/api/targets"):    TargetsHandler(),
    ("GET",  "/stream"):         _LegacyMakeStreamHandler(),
    ("GET",  "/repl"):           _LegacyReplStreamHandler(),
    ("GET",  "/"):               ViteProxyHandler(),
    ("GET",  "/index.html"):     ViteProxyHandler(),
    ("POST", "/"):               LegacyPostHandler(),
    ("POST", "/repl/in"):        ReplInputHandler(),
    ("POST", "/api/run-stream"): RunStreamHandler(),
    ("POST", "/shutdown"):       ShutdownHandler(),
}


# ─── HTTP handler ────────────────────────────────────────────────────────────

_last_activity = time.monotonic()
_activity_lock = threading.Lock()
_should_terminate = threading.Event()


def _touch_activity() -> None:
    global _last_activity
    with _activity_lock:
        _last_activity = time.monotonic()


class BridgeHTTPHandler(BaseHTTPRequestHandler):
    """HTTP request handler.  Only knows about URLs — all work lives in
    :class:`RouteHandler` subclasses."""

    server_version = "RarebertBridge/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write(f"[bridge] {self.address_string()} {fmt % args}\n")

    # ── helpers used by route handlers ──────────────────────────────────────

    def _send_json(self, status_code: int, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── dispatch ────────────────────────────────────────────────────────────

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        _touch_activity()
        path = urlparse(self.path).path
        handler = ROUTES.get((method, path))
        if handler is None:
            # GET fall-through: forward unmapped paths to the Vite
            # dev server so the user can open ``http://8338/`` and get
            # the Vue shell, then navigate around as if they were on
            # the proxied origin.  Other methods still 404 cleanly.
            if method == "GET":
                ViteProxyHandler().handle(self)
                return
            self._send_json(404, {"error": f"No route for {method} {path}"})
            return
        handler.handle(self)


# ─── Legacy helpers (kept for POST / and TargetsHandler) ────────────────────

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


# ─── Entry point ─────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Rarebert SSE bridge")
    parser.add_argument("--host", default=None,
                        help="override config.json host")
    parser.add_argument("--port", type=int, default=None,
                        help="override config.json port")
    parser.add_argument("--vite-url", default=None,
                        help="URL of the Vite dev server to proxy "
                             "unmatched GETs to.  Defaults to "
                             "$RAREBERT_VITE_URL or "
                             "http://127.0.0.1:5173.")
    args = parser.parse_args()

    global CONFIG, _VITE_URL
    CONFIG = load_config(args.host, args.port)
    _VITE_URL = (
        args.vite_url
        or os.environ.get("RAREBERT_VITE_URL")
        or "http://127.0.0.1:5173"
    )

    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    host = str(CONFIG["host"])
    port = int(CONFIG["port"])

    try:
        server = ThreadingHTTPServer((host, port), BridgeHTTPHandler)
    except OSError as exc:
        print(f"[bridge] cannot bind {host}:{port} -> {exc}", file=sys.stderr)
        return 1

    print(f"[bridge] listening on http://{host}:{port}", file=sys.stderr)
    print(f"[bridge] pid={os.getpid()}", file=sys.stderr)

    try:
        while not _should_terminate.is_set():
            server.handle_request()
    finally:
        for sid in REGISTRY.all_ids():
            session = REGISTRY.get(sid)
            if session is not None:
                session.cancel()
        server.server_close()
        print("[bridge] stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())