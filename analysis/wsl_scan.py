#!/usr/bin/env python3
"""
WSL-side cross-boundary threat intelligence scan.

Designed to run from a healthy WSL2 instance as an independent sensor layer
when Windows-side Defender diagnostics cannot be fully trusted — specifically
when oplock-based elevation/deelevation abuse against MsMpEng.exe is suspected.

Background on the threat model:
  Opportunistic lock (oplock) exploits against Defender's elevation boundary
  work by inserting a race between Defender's file-open (check) and its
  subsequent elevated access (use): a TOCTOU class vulnerability in Win32
  kernel space. Because the substitution occurs inside the Win32 kernel,
  user-mode diagnostics running natively on Windows can be unreliable or
  actively spoofed by the payload.

Why WSL is a useful independent sensor:
  WSL2 runs on a separate Hyper-V micro-VM kernel. The DRVFS/plan9 bridge
  provides a filesystem view that is structurally separate from Win32 file
  system filters. The WSL network stack is independent of the Windows TCP/IP
  stack. Neither of these boundaries is trivially manipulated by standard
  Win32 malware. This makes WSL an effective second-opinion sensor even when
  Win32 instrumentation is suspect.

Checks performed:
  1.  IP forwarding and iptables FORWARD rules (tunnel/routing abuse)
  2.  Established TCP connections from WSL to external IPs
  3.  Processes listening on the WSL vEthernet interface
  4.  Unexpected Windows .exe files running via WSL interop
  5.  Recent executable-class files in Windows Temp (via /mnt/c)
  6.  Suspicious filename patterns across Windows staging paths
  7.  Authenticode signature validity of critical Windows binaries
  8.  SHA-256 hashes of critical Windows binaries (operator reference)
  9.  Defender AM state (independent query via powershell.exe bridge)
  10. Unresolved Defender threat detections
  11. Recently modified executables in WSL user/temp paths
  12. Unexpected DRVFS/9P mounts

Output:
  Machine-readable JSON + human-readable TXT written to:
    /mnt/c/ProgramData/MalwareRemoval/   <- shared, readable from Windows
    ~/.local/share/malware_removal_scan/ <- local WSL backup

  RESET_RECOMMENDED.flag is created in both locations if severity threshold
  is met, with operator instructions for wsl --terminate / --unregister.

Exit codes:
  0  No findings.
  1  Findings present, below reset threshold.
  2  Reset threshold met — operator review and possible reset required.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ── Configuration ──────────────────────────────────────────────────────────────

SHARED_LOG_DIR = Path("/mnt/c/ProgramData/MalwareRemoval")
LOCAL_LOG_DIR = Path.home() / ".local" / "share" / "malware_removal_scan"

WINDOWS_TEMP = Path("/mnt/c/Windows/Temp")
WINDOWS_PROGRAMDATA = Path("/mnt/c/ProgramData")

# Subset of critical Windows binaries whose signatures and hashes are spot-checked.
# MsMpEng.exe is intentionally first — it is the primary oplock attack target.
CRITICAL_WINDOWS_BINARIES: list[Path] = [
    Path("/mnt/c/Windows/System32/MsMpEng.exe"),
    Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
    Path("/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe"),
    Path("/mnt/c/Windows/System32/cmd.exe"),
    Path("/mnt/c/Windows/System32/wscript.exe"),
    Path("/mnt/c/Windows/System32/cscript.exe"),
    Path("/mnt/c/Windows/System32/rundll32.exe"),
    Path("/mnt/c/Windows/System32/regsvr32.exe"),
]

# File extensions that warrant scrutiny in temp/staging paths.
SUSPICIOUS_EXTENSIONS: frozenset[str] = frozenset({
    ".exe", ".dll", ".sys", ".ps1", ".psm1", ".vbs",
    ".js", ".bat", ".cmd", ".hta", ".wsf", ".scr",
})

# Age threshold for "recently modified" file checks (seconds).
RECENT_FILE_AGE_SECS = 7 * 24 * 3600  # 7 days
VERY_RECENT_FILE_AGE_SECS = 3600       # 1 hour

# Severity score at which RESET_RECOMMENDED is set.
RESET_SEVERITY_THRESHOLD = 5

# Windows processes expected via WSL interop — everything else is flagged.
KNOWN_SAFE_INTEROP_EXES: frozenset[str] = frozenset({
    "powershell.exe", "cmd.exe", "wslpath.exe",
    "wsl.exe", "wslhost.exe", "conhost.exe",
})

# Filename patterns associated with oplock exploit tools and C2 staging.
SUSPICIOUS_NAME_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(?i)oplock"),
    re.compile(r"(?i)dfndr"),       # matches the DfndrPEBluHmr family
    re.compile(r"(?i)peblu"),
    re.compile(r"(?i)c2[_\-]"),
    re.compile(r"(?i)\bbeacon\b"),
    re.compile(r"(?i)injector"),
    re.compile(r"(?i)\bloader\b"),
    re.compile(r"(?i)\bstager\b"),
    re.compile(r"(?i)dropper"),
    re.compile(r"(?i)implant"),
    re.compile(r"(?i)shellcode"),
]

SEVERITY_LABELS: dict[int, str] = {
    0: "INFO",
    1: "LOW",
    2: "MEDIUM",
    3: "HIGH",
    4: "CRITICAL",
}

# ── Data types ─────────────────────────────────────────────────────────────────

@dataclass
class Finding:
    category: str
    severity: int        # 0 = INFO … 4 = CRITICAL
    title: str
    detail: str
    data: Any = None


@dataclass
class ScanReport:
    scan_id: str
    started_utc: str
    finished_utc: str = ""
    hostname: str = ""
    wsl_distro: str = ""
    wsl_version: str = ""
    findings: list[Finding] = field(default_factory=list)
    binary_hashes: dict[str, str] = field(default_factory=dict)
    signature_results: list[dict] = field(default_factory=list)
    reset_recommended: bool = False
    total_severity: int = 0


# ── Helpers ────────────────────────────────────────────────────────────────────

def run(command: list[str], timeout: int = 45) -> tuple[int, str, str]:
    """Run subprocess; returns (returncode, stdout, stderr). Never raises."""
    try:
        proc = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"Timed out after {timeout}s: {' '.join(command)}"
    except (FileNotFoundError, PermissionError, OSError) as exc:
        return -1, "", str(exc)


def sha256_file(path: Path) -> str:
    """Return lowercase hex SHA-256 of a file, or 'UNREADABLE' on error."""
    try:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return "UNREADABLE"


def file_age_secs(path: Path) -> float | None:
    """Seconds since path was last modified, or None if unreadable."""
    try:
        return dt.datetime.now().timestamp() - path.stat().st_mtime
    except OSError:
        return None


def is_recent(path: Path, max_age: int = RECENT_FILE_AGE_SECS) -> bool:
    age = file_age_secs(path)
    return age is not None and age < max_age


def has_suspicious_name(path: Path) -> bool:
    return any(p.search(path.name) for p in SUSPICIOUS_NAME_PATTERNS)


def parse_proc_net_tcp(proc_path: str) -> list[dict]:
    """
    Parse /proc/net/tcp or /proc/net/tcp6 into connection dicts.
    Handles both IPv4 (4-byte little-endian) entries.
    """
    TCP_STATES = {
        1: "ESTABLISHED", 2: "SYN_SENT", 3: "SYN_RECV",
        4: "FIN_WAIT1", 5: "FIN_WAIT2", 6: "TIME_WAIT",
        7: "CLOSE", 8: "CLOSE_WAIT", 9: "LAST_ACK",
        10: "LISTEN", 11: "CLOSING",
    }
    connections: list[dict] = []
    try:
        with open(proc_path) as fh:
            for line in fh.readlines()[1:]:
                parts = line.strip().split()
                if len(parts) < 4:
                    continue
                local_hex, remote_hex = parts[1], parts[2]
                state_int = int(parts[3], 16)

                def decode_ipv4(hex_str: str) -> tuple[str, int]:
                    addr_part, port_part = hex_str.split(":")
                    ip_bytes = struct.pack("<I", int(addr_part, 16))
                    return socket.inet_ntoa(ip_bytes), int(port_part, 16)

                try:
                    local_ip, local_port = decode_ipv4(local_hex)
                    remote_ip, remote_port = decode_ipv4(remote_hex)
                except (ValueError, struct.error):
                    continue

                connections.append({
                    "local": f"{local_ip}:{local_port}",
                    "remote": f"{remote_ip}:{remote_port}",
                    "state": state_int,
                    "state_name": TCP_STATES.get(state_int, str(state_int)),
                })
    except OSError:
        pass
    return connections


# ── Scan modules ───────────────────────────────────────────────────────────────

def scan_network() -> list[Finding]:
    """
    Check for network indicators of WSL being used as a tunnel or relay.

    The primary concern is malware on the Windows side configuring WSL as
    a routing/forwarding hop to reach C2 infrastructure or to pivot inside
    a network — bypassing Windows firewall rules that do not apply to the
    WSL virtual NIC.
    """
    findings: list[Finding] = []

    # 1. IP forwarding — if enabled, WSL can route packets between interfaces.
    try:
        ip_forward = Path("/proc/sys/net/ipv4/ip_forward").read_text().strip()
        if ip_forward == "1":
            findings.append(Finding(
                category="network",
                severity=3,
                title="IP forwarding is enabled in WSL",
                detail=(
                    "net.ipv4.ip_forward=1 means this WSL instance can forward "
                    "packets between its network interfaces. This is not expected "
                    "in a default WSL2 installation and may indicate the instance "
                    "is being used as a routing hop between Windows and external "
                    "networks."
                ),
            ))
    except OSError:
        pass

    # 2. iptables FORWARD chain — any non-default rules indicate routing intent.
    if shutil.which("iptables"):
        rc, out, _ = run(["iptables", "-L", "FORWARD", "-n", "--line-numbers"])
        if rc == 0:
            non_default = [
                ln for ln in out.splitlines()
                if ln.strip()
                and not ln.startswith("Chain")
                and not ln.startswith("target")
                and "policy ACCEPT" not in ln
                and "policy DROP" not in ln
            ]
            if non_default:
                findings.append(Finding(
                    category="network",
                    severity=2,
                    title="Non-default iptables FORWARD rules present",
                    detail="\n".join(non_default),
                ))

    # 3. Established connections to non-private external IPs.
    connections = parse_proc_net_tcp("/proc/net/tcp")
    tcp6_path = "/proc/net/tcp6"
    if Path(tcp6_path).exists():
        connections += parse_proc_net_tcp(tcp6_path)

    external: list[dict] = []
    for conn in connections:
        if conn["state"] != 1:  # ESTABLISHED only
            continue
        remote_ip_str = conn["remote"].rsplit(":", 1)[0]
        try:
            remote_ip = ipaddress.ip_address(remote_ip_str)
            if (
                not remote_ip.is_private
                and not remote_ip.is_loopback
                and not remote_ip.is_unspecified
                and not remote_ip.is_link_local
            ):
                external.append(conn)
        except ValueError:
            pass

    if external:
        findings.append(Finding(
            category="network",
            severity=2,
            title=f"{len(external)} established connection(s) to external IPs from WSL",
            detail=(
                "These connections may be legitimate (package updates, etc.) but "
                "should be verified against expected WSL activity.\n\n"
                + json.dumps(external, indent=2)
            ),
            data=external,
        ))

    # 4. Processes listening on WSL vEthernet IP (172.x.x.x range).
    if shutil.which("ss"):
        rc, ss_out, _ = run(["ss", "-tulnp"])
        if rc == 0:
            veth_listeners = [
                ln for ln in ss_out.splitlines()
                if re.search(r"172\.\d{1,3}\.\d{1,3}\.\d{1,3}", ln)
            ]
            if veth_listeners:
                findings.append(Finding(
                    category="network",
                    severity=1,
                    title=f"{len(veth_listeners)} service(s) listening on WSL vEthernet interface",
                    detail=(
                        "Services bound to the WSL vEthernet IP are reachable from "
                        "the Windows host and potentially other Hyper-V guests.\n\n"
                        + "\n".join(veth_listeners)
                    ),
                ))

    return findings


def scan_interop_processes() -> list[Finding]:
    """
    Detect unexpected Windows executables running inside WSL via interop.

    WSL interop allows Windows .exe files to be launched from within WSL.
    Malware may use this path to execute Win32 payloads with less scrutiny
    than a direct Windows invocation, or to maintain a persistent presence
    that survives WSL session restarts.
    """
    findings: list[Finding] = []

    rc, out, _ = run(["ps", "axo", "pid,user,comm,args", "--no-headers"])
    if rc != 0:
        return findings

    unexpected: list[dict] = []
    for line in out.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 3:
            continue
        comm = parts[2]
        args = parts[3] if len(parts) > 3 else ""
        if comm.lower().endswith(".exe") and comm.lower() not in KNOWN_SAFE_INTEROP_EXES:
            unexpected.append({"comm": comm, "args": args[:300]})

    if unexpected:
        findings.append(Finding(
            category="interop",
            severity=2,
            title=f"{len(unexpected)} unexpected Windows executable(s) running via WSL interop",
            detail=(
                "These Windows processes are executing inside the WSL context. "
                "Verify each against expected usage.\n\n"
                + json.dumps(unexpected, indent=2)
            ),
            data=unexpected,
        ))

    return findings


def scan_windows_filesystem() -> list[Finding]:
    """
    Check critical Windows filesystem paths via the DRVFS (/mnt/c) mount.

    The DRVFS bridge provides WSL with a read access path to the Windows
    filesystem that is largely independent of Win32 file system filter
    drivers — meaning malware-installed filters that hide files from Windows
    Explorer or Process Monitor typically cannot hide them from this view.
    """
    findings: list[Finding] = []

    mounts_text = ""
    try:
        mounts_text = Path("/proc/mounts").read_text()
    except OSError:
        pass

    if "/mnt/c" not in mounts_text:
        findings.append(Finding(
            category="filesystem",
            severity=2,
            title="/mnt/c is not mounted — cross-boundary filesystem checks skipped",
            detail=(
                "The Windows partition is not accessible via DRVFS at /mnt/c. "
                "This is unexpected and itself may warrant investigation."
            ),
        ))
        return findings

    # Recent executable-class files in Windows\Temp.
    if WINDOWS_TEMP.exists():
        recent_exes: list[dict] = []
        try:
            for f in WINDOWS_TEMP.rglob("*"):
                if not f.is_file():
                    continue
                if f.suffix.lower() in SUSPICIOUS_EXTENSIONS and is_recent(f):
                    entry: dict = {
                        "path": str(f),
                        "ext": f.suffix.lower(),
                        "size_bytes": f.stat().st_size,
                        "mtime": dt.datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                    }
                    if has_suspicious_name(f):
                        entry["name_pattern_match"] = True
                    recent_exes.append(entry)
        except (PermissionError, OSError):
            pass

        if recent_exes:
            findings.append(Finding(
                category="filesystem",
                severity=2,
                title=f"{len(recent_exes)} recent executable-class file(s) in Windows\\Temp",
                detail=(
                    "Executable-class files modified within the last 7 days in "
                    "Windows Temp. Normal update activity may account for many of "
                    "these, but review any with name_pattern_match=True.\n\n"
                    + json.dumps(recent_exes[:40], indent=2)
                ),
                data=recent_exes,
            ))

    # Suspicious filename patterns across high-value Windows staging locations.
    staging_hotspots = [
        Path("/mnt/c/Windows/Temp"),
        Path("/mnt/c/ProgramData"),
        Path("/mnt/c/Users/Public"),
        Path("/mnt/c/Users/Default/AppData/Local/Temp"),
    ]
    name_matches: list[str] = []
    for base in staging_hotspots:
        if not base.exists():
            continue
        try:
            for f in base.rglob("*"):
                if f.is_file() and has_suspicious_name(f):
                    name_matches.append(str(f))
        except (PermissionError, OSError):
            pass

    if name_matches:
        findings.append(Finding(
            category="filesystem",
            severity=3,
            title=f"{len(name_matches)} file(s) matching suspicious name patterns in Windows staging paths",
            detail="\n".join(name_matches[:60]),
            data=name_matches,
        ))

    return findings


def scan_binary_signatures() -> tuple[list[Finding], list[dict]]:
    """
    Verify Authenticode signatures of critical Windows binaries via PowerShell.

    An invalid or missing signature on MsMpEng.exe, powershell.exe, or cmd.exe
    is a strong indicator of binary replacement — a common post-oplock-exploit
    action.
    """
    findings: list[Finding] = []
    results: list[dict] = []

    win_paths = [
        r"C:\Windows\System32\MsMpEng.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Windows\System32\cmd.exe",
        r"C:\Windows\System32\wscript.exe",
        r"C:\Windows\System32\rundll32.exe",
        r"C:\Windows\System32\regsvr32.exe",
    ]

    ps_command = (
        "$paths = @(" + ",".join(f"'{p}'" for p in win_paths) + "); "
        "$paths | ForEach-Object { "
        "  try { "
        "    $s = Get-AuthenticodeSignature -LiteralPath $_; "
        "    [ordered]@{Path=$_; Status=[string]$s.Status; "
        "      Subject=$s.SignerCertificate.Subject; "
        "      Thumbprint=$s.SignerCertificate.Thumbprint} "
        "  } catch { "
        "    [ordered]@{Path=$_; Status='QueryError'; Subject=$_.Exception.Message; Thumbprint=''} "
        "  } "
        "} | ConvertTo-Json -Depth 2"
    )

    rc, out, err = run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_command],
        timeout=45,
    )

    if rc != 0 or not out.strip():
        findings.append(Finding(
            category="signatures",
            severity=1,
            title="Could not query Authenticode signatures from WSL",
            detail=err[:400] if err.strip() else "powershell.exe returned no output",
        ))
        return findings, results

    try:
        raw = json.loads(out)
        if isinstance(raw, dict):
            raw = [raw]
        results = raw
    except json.JSONDecodeError:
        findings.append(Finding(
            category="signatures",
            severity=1,
            title="Failed to parse Authenticode signature output",
            detail=out[:400],
        ))
        return findings, results

    invalid = [r for r in results if str(r.get("Status", "")).lower() not in ("valid", "")]
    if invalid:
        findings.append(Finding(
            category="signatures",
            severity=4,
            title=f"{len(invalid)} critical Windows binary/binaries with INVALID Authenticode signature",
            detail=(
                "One or more critical system binaries do not carry a valid Microsoft "
                "Authenticode signature. This is a strong indicator of binary "
                "replacement following an oplock-class exploit.\n\n"
                + json.dumps(invalid, indent=2)
            ),
            data=invalid,
        ))

    return findings, results


def scan_binary_hashes() -> dict[str, str]:
    """
    Compute SHA-256 of critical Windows binaries for operator reference.

    Hashes are not compared against a hardcoded baseline here (Windows Update
    changes them continuously), but are logged so the operator can verify
    against Microsoft's Security Update Guide, SSDC, or VirusTotal.
    """
    return {str(b): sha256_file(b) for b in CRITICAL_WINDOWS_BINARIES}


def scan_defender_state() -> list[Finding]:
    """
    Query Defender operational state via the WSL<->Windows powershell.exe bridge.

    While this path is not completely immune to spoofing (it still crosses the
    Win32 boundary), it is structurally different from querying Defender from
    within a Win32 process and provides a useful independent data point.
    """
    findings: list[Finding] = []

    rc, out, err = run(
        [
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "Get-MpComputerStatus | Select-Object "
            "RealTimeProtectionEnabled,AMServiceEnabled,AntispywareEnabled,"
            "NISEnabled,IoavProtectionEnabled | ConvertTo-Json",
        ],
        timeout=30,
    )

    if rc != 0:
        findings.append(Finding(
            category="defender",
            severity=2,
            title="Unable to query Defender status from WSL",
            detail=err[:400],
        ))
        return findings

    try:
        status = json.loads(out.strip())
    except json.JSONDecodeError:
        findings.append(Finding(
            category="defender",
            severity=1,
            title="Failed to parse Defender status JSON",
            detail=out[:400],
        ))
        return findings

    critical_flags = {
        "RealTimeProtectionEnabled": "Real-time protection",
        "AMServiceEnabled": "AM service",
        "AntispywareEnabled": "Antispyware",
    }
    for key, label in critical_flags.items():
        if not status.get(key):
            findings.append(Finding(
                category="defender",
                severity=4,
                title=f"Defender {label} is DISABLED",
                detail=(
                    f"{key}=False. Malware commonly disables Defender protections "
                    "as a first-stage action after initial execution."
                ),
                data=status,
            ))

    # Fetch recent unresolved detections.
    rc2, det_out, _ = run(
        [
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending "
            "| Select-Object -First 15 | ConvertTo-Json -Depth 2",
        ],
        timeout=30,
    )

    if rc2 == 0 and det_out.strip() and det_out.strip().lower() != "null":
        try:
            detections = json.loads(det_out)
            if isinstance(detections, dict):
                detections = [detections]
            # Status IDs: 0=Unknown,1=Detected,2=Cleaned,3=Quarantined,7=Removed
            unresolved = [
                d for d in detections
                if int(d.get("CurrentThreatExecutionStatusID", 0)) not in (0, 2, 3, 7)
            ]
            if unresolved:
                findings.append(Finding(
                    category="defender",
                    severity=3,
                    title=f"{len(unresolved)} Defender detection(s) in unresolved state",
                    detail=json.dumps(unresolved[:5], indent=2, default=str),
                    data=unresolved,
                ))
        except (json.JSONDecodeError, ValueError):
            pass

    return findings


def scan_wsl_filesystem_integrity() -> list[Finding]:
    """
    Look for signs of Windows-to-WSL lateral movement within the WSL instance.

    Attack paths of concern:
      - Windows malware writing files to the WSL filesystem via \\\\wsl$\\ UNC paths
      - Unexpected DRVFS bind-mounts that give malware broader WSL filesystem access
      - Recently planted executables in WSL home/temp that could be used to pivot
        back into Windows via WSL interop
    """
    findings: list[Finding] = []

    # Recently created/modified executables in WSL home and temp paths.
    watch_dirs = [Path.home(), Path("/tmp"), Path("/var/tmp"), Path("/dev/shm")]
    recent_exes: list[dict] = []
    for base in watch_dirs:
        if not base.exists():
            continue
        try:
            for f in base.rglob("*"):
                if not f.is_file():
                    continue
                try:
                    mode = f.stat().st_mode
                    if (mode & 0o111) and is_recent(f, VERY_RECENT_FILE_AGE_SECS):
                        recent_exes.append({
                            "path": str(f),
                            "mtime": dt.datetime.fromtimestamp(
                                f.stat().st_mtime
                            ).isoformat(),
                            "name_flagged": has_suspicious_name(f),
                        })
                except OSError:
                    pass
        except (PermissionError, OSError):
            pass

    if recent_exes:
        findings.append(Finding(
            category="wsl_integrity",
            severity=2,
            title=f"{len(recent_exes)} executable(s) created/modified in WSL user paths within the last hour",
            detail=(
                "Executables appearing in WSL home/temp in the last hour that were "
                "not placed by the current shell session may indicate Windows-to-WSL "
                "lateral movement via the \\\\wsl$\\ UNC path.\n\n"
                + json.dumps(recent_exes[:30], indent=2)
            ),
            data=recent_exes,
        ))

    # Unexpected DRVFS/9P mounts beyond the standard drive-letter mounts.
    try:
        mounts_text = Path("/proc/mounts").read_text()
        all_drvfs = [
            ln for ln in mounts_text.splitlines()
            if "drvfs" in ln.lower() or "9p" in ln.lower()
        ]
        # Standard WSL mounts are /mnt/<single lowercase letter>
        unexpected_mounts = [
            m for m in all_drvfs
            if not re.search(r"\s/mnt/[a-z](\s|$)", m)
        ]
        if unexpected_mounts:
            findings.append(Finding(
                category="wsl_integrity",
                severity=3,
                title=f"{len(unexpected_mounts)} unexpected DRVFS/9P mount(s) outside /mnt/<drive>",
                detail=(
                    "Non-standard DRVFS or plan9 mounts may indicate an attacker has "
                    "mounted additional Windows paths into the WSL filesystem to "
                    "facilitate staging or data access.\n\n"
                    + "\n".join(unexpected_mounts)
                ),
                data=unexpected_mounts,
            ))
    except OSError:
        pass

    return findings


# ── Severity scoring ────────────────────────────────────────────────────────────

def compute_severity(findings: list[Finding]) -> int:
    return sum(f.severity for f in findings)


# ── Output ──────────────────────────────────────────────────────────────────────

def write_outputs(report: ScanReport) -> list[Path]:
    written: list[Path] = []
    stamp = report.scan_id

    for log_dir in (SHARED_LOG_DIR, LOCAL_LOG_DIR):
        try:
            log_dir.mkdir(parents=True, exist_ok=True)

            # ── Machine-readable JSON log ──
            json_path = log_dir / f"wsl_scan_{stamp}.json"
            payload = {
                "scan_id": report.scan_id,
                "started_utc": report.started_utc,
                "finished_utc": report.finished_utc,
                "hostname": report.hostname,
                "wsl_distro": report.wsl_distro,
                "wsl_version": report.wsl_version,
                "total_severity_score": report.total_severity,
                "reset_severity_threshold": RESET_SEVERITY_THRESHOLD,
                "reset_recommended": report.reset_recommended,
                "finding_count": len(report.findings),
                "findings": [
                    {
                        "category": f.category,
                        "severity": f.severity,
                        "severity_label": SEVERITY_LABELS.get(f.severity, str(f.severity)),
                        "title": f.title,
                        "detail": f.detail,
                    }
                    for f in report.findings
                ],
                "binary_hashes": report.binary_hashes,
                "signature_results": report.signature_results,
            }
            json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            written.append(json_path)

            # ── Human-readable summary ──
            txt_path = log_dir / f"wsl_scan_{stamp}.txt"
            SEP = "=" * 72
            lines = [
                "WSL CROSS-BOUNDARY THREAT INTELLIGENCE SCAN",
                SEP,
                f"Scan ID     : {report.scan_id}",
                f"Host        : {report.hostname}",
                f"WSL Distro  : {report.wsl_distro}",
                f"WSL Version : {report.wsl_version}",
                f"Started     : {report.started_utc}",
                f"Finished    : {report.finished_utc}",
                f"Severity    : {report.total_severity} "
                f"(threshold for reset recommendation: {RESET_SEVERITY_THRESHOLD})",
                f"RESET REC.  : {'YES — see operator guidance at end of this file' if report.reset_recommended else 'No'}",
                SEP,
                "",
                f"FINDINGS ({len(report.findings)} total, sorted by severity):",
                "",
            ]

            for f in sorted(report.findings, key=lambda x: -x.severity):
                sev_label = SEVERITY_LABELS.get(f.severity, str(f.severity))
                lines.append(f"  [{sev_label}] [{f.category.upper()}]  {f.title}")
                for detail_line in f.detail[:600].splitlines():
                    lines.append(f"    {detail_line}")
                lines.append("")

            lines += [
                SEP,
                "BINARY HASHES (verify against Microsoft SSDC / VirusTotal):",
                "",
            ]
            for path, h in report.binary_hashes.items():
                lines.append(f"  {h}  {path}")

            if report.signature_results:
                lines += ["", "AUTHENTICODE SIGNATURES:", ""]
                for r in report.signature_results:
                    lines.append(
                        f"  [{r.get('Status','?')}]  {r.get('Path','?')}"
                        + (f"\n    Subject: {r.get('Subject','')}" if r.get("Subject") else "")
                    )

            if report.reset_recommended:
                lines += [
                    "",
                    SEP,
                    "OPERATOR ACTION REQUIRED — WSL RESET RECOMMENDED",
                    SEP,
                    "",
                    "The cumulative severity score exceeds the threshold for a reset",
                    "recommendation. Findings suggest possible lateral movement between",
                    "the Windows environment and this WSL instance.",
                    "",
                    "Steps (execute from an ELEVATED Windows PowerShell or Windows Terminal):",
                    "",
                    "  1. Archive this log file and the accompanying JSON for incident records.",
                    f"     Source: {log_dir}",
                    "",
                    "  2. Identify your WSL distro name if not already known:",
                    "       wsl --list --verbose",
                    "",
                    "  3. Terminate the distro cleanly:",
                    "       wsl --terminate <DistroName>",
                    "",
                    "  4. Unregister (this DESTROYS the instance's virtual disk):",
                    "       wsl --unregister <DistroName>",
                    "",
                    "  5. Reinstall the distro from the Microsoft Store.",
                    "     Do NOT restore from a backup taken after the initial",
                    "     infection window — the backup may contain lateral artefacts.",
                    "",
                    "  6. Review and update Windows-side persistence artefacts before",
                    "     bringing a new WSL instance online.",
                    "",
                ]

            txt_path.write_text("\n".join(lines), encoding="utf-8")
            written.append(txt_path)

            # ── Reset flag file ──
            if report.reset_recommended:
                flag_path = log_dir / "RESET_RECOMMENDED.flag"
                flag_path.write_text(
                    f"WSL reset recommended. Scan: {stamp}.\n"
                    f"See wsl_scan_{stamp}.txt for full operator guidance.\n",
                    encoding="utf-8",
                )
                written.append(flag_path)

        except OSError:
            continue

    return written


# ── Main ────────────────────────────────────────────────────────────────────────

def main() -> int:
    stamp = dt.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    started = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    hostname = socket.gethostname()
    distro = os.environ.get("WSL_DISTRO_NAME", "unknown")

    rc_ver, ver_out, _ = run(["wsl.exe", "--version"])
    wsl_version = ver_out.strip().splitlines()[0] if rc_ver == 0 and ver_out.strip() else "unknown"

    report = ScanReport(
        scan_id=stamp,
        started_utc=started,
        hostname=hostname,
        wsl_distro=distro,
        wsl_version=wsl_version,
    )

    print(f"WSL cross-boundary scan  |  {started}  |  {hostname}  |  {distro}")

    modules: list[tuple[str, Any]] = [
        ("Network",                 scan_network),
        ("Interop processes",       scan_interop_processes),
        ("Windows filesystem",      scan_windows_filesystem),
        ("Defender state",          scan_defender_state),
        ("WSL filesystem integrity",scan_wsl_filesystem_integrity),
    ]

    for module_name, module_fn in modules:
        print(f"  [{module_name}] ...", end=" ", flush=True)
        try:
            found = module_fn()
            report.findings.extend(found)
            high = sum(1 for f in found if f.severity >= 3)
            print(f"{len(found)} finding(s)" + (f"  ({high} HIGH+)" if high else ""))
        except Exception as exc:
            print(f"ERROR: {exc}")
            report.findings.append(Finding(
                category="scan_error",
                severity=1,
                title=f"Module '{module_name}' raised an unhandled exception",
                detail=str(exc),
            ))

    # Binary signatures and hashes are collected separately.
    print("  [Binary signatures] ...", end=" ", flush=True)
    try:
        sig_findings, sig_results = scan_binary_signatures()
        report.findings.extend(sig_findings)
        report.signature_results = sig_results
        print(f"{len(sig_findings)} finding(s)")
    except Exception as exc:
        print(f"ERROR: {exc}")

    print("  [Binary hashes] ...", end=" ", flush=True)
    try:
        report.binary_hashes = scan_binary_hashes()
        print(f"{len(report.binary_hashes)} binaries hashed")
    except Exception as exc:
        print(f"ERROR: {exc}")

    report.finished_utc = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    report.total_severity = compute_severity(report.findings)
    report.reset_recommended = report.total_severity >= RESET_SEVERITY_THRESHOLD

    written = write_outputs(report)

    print()
    print(f"Severity score   : {report.total_severity}  (threshold: {RESET_SEVERITY_THRESHOLD})")
    print(f"Reset recommended: {'YES' if report.reset_recommended else 'No'}")
    print("Logs written to:")
    for p in written:
        print(f"  {p}")

    # Exit 2 if reset recommended, 1 if any findings, 0 if clean.
    if report.reset_recommended:
        return 2
    if report.findings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
