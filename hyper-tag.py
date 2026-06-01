"""Rapid POS + word-sense tagging interface for propaganda TSV datasets."""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from devlib import (
    ensure_local_packages,
    env_or_arg,
    list_available_ollama_hosts,
    parse_kv_args,
    prompt_text,
    require_arg_or_prompt,
    run,
    save_data,
    select_ollama_host_tui,
)


def parse_int_arg(args: dict[str, str], name: str, default: int) -> int:
    """Parse integer argument or return default when unset."""
    raw = args.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < 1:
        raise ValueError(f"{name} must be > 0")
    return value


def normalize_where(where_value: str) -> str:
    """Normalize WHERE into a valid URL base for Ollama."""
    where_value = where_value.strip().rstrip("/")
    if where_value.startswith(("http://", "https://")):
        return where_value
    if re.search(r":\d+$", where_value):
        return f"http://{where_value}"
    return f"http://{where_value}:11434"


def ensure_nltk() -> tuple[Any, Any, Any]:
    """Install/import NLTK and required corpora locally in the project folder."""
    deps_path = ensure_local_packages([("nltk>=3.9", "nltk")])

    import nltk  # pylint: disable=import-outside-toplevel
    from nltk.corpus import wordnet as wn  # pylint: disable=import-outside-toplevel
    from nltk.wsd import lesk  # pylint: disable=import-outside-toplevel

    data_dir = deps_path.parent / ".nltk_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    if str(data_dir) not in nltk.data.path:
        nltk.data.path.insert(0, str(data_dir))

    required_resources = {
        "tokenizers/punkt": "punkt",
        "tokenizers/punkt_tab": "punkt_tab",
        "taggers/averaged_perceptron_tagger": "averaged_perceptron_tagger",
        "taggers/averaged_perceptron_tagger_eng": "averaged_perceptron_tagger_eng",
        "corpora/wordnet": "wordnet",
        "corpora/omw-1.4": "omw-1.4",
    }

    for resource_path, resource_name in required_resources.items():
        try:
            nltk.data.find(resource_path)
        except LookupError:
            nltk.download(resource_name, download_dir=str(data_dir), quiet=True)

    return nltk, wn, lesk


def strip_markers(text: str) -> str:
    """Remove BOS/EOS markers while keeping sentence content intact."""
    text = text.replace("<BOS>", "").replace("<EOS>", "")
    return re.sub(r"\s+", " ", text).strip()


def wn_pos(tag: str) -> str | None:
    """Map Penn POS tags to WordNet POS tags."""
    if tag.startswith("J"):
        return "a"
    if tag.startswith("V"):
        return "v"
    if tag.startswith("N"):
        return "n"
    if tag.startswith("R"):
        return "r"
    return None


def ollama_enrich(base_url: str, model: str, sentence: str, tagged: list[dict[str, str]]) -> dict[str, Any]:
    """Ask Ollama for extra hyper-feature hints."""
    endpoint = f"{base_url}/api/generate"
    prompt = (
        "Return strict JSON with keys hyper_features (string list) and rationale (string). "
        "Use this sentence and token annotations for propaganda-analysis feature extraction.\n"
        f"sentence: {sentence}\n"
        f"annotations: {json.dumps(tagged, ensure_ascii=False)}"
    )
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }
    req = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urlopen(req, timeout=45) as response:  # nosec B310: intentional HTTP boundary
        raw = json.loads(response.read().decode("utf-8"))

    llm_response = raw.get("response")
    if not isinstance(llm_response, str):
        return {}
    try:
        parsed = json.loads(llm_response)
    except json.JSONDecodeError:
        return {"raw": llm_response}
    if isinstance(parsed, dict):
        return parsed
    return {"raw": llm_response}


def process_file(
    file_path: Path,
    limit: int,
    model: str | None,
    where: str | None,
) -> tuple[int, int]:
    """Tag sentences and persist results to SQLite."""
    nltk, _, lesk = ensure_nltk()

    base_url = normalize_where(where) if where else None
    processed = 0
    enriched = 0

    with file_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        for index, row in enumerate(reader):
            if not row:
                continue
            if index == 0 and len(row) >= 2 and row[0].lower() == "label":
                continue
            if processed >= limit:
                break

            label = row[0]
            sentence = strip_markers("\t".join(row[1:]) if len(row) > 1 else "")
            tokens = nltk.word_tokenize(sentence)
            pos_tags = nltk.pos_tag(tokens)

            tagged: list[dict[str, str]] = []
            for token, pos in pos_tags:
                synset = lesk(tokens, token, pos=wn_pos(pos))
                tagged.append(
                    {
                        "token": token,
                        "pos": pos,
                        "sense": synset.name() if synset else "",
                    }
                )

            record: dict[str, Any] = {
                "dataset_label": label,
                "sentence": sentence,
                "tokens": tokens,
                "tagged": tagged,
            }

            if model and base_url:
                try:
                    record["ollama"] = ollama_enrich(base_url, model, sentence, tagged)
                    enriched += 1
                except (HTTPError, URLError, TimeoutError) as exc:
                    record["ollama_error"] = str(exc)

            key = f"{file_path.name}:{processed:06d}"
            save_data("hyper_features", key, record)
            processed += 1

            print(
                f"[{processed}] label={label} tokens={len(tokens)} "
                f"senses={sum(1 for item in tagged if item['sense'])}"
            )

    return processed, enriched


def tsv_suggestions() -> list[str]:
    """Suggest TSV files from current directory tree for FILE prompt."""
    found = sorted(Path.cwd().glob("**/*.tsv"))
    return [str(path) for path in found[:80]]


def discovered_model_suggestions() -> list[str]:
    """Collect model suggestions from persisted Ollama hosts."""
    names: list[str] = []
    seen: set[str] = set()
    for host in list_available_ollama_hosts():
        for model in host.get("models", []):
            candidate = str(model).strip()
            if candidate and candidate not in seen:
                seen.add(candidate)
                names.append(candidate)
    return names


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        file_value = require_arg_or_prompt(
            args,
            "FILE",
            "TSV file path (FILE)",
            suggestions=tsv_suggestions(),
        )
        file_path = Path(file_value)
        if not file_path.exists():
            raise FileNotFoundError(f"file not found: {file_path}")

        limit_raw = env_or_arg(args, "LIMIT", "50")
        if not env_or_arg(args, "LIMIT"):
            limit_raw = prompt_text("Record limit (LIMIT)", default="50")
        args["LIMIT"] = limit_raw
        limit = parse_int_arg(args, "LIMIT", 50)

        model = env_or_arg(args, "WHOM") or None
        if model is None:
            model_entered = prompt_text(
                "Model for enrichment (WHOM, blank to skip)",
                suggestions=discovered_model_suggestions(),
                allow_empty=True,
            )
            model = model_entered or None

        where = env_or_arg(args, "WHERE") or None
        if model and not where:
            where = select_ollama_host_tui("Select an Ollama host for hyper-tag enrichment")

        processed, enriched = process_file(file_path, limit=limit, model=model, where=where)
        print(f"Saved {processed} records to namespace 'hyper_features' in rarebert.db")
        if model and where:
            print(f"Ollama-enriched records: {enriched}")
        return 0
    except (ValueError, FileNotFoundError, RuntimeError, ModuleNotFoundError) as exc:
        print(f"Error: {exc}")
        print(
            "Usage: python3 hyper-tag.py FILE=<path/to.tsv> [LIMIT=50] "
            "[WHOM=<model> WHERE=<host>]"
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(run(main))
