"""reminders: generated module scaffold."""

from __future__ import annotations

from pathlib import Path

from devlib import run


REMINDERS = [
    "Scala setup is complete.",
    "Ollama removal is complete.",
    "Plan to install Ollama or VLLM into the devcontainer is in progress.",
    "Set up Project Turnstone as Cornfield into the local system.",
    "Set up a reasoning node on WS-RARETOWER.",
    "Create a socket-network-enabled notification daemon that communicates and executes RPC messages sent to a Windows executable to launch a VBS script in the user's profile directory, showing a dismissible window in the bottom right corner of the screen.",
    "URGENT: test urgent notification",
    "URGENT: second urgent call",
]
REMINDERS_PATH = Path("reminders.rs")


def reminders_text() -> str:
    return "\n".join(REMINDERS) + "\n"


class VerifierImpl:
    """Byte-for-byte verification of the reminders snapshot file."""

    def __init__(self, path: Path = REMINDERS_PATH) -> None:
        self.path = path

    def expected_bytes(self) -> bytes:
        return reminders_text().encode("utf-8")

    def verify(self) -> bool:
        expected = self.expected_bytes()
        if not self.path.exists():
            return False
        return self.path.read_bytes() == expected

    def write(self) -> None:
        self.path.write_bytes(self.expected_bytes())


def main() -> int:
    verifier = VerifierImpl()
    if not verifier.verify():
        verifier.write()

    print("Reminders:")
    for reminder in REMINDERS:
        print(f"  - {reminder}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
