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

WoW discussion helper (local Ollama):

- Fastest path (interactive prompts for missing args):
	- make wow-discussion
- Generic pattern for any module:
	- make <module-name>
	- make <module-name> ARG='KEY=VALUE'
	- make <module-name> ARGS='KEY1=VALUE1 KEY2=VALUE2'
- Start a session:
	- make wow-discussion SESSION=tbc WHOM=gemma4:latest TOPIC="holy paladin pre-raid priorities"
- Enable web-augmented context:
	- make wow-discussion SESSION=tbc SEARCH=1 TOPIC="ret paladin stat weights for heroics"
- Recall previous answers in a session:
	- make wow-discussion SESSION=tbc RECALL="resilience"
- List saved sessions:
	- make wow-discussion LIST=1
- Reset a session:
	- make wow-discussion SESSION=tbc RESET=1
