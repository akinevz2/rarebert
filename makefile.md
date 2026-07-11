# rarebert module touch log
# updated: 2026-07-11

Python modules touched:
- agent.py (edited: revoked execution path)
- add-repo-error.py (read and executed via make target)
- notify.py (read)
- query.py (read)
- reminders.py (read)
- scan.py (read)
- visualise-data.py (read)
- dev.py (read)
- devlib.py (read)
- add-notification.py (inspected via grep)
- add-java.py (inspected via grep)

Notes:

Go updates:

```bash
Use these three modules through `make` in Makefile.

**1) `notify`**
What it does:
1. Prints current reminders.
2. Looks for local `.ntfy` symlinks in the current folder.
3. Opens linked directories in your editor (if links exist).

Command:
1. `make notify`

Expected output:
1. `Reminders: ...`
2. Either `Notification draft directories: ...` or `No .ntfy links found.`

**2) `add-notification`**
What it does:
1. Appends a new `URGENT:` entry into reminders.py.
2. Immediately runs `notify` so you can see the updated list.

Command:
1. `make add-notification URGENT='your message here'`

Example:
1. `make add-notification URGENT='rotate home profile maintenance cycle'`

Common failure:
1. Missing `URGENT` value -> you’ll get usage error.
2. Fix by ensuring the value is quoted if it has spaces.

**3) `scan`**
What it does:
1. Scans configured roots (including home-related paths) for:
1. `ERROR.ws`
2. `NOTIFY.ntfy`
2. Archives found `ERROR.ws` files into local `ERRORS/<n>.ws`.
3. Appends found `NOTIFY.ntfy` content into reminders list in reminders.py.

Command:
1. `make scan`

Expected output:
1. Number of directories scanned.
2. Found/moved `ERROR.ws` files (if any).
3. Found `NOTIFY.ntfy` files (if any), or “none found”.

Suggested operating sequence:
1. `make add-notification URGENT='message'`
2. `make notify`
3. `make scan`
4. `make notify` (to verify reminder list after scan)
``Use these three modules through `make` in Makefile.

**1) `notify`**
What it does:
1. Prints current reminders.
2. Looks for local `.ntfy` symlinks in the current folder.
3. Opens linked directories in your editor (if links exist).

Command:
1. `make notify`

Expected output:
1. `Reminders: ...`
2. Either `Notification draft directories: ...` or `No .ntfy links found.`

**2) `add-notification`**
What it does:
1. Appends a new `URGENT:` entry into reminders.py.
2. Immediately runs `notify` so you can see the updated list.

Command:
1. `make add-notification URGENT='your message here'`

Example:
1. `make add-notification URGENT='rotate home profile maintenance cycle'`

Common failure:
1. Missing `URGENT` value -> you’ll get usage error.
2. Fix by ensuring the value is quoted if it has spaces.

**3) `scan`**
What it does:
1. Scans configured roots (including home-related paths) for:
1. `ERROR.ws`
2. `NOTIFY.ntfy`
2. Archives found `ERROR.ws` files into local `ERRORS/<n>.ws`.
3. Appends found `NOTIFY.ntfy` content into reminders list in reminders.py.

Command:
1. `make scan`

Expected output:
1. Number of directories scanned.
2. Found/moved `ERROR.ws` files (if any).
3. Found `NOTIFY.ntfy` files (if any), or “none found”.

Suggested operating sequence:
1. `make add-notification URGENT='message'`
2. `make notify`
3. `make scan`
4. `make notify` (to verify reminder list after scan)`

- Executed local scan tool via `make scan` to perform ~/dots/home-path sweep using in-repo tooling only.
- Scan result: no ERROR.ws files found and no NOTIFY.ntfy files found.

- Added Makefile-native command examples via new `examples` target.
- Updated help output to advertise `make examples`.
- Verified `make examples` prints scan, print, add-notification, add-repo-error, and query command examples.

- Resolved remote ntfy flow: make add-repo-error is the command path that creates/uses remote ERROR.ws and appends remote ERROR.ntfy.
- Confirmed supporting visibility path: make print reads local ERROR.ntfy when present.

- Committed current workspace updates with message: "chore: stabilize make module flow and ntfy logging".
- Pushed main to origin (https://github.com/akinevz2/rarebert) at commit 96896fd.

- Cloned .log to README.md and launched: code --wait --new-window README.md
