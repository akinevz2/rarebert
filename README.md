# rarebert

Rarebert is a Makefile/Python-based project for rapid prototyping of small scriptlets, with the primary goal of evaluating Ollama models across multiple hosts.

---

## Incident response toolkit — BlueHammer / `Exploit:Win32/DfndrPEBluHmr.BB`

Five files in this repository were pushed here under incident conditions on 2026-05-29 and are not part of the core Ollama evaluation work. They are housed here because this was the nearest available version-controlled repository with a working remote at the time they were needed.

### Background

Microsoft Defender detects the original proof-of-concept binary for this technique as `Exploit:Win32/DfndrPEBluHmr.BB`. That detection covers only the compiled PoC sample — not the underlying attack chain. Recompiling from source with minor changes bypasses the signature entirely; the behavioral TTPs remain undetected by static analysis.

The full attack chain, as documented by the Cyderes analysis, proceeds as follows:

1. **In-memory Defender update hijack.** A legitimate Defender update executable is fetched directly from Microsoft's update URL. The PE is parsed in memory, the embedded `update.cab` from the `.rsrc` section is extracted and unpacked in memory, and the resulting files are used as the update source for spoofed internal Defender RPC calls via `ServerMpUpdateEngineSignature`.
2. **NTFS junction redirect.** The Defender update path is redirected toward an attacker-controlled directory via NTFS junctions, allowing attacker-supplied signature content to be loaded into the Defender engine without triggering Authenticode checks on the engine binary itself.
3. **Oplock TOCTOU on the Defender elevation boundary.** Opportunistic locks are used to create a time-of-check/time-of-use race against the MsMpEng.exe elevation/deelevation cycle, exploiting the Win32 kernel boundary between the check and the subsequent elevated file access.
4. **VSS enumeration for timing reconnaissance.** `NtQueryDirectoryObject` calls targeting `HarddiskVolumeShadowCopy*` objects from a user-space process are used for environment reconnaissance. This has no legitimate use case outside system and backup tooling.
5. **Cloud Files sync root registration as timing trap.** `CfRegisterSyncRoot` is called from an untrusted process to create the timing condition the escalation chain depends on. This API is not commonly invoked by general-purpose applications.
6. **Transient service creation for privilege escalation.** `CreateService` is called from a low-privileged user context to briefly register a malicious temporary service and acquire a SYSTEM-integrity token.
7. **Administrator password reset via `samlib.dll`.** `SamiChangePasswordUser` is used to forcibly reset the built-in local Administrator password to an attacker-controlled value, authenticate, and then restore the original hash. Windows Security event IDs **4723** and **4724** in rapid succession are the observable indicator.

Because the technique abuses the interaction of legitimate Windows components rather than any single binary, standard static detection is insufficient. Remediation and detection must be behavioral.

### Files

| File | Purpose |
|---|---|
| `wsl_scan.py` | Standalone WSL2 cross-boundary sensor. Runs from within a healthy WSL instance as an independent layer when Win32 diagnostics cannot be trusted. Checks network routing, interop processes, DRVFS filesystem view of Windows Temp and staging paths, Authenticode signatures, Defender state, and WSL filesystem integrity. Logs to `/mnt/c/ProgramData/MalwareRemoval/` and raises `RESET_RECOMMENDED.flag` if severity threshold is met. |
| `deploy_malware_removal.py` | Deployer and scheduler. Stages the hardened PowerShell removal package to Windows, validates SHA-256 package integrity before deployment, enforces non-empty IOC lists, supports `Audit`/`Execute` modes with an explicit `--allow-live` guard, UAC elevation, and weekly maintenance scan scheduling via Task Scheduler (Windows) and cron (WSL). |
| `malware_removal_notebook.ipynb` | Interactive package builder. Populates IOC lists, generates `remediate_windows.ps1` with mandatory admin check, transcript logging, and runtime hash verification, and produces a signed `manifest.json`. Includes BlueHammer-specific remediation steps including forced Administrator password rotation and Event ID 4723/4724 monitoring guidance. |
| `malware_removal_runbook.ipynb` | No-triage removal runbook. Intended for use when malicious processes are already observed and Win32 user-mode diagnostics are suspected to be spoofed. Dry-run safe by default; exports a standalone `.ps1` for elevated execution. |
| `result.md` | Post-removal hardening guidance paragraph generated at the close of the initial response. |

### Behavioral detection priorities (from Cyderes analysis)

- `NtQueryDirectoryObject` targeting `HarddiskVolumeShadowCopy*` from non-system processes
- `CfRegisterSyncRoot` called outside known cloud sync software
- `CreateService` from a standard user context
- Security Event IDs **4723** and **4724** on the local Administrator account in rapid succession
- Any NTFS junction or reparse point created under Defender's update path

### Known attacker credential

If `SamiChangePasswordUser` was invoked, the password `$PWNed666!!!WDFAIL` has been observed set on the built-in Administrator account. Rotate all local administrator credentials on any affected host before considering remediation complete.
