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
