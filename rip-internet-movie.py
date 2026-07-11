"""Download internet video at highest available quality using yt-dlp.

Usage examples:
  make rip-internet-movie URL=https://www.youtube.com/watch?v=dQw4w9WgXcQ
  python3 rip-internet-movie.py URL=https://www.youtube.com/watch?v=dQw4w9WgXcQ
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from devlib import parse_kv_args, require_arg_or_prompt, run


def ensure_ytdlp_installed() -> str:
    """Return yt-dlp path, installing via pip --user when missing."""
    path = shutil.which("yt-dlp")
    if path:
        return path

    install_cmd = [sys.executable, "-m", "pip", "install", "--user", "yt-dlp"]
    print("yt-dlp not found on PATH. Installing with pip --user...")
    completed = subprocess.run(install_cmd, check=False)
    if completed.returncode != 0:
        # Debian/Ubuntu PEP 668 environments require this opt-in.
        fallback_cmd = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--user",
            "--break-system-packages",
            "yt-dlp",
        ]
        print("Retrying installation with --break-system-packages...")
        completed = subprocess.run(fallback_cmd, check=False)

    if completed.returncode != 0:
        raise RuntimeError(
            "automatic installation failed. Install yt-dlp manually, e.g. 'python3 -m pip install --user yt-dlp'"
        )

    path = shutil.which("yt-dlp")
    if path:
        return path

    # Common fallback for --user installs when PATH is not refreshed.
    user_bin = shutil.which("yt-dlp", path=str(Path.home() / ".local" / "bin"))
    if user_bin:
        return user_bin

    raise RuntimeError(
        "yt-dlp was installed but is still not discoverable. Add ~/.local/bin to PATH and retry."
    )


def ensure_ffmpeg_installed() -> str:
    """Return ffmpeg path, attempting apt install when missing."""
    path = shutil.which("ffmpeg")
    if path:
        return path

    print("ffmpeg not found on PATH. Installing via apt...")
    update = subprocess.run(["sudo", "apt-get", "update"], check=False)
    if update.returncode != 0:
        raise RuntimeError("failed to run 'sudo apt-get update' for ffmpeg installation")

    install = subprocess.run(["sudo", "apt-get", "install", "-y", "ffmpeg"], check=False)
    if install.returncode != 0:
        raise RuntimeError("failed to install ffmpeg. Install manually with 'sudo apt-get install -y ffmpeg'")

    path = shutil.which("ffmpeg")
    if path:
        return path

    raise RuntimeError("ffmpeg installation completed but binary is still unavailable on PATH")


def validate_url(url: str) -> str:
    """Basic URL validation for downloader input."""
    cleaned = url.strip()
    if not cleaned:
        raise ValueError("URL must not be empty")
    if not cleaned.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")
    return cleaned


def run_download(url: str) -> int:
    """Execute yt-dlp download using highest available quality format."""
    yt_dlp = ensure_ytdlp_installed()
    ffmpeg = ensure_ffmpeg_installed()
    cmd = [
        yt_dlp,
        "-f",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
        "--no-keep-video",
        "--ffmpeg-location",
        ffmpeg,
        url,
    ]
    completed = subprocess.run(cmd, check=False)
    return int(completed.returncode)


def usage() -> None:
    """Print usage text."""
    print("Usage: python3 rip-internet-movie.py URL=<https://...>")


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        url = require_arg_or_prompt(args, "URL", "Video URL (URL)")
        validated = validate_url(url)
        return run_download(validated)
    except (ValueError, RuntimeError) as exc:
        print(f"Error: {exc}")
        usage()
        return 2


if __name__ == "__main__":
    raise SystemExit(run(main))
