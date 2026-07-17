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

## 3. Implementation Plan

- [ ] **data loading** — read the training documents and their gold-standard span labels (start index, end index, class)

- [ ] **tokenisation** — split text into tokens you can index spans over

- [ ] **feature extraction** — for each candidate span, pull string-level features (you're doing this without numerics, so things like word shape, surrounding tokens, n-grams, capitalisation etc.)

- [ ] **span candidate generation** — decide which chunks of text are even worth classifying (sliding window, or sentence-bounded)

- [ ] **classifier** — your coevolution thing: LCS rules + token weight "perceptrons" competing to label a span as one of the 10 propaganda classes (or none)

- [ ] **evolution loop** — the genetic/coevolution cycle that improves the rules/weights over generations against training data

- [ ] **prediction output** — given a document, produce a list of (start, end, class) predictions

- [ ] **evaluation** — compare predictions to gold labels, compute span-level F1 (partial overlap handling matters here)

- [ ] **benchmarking harness** — run eval across the full test set, report per-class and macro scores

- [ ] **visualisation** — show annotated spans on text, probably in the quarkus web layer

### 3.1 Build/bootstrap tooling

- [dev.py](dev.py) generates [Makefile](Makefile) from local modules.
- `make add MODULE=<name>` scaffolds module files and refreshes targets.

### 3.2 Infrastructure utilities

- [devlib.py](devlib.py)
  - run wrapper.
  - SQLite helpers: init_db, save_data, load_data, list_keys, delete_data.
  - Local dependency installation helper.
  - Ollama host utilities:
    - reachable host registration and model cache.
    - host alias mapping (`hostname -> usable host`).
    - interactive host/model TUI selectors with prefix-first filtering.

### 3.3 Diagnostics and runtime helpers

- [check-hosts.py](check-hosts.py): probes Ollama `/api/tags` across hosts.
- [query.py](query.py): prompt interface for Ollama models with host-resolution and interactive model selection.
- [get-usable-hosts.py](get-usable-hosts.py): lists known usable Ollama hosts and cached model lists.

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

### 3.6 Training-set preparation

- [get-training-set.py](get-training-set.py)
  - Reads propaganda TSV input.
  - Exports JSON array records with: `classification`, `raw_data`, `span`, `clean`.
  - Supports `FILE=...` argument and interactive FILE prompt when omitted.

### 3.7 Scaffolds pending implementation

- [get-knowledge-file.py](get-knowledge-file.py): scaffold only (no runtime logic yet).

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

- Reachable Ollama endpoints are persisted as usable hosts in SQLite.
- IP-based WHERE values are validated for Ollama reachability before use.
- Unknown hostname WHERE values require interactive mapping to a known usable host.
- Endpoint behavior can differ by route/model and should be treated as runtime variability.

## 5. Reproducible Commands

From [uni/rarebert](.) root:

```sh
make help
make check-hosts HOSTS=192.168.137.133
make get-usable-hosts
make get-training-set FILE=propaganda_dataset_v2/propaganda_train.tsv
make visualise-data FILE=propaganda_dataset_v2/propaganda_train.tsv
make hyper-tag FILE=propaganda_dataset_v2/propaganda_val.tsv LIMIT=20
make hyper-tag FILE=propaganda_dataset_v2/propaganda_val.tsv LIMIT=20 WHOM=gemma4:latest WHERE=192.168.137.133:11434
make query WHERE=192.168.137.133:11434 ASK="Hello"
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

## 8. dev-java.py — Java Module Scaffolder (Makefile Extension)

Mirrors the pattern of `dev.py` for the Java/Quarkus side of the project.
Java source lives under `./rarebert-host/` and is managed by Maven.

### 8.1 dev-java.py behaviour

- [ ] Accept `add` subcommand with `--module`, `--package` (optional), `--copy` (optional) arguments
- [ ] Resolve target path as `./rarebert-host/src/main/java/<package>/<Module>.java`
- [ ] If `--package` omitted, place class in root source directory
- [ ] If `--copy` provided, read from `./rarebert-host/src/templates/<copy>.java` as scaffold base
- [ ] If `--copy` omitted, generate a minimal class scaffold with package declaration, class stub, and a `TODO` comment
- [ ] Substitute template placeholders: at minimum `{{CLASS_NAME}}` and `{{PACKAGE}}`
- [ ] Refuse to overwrite existing files, print clear error matching `dev.py` style
- [ ] Print created file path on success, matching `dev.py` output style

### 8.2 Template conventions (`./rarebert-host/src/templates/`)

- [ ] Create `./rarebert-host/src/templates/` folder
- [ ] Add `Resource.java` — template for a Quarkus REST resource class
- [ ] Add `Service.java` — template for a plain service/logic class
- [ ] Add `Interface.java` — template for a pluggable interface (primary use case for GA character scorer and agent family contracts)
- [ ] All templates use `{{CLASS_NAME}}` and `{{PACKAGE}}` as substitution tokens

### 8.3 Integration notes

- Complements existing `dev.py` pattern; does not modify it
- Template folder is the canonical source for new Quarkus agent family stubs (ref: Section 6 open items)
- `COPY=Interface` is the expected default when scaffolding new agent resources matching classify/mutate/recombine contracts