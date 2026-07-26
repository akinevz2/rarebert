"""Self-contained test for the OO refactor of stream_subprocess.

Run with::

    cd src/python && python3 -m tests.test_bridge

The goal is to demonstrate that the new class hierarchy
(``Shell``, ``Command``, ``Channel``, ``Session``) is fully testable
without spinning up an HTTP server, by driving a ``SubprocessCommand``
through a ``MemoryChannel``.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

# Make sibling module importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from stream_subprocess import (  # noqa: E402
    Channel,
    Command,
    MemoryChannel,
    MakeShell,
    ReplCommand,
    Session,
    ShellError,
    SubprocessCommand,
)


# ─── Shell tests ────────────────────────────────────────────────────────────

def test_make_shell_accepts_simple_target() -> None:
    argv = MakeShell().validate("make help")
    assert argv == ["make", "help"]


def test_make_shell_rejects_non_make_binary() -> None:
    try:
        MakeShell().validate("ls")
    except ShellError as exc:
        assert "only `make`" in str(exc)
        return
    raise AssertionError("expected ShellError")


def test_make_shell_rejects_shell_metachars() -> None:
    try:
        MakeShell().validate("make a;b")
    except ShellError as exc:
        assert "disallowed" in str(exc)
        return
    raise AssertionError("expected ShellError")


def test_make_shell_rejects_too_many_tokens() -> None:
    tokens = " ".join(["make"] + [f"k{i}" for i in range(20)])
    try:
        MakeShell().validate(tokens)
    except ShellError as exc:
        assert "too many tokens" in str(exc)
        return
    raise AssertionError("expected ShellError")


def test_make_shell_skips_empty_and_comments() -> None:
    assert MakeShell().validate("") is None
    assert MakeShell().validate("   ") is None
    assert MakeShell().validate("# just a note") is None


# ─── Command + Channel + Session tests ─────────────────────────────────────

def test_subprocess_command_streams_via_memory_channel() -> None:
    """A real ``echo`` invoked through ``SubprocessCommand`` should yield
    one ``line`` event followed by a ``done`` event with rc=0."""

    channel = MemoryChannel()
    cmd = SubprocessCommand(["echo", "hello, bridge"])
    session = Session(cmd, channel)
    session.start()
    session.join(timeout=5)

    kinds = [kind for kind, _ in channel.events]
    assert "open" in kinds, f"expected 'open' in {kinds}"
    assert "line" in kinds, f"expected 'line' in {kinds}"
    assert "done" in kinds, f"expected 'done' in {kinds}"

    line_payload = next(p for k, p in channel.events if k == "line")
    assert "hello, bridge" in line_payload["line"]

    done_payload = next(p for k, p in channel.events if k == "done")
    assert done_payload["returncode"] == 0

    assert channel.closed is True


def test_session_cancel_stops_long_running_command() -> None:
    """``Session.cancel`` should terminate a long sleep."""

    channel = MemoryChannel()
    cmd = SubprocessCommand(["sleep", "30"])
    session = Session(cmd, channel)
    session.start()
    # Give the subprocess a moment to actually start, then cancel.
    import time
    time.sleep(0.2)
    session.cancel()
    session.join(timeout=3)

    kinds = [kind for kind, _ in channel.events]
    assert "done" in kinds
    done_payload = next(p for k, p in channel.events if k == "done")
    # SIGTERM gives rc=-15 on Linux; what matters is the command exited.
    assert done_payload["returncode"] != 0


def test_subprocess_command_surfaces_spawn_error() -> None:
    channel = MemoryChannel()
    cmd = SubprocessCommand(["this-binary-does-not-exist-xyz123"])
    session = Session(cmd, channel)
    session.start()
    session.join(timeout=3)

    line_payload = next(p for k, p in channel.events if k == "line")
    assert "error" in line_payload["line"].lower()

    done_payload = next(p for k, p in channel.events if k == "done")
    assert done_payload["returncode"] == 127


# ─── Driver ────────────────────────────────────────────────────────────────

def _run(name: str, fn) -> None:
    try:
        fn()
        print(f"  ok    {name}")
    except AssertionError as exc:
        print(f"  FAIL  {name}: {exc}")
        raise


def main() -> int:
    print("test_bridge:")
    tests: list[tuple[str, callable]] = [
        ("make_shell_accepts_simple_target",  test_make_shell_accepts_simple_target),
        ("make_shell_rejects_non_make_binary", test_make_shell_rejects_non_make_binary),
        ("make_shell_rejects_shell_metachars", test_make_shell_rejects_shell_metachars),
        ("make_shell_rejects_too_many_tokens", test_make_shell_rejects_too_many_tokens),
        ("make_shell_skips_empty_and_comments", test_make_shell_skips_empty_and_comments),
        ("subprocess_command_streams_via_memory_channel",
         test_subprocess_command_streams_via_memory_channel),
        ("session_cancel_stops_long_running_command",
         test_session_cancel_stops_long_running_command),
        ("subprocess_command_surfaces_spawn_error",
         test_subprocess_command_surfaces_spawn_error),
    ]
    for name, fn in tests:
        _run(name, fn)
    print(f"\n{len(tests)} tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())