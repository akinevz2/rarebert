# RareBERT Working Design And Findings

## 1. Scope

RareBERT is being implemented as a hybrid system:

- Python-first orchestration in this repository root.
- Quarkus service endpoints in [rarebert-host](rarebert-host) for pure functional gene operations.
- Markdown/Pandoc reporting in [academic-report](academic-report).

Primary objective: evolve agent populations for propaganda detection using genetic operators and shared feature pipelines.

## 2. Architecture Decisions So Far

### 2.1 Split orchestration from compute resources

Decision:

- Keep long-lived state and workflow control in Python.
- Keep agent transformation logic (init/classify/mutate/recombine) in Quarkus resources.

Rationale:

- Python remains flexible for experiments, data processing, and scheduling.
- Quarkus endpoints stay stateless and horizontally scalable.

### 2.2 Stateless service contract for agent logic

Decision:

- Quarkus resources are pure functional projections per request.
- No server-side hidden state between calls.

Rationale:

- Improves reproducibility and debugging.
- Makes persisted Python-side gene snapshots authoritative.

Reference: [quarkus.md](quarkus.md).

### 2.3 Single HTTP boundary in Python agent

Decision:

- Agent methods delegate through a single invoke boundary.
- HTTP failures are not swallowed.

Rationale:

- Clear observability of backend failures.
- Predictable behavior under training-loop retries.

Reference: [agent.py](agent.py), [agent.py.md](agent.py.md).

### 2.4 Repository-local persistence via SQLite

Decision:

- Use rarebert.db in repository root for generic key-value persistence.
- Use namespaced JSON payloads for module interoperability.

Rationale:

- Zero external database dependency for development and coursework.
- Easy auditability of saved artifacts.

Reference: [devlib.py](devlib.py).

### 2.5 Local dependency isolation

Decision:

- Auto-install module dependencies into .rarebert_deps, not global shell paths.

Rationale:

- Reproducible behavior in devcontainer without mutating user shell startup.
- Keeps per-project package constraints isolated.

Reference: [devlib.py](devlib.py), [hyper-tag.py](hyper-tag.py).

## 3. Implemented Components

### 3.1 Build/bootstrap tooling

- [dev.py](dev.py) generates [Makefile](Makefile) from local modules.
- `make add MODULE=<name>` scaffolds module files and refreshes targets.

### 3.2 Infrastructure utilities

- [devlib.py](devlib.py)
  - run wrapper.
  - SQLite helpers: init_db, save_data, load_data, list_keys, delete_data.
  - Local dependency installation helper.

### 3.3 Diagnostics and runtime helpers

- [check-hosts.py](check-hosts.py): probes Ollama `/api/tags` across hosts.
- [query.py](query.py): prompt interface for Ollama models.

### 3.4 Data exploration

- [visualise-data.py](visualise-data.py)
  - Pager output for TSV rows.
  - Label-based line coloring.
  - BOS/EOS span highlighting.

### 3.5 Hyper-feature extraction

- [hyper-tag.py](hyper-tag.py)
  - POS tagging.
  - Word-sense assignment (Lesk + WordNet).
  - Optional Ollama enrichment.
  - SQLite persistence under namespace hyper_features.

## 4. Findings To Date

### 4.1 Dataset format

- Course data in [propaganda_dataset_v2](propaganda_dataset_v2) is TSV.
- Primary fields: label and tagged_in_context.
- Target spans are delimited by BOS/EOS markers.

### 4.2 Environment findings

- Container networking required explicit host mapping for LAN hostnames.
- Python image lacked pip and ensurepip in default path; fallback provisioning was needed.
- Newer NLTK resource naming required additional assets:
  - punkt_tab
  - averaged_perceptron_tagger_eng

### 4.3 Service reachability

- Host checks and query tooling can reach configured remote hosts when DNS/host mapping is correct.
- Endpoint behavior can differ by route/model and must be treated as runtime variability.

## 5. Reproducible Commands

From [uni/rarebert](.) root:

```sh
make help
make check-hosts HOSTS=192.168.137.133
make visualise-data FILE=propaganda_dataset_v2/propaganda_train.tsv
make hyper-tag FILE=propaganda_dataset_v2/propaganda_val.tsv LIMIT=20
make hyper-tag FILE=propaganda_dataset_v2/propaganda_val.tsv LIMIT=20 WHOM=gemma4:latest WHERE=ws-raretower
```

## 6. Open Design Items

- Define exact GA chromosome schema for each agent family.
- Standardize classify request/response DTOs across all Quarkus agent resources.
- Add training loop module to compute fitness and evolutionary step scheduling.
- Decide report metric set: precision/recall/F1 plus per-technique breakdown.

## 7. Next Milestones

1. Implement initial Quarkus resources (init/classify/mutate/recombine) matching contracts.
2. Implement Python training ground loop using persisted gene snapshots.
3. Add evaluation pipeline over train/val splits and export graphs/tables for report insertion.