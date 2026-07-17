# rarebert

RareBERT is an experimental propaganda-detection workspace built around two layers:

- Python orchestration in this repository root (dataset handling, feature extraction, agent lifecycle, persistence).
- Quarkus backend services in [rarebert-host](rarebert-host) for pure functional agent gene operations.

Current project state, architecture decisions, workflows, and reporting notes are documented in:

- [WORKING_DESIGN.md](WORKING_DESIGN.md)

Supporting contracts/specs:

- [agent.py.md](agent.py.md)
- [quarkus.md](quarkus.md)

Pandoc report scaffold:

- [academic-report](academic-report)

## Python Modules Documentation

This directory contains various Python modules for the propaganda detection system, organized by feature groups.

### Propaganda Detection & Analysis

#### agent.py
HTTP-bound agent interface for propaganda detection experiments.

#### query.py
Send a prompt to an Ollama model.

Usage examples:
  python3 query.py WHOM=llama3.2 WHERE=localhost ASK="Hello"
  make query WHOM=llama3.2 WHERE=localhost ASK="Hello"

#### hyper-analysis.py
Hyper-analysis pipeline using POS features with evaluation metrics.

#### hyper-tag.py
Rapid POS + word-sense tagging interface for propaganda TSV datasets.

#### get-training-set.py
Build a JSON training set from propaganda TSV files.

#### get-knowledge-file.py
Interactive browser for knowledge lexicon entries in rarebert.db.

#### scan.py
scan: collect ERROR.ws files and NOTIFY.ntfy reminders from a search tree.

#### visualise-data.py
Render a tagged TSV file in a pager with tag-based color coding.

### System Management & Orchestration

#### dev.py
Bootstrap a Makefile with recipes for Python modules in the current folder.

#### devlib.py
Shared utilities for generated development modules.

#### check-hosts.py
Check one or more hosts for a listening Ollama instance and list models.

Usage examples:
  python3 check-hosts.py HOST=localhost
  python3 check-hosts.py HOSTS=localhost,192.168.1.10 PORT=11434

#### get-usable-hosts.py
List known usable Ollama hosts and their installed models.

#### reminders.py
reminders: generated module scaffold.

#### notify.py
notify: generated module scaffold.

#### add-java.py
Scaffold Java modules under rarebert-host Maven source roots.

#### add-notification.py
add-notification: append an urgent reminder to reminders.py.

#### add-repo-error.py
add-repo-error: append a repository error note from an editor session.

### World of Warcraft Assistant

#### wow-discussion.py
World of Warcraft TBC discussion assistant powered by local Ollama.

Usage examples:
  make wow-discussion TOPIC="best pre-raid holy paladin pieces" WHOM=qwen3.6:27b-q4_K_M
  make wow-discussion SESSION=arena SEARCH=1 TOPIC="arms warrior pvp stat priority"
  make wow-discussion SESSION=arena RECALL="resilience" TOPIC="summarise previous advice"
  make wow-discussion SESSION=arena RESET=1

#### wow-list-sessions.py
List WoW discussion sessions with first/last user-message summaries.

Usage examples:
  make wow-list-sessions
  make wow-list-sessions ARG='DB=/path/to/rarebert.db'

### Media Processing

#### rip-internet-movie.py
Download internet video at highest available quality using yt-dlp.

Usage examples:
  make rip-internet-movie URL=https://www.youtube.com/watch?v=dQw4w9WgXcQ
  python3 rip-internet-movie.py URL=https://www.youtube.com/watch?v=dQw4w9WgXcQ

### Security & Analysis Tools

#### analysis/deploy_malware_removal.py
Deploy a hardened malware-removal package from WSL to Windows and execute safely.

Default behavior is safe: deploy + audit mode only.
Live execution requires explicit operator intent.
