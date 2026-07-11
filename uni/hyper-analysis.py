"""Hyper-analysis pipeline using POS features with evaluation metrics."""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from typing import Any

from devlib import (
    ensure_local_packages,
    env_or_arg,
    parse_kv_args,
    prompt_text,
    require_arg_or_prompt,
    run,
    save_data,
)


def parse_int_arg(args: dict[str, str], name: str, default: int) -> int:
    """Read integer argument with validation."""
    raw = args.get(name, "").strip()
    if not raw:
        return default
    try:
        out = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if out < 1:
        raise ValueError(f"{name} must be > 0")
    return out


def parse_float_arg(args: dict[str, str], name: str, default: float) -> float:
    """Read float argument with validation."""
    raw = args.get(name, "").strip()
    if not raw:
        return default
    try:
        out = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a float") from exc
    if out < 0.0:
        raise ValueError(f"{name} must be >= 0")
    return out


def ensure_nltk() -> Any:
    """Install/import NLTK and required corpora locally in the project folder."""
    deps_path = ensure_local_packages([("nltk>=3.9", "nltk")])

    import nltk  # pylint: disable=import-outside-toplevel

    data_dir = deps_path.parent / ".nltk_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    if str(data_dir) not in nltk.data.path:
        nltk.data.path.insert(0, str(data_dir))

    required_resources = {
        "tokenizers/punkt": "punkt",
        "tokenizers/punkt_tab": "punkt_tab",
        "taggers/averaged_perceptron_tagger": "averaged_perceptron_tagger",
        "taggers/averaged_perceptron_tagger_eng": "averaged_perceptron_tagger_eng",
    }
    for resource_path, resource_name in required_resources.items():
        try:
            nltk.data.find(resource_path)
        except LookupError:
            nltk.download(resource_name, download_dir=str(data_dir), quiet=True)

    return nltk


def strip_markers(text: str) -> str:
    """Remove BOS/EOS markers while keeping sentence content intact."""
    text = text.replace("<BOS>", "").replace("<EOS>", "")
    return re.sub(r"\s+", " ", text).strip()


def safe_div(numerator: float, denominator: float) -> float:
    """Division with zero fallback."""
    if denominator == 0:
        return 0.0
    return numerator / denominator


def pos_score(pos_tags: list[tuple[str, str]]) -> float:
    """Compute heuristic propaganda likelihood based on POS profile."""
    if not pos_tags:
        return 0.0

    total = float(len(pos_tags))
    adjective_like = sum(1 for _, pos in pos_tags if pos.startswith("JJ"))
    adverb_like = sum(1 for _, pos in pos_tags if pos.startswith("RB"))
    verb_like = sum(1 for _, pos in pos_tags if pos.startswith("VB"))
    pronoun_like = sum(1 for _, pos in pos_tags if pos.startswith("PRP"))

    score = (
        safe_div(adjective_like, total) * 1.2
        + safe_div(adverb_like, total) * 1.0
        + safe_div(verb_like, total) * 0.5
        + safe_div(pronoun_like, total) * 0.2
    )
    return score


def evaluate_file(file_path: Path, limit: int, threshold: float) -> dict[str, Any]:
    """Run POS-driven classification and return evaluation payload."""
    nltk = ensure_nltk()

    tp = tn = fp = fn = 0
    processed = 0
    pos_counts_propaganda: dict[str, int] = {}
    pos_counts_non: dict[str, int] = {}
    sample_rows: list[dict[str, Any]] = []

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
            tagged = nltk.pos_tag(tokens)
            score = pos_score(tagged)

            gold_is_propaganda = label != "not_propaganda"
            pred_is_propaganda = score >= threshold

            if gold_is_propaganda and pred_is_propaganda:
                tp += 1
            elif (not gold_is_propaganda) and (not pred_is_propaganda):
                tn += 1
            elif (not gold_is_propaganda) and pred_is_propaganda:
                fp += 1
            else:
                fn += 1

            target_map = pos_counts_propaganda if gold_is_propaganda else pos_counts_non
            for _, pos in tagged:
                target_map[pos] = target_map.get(pos, 0) + 1

            if len(sample_rows) < 5:
                sample_rows.append(
                    {
                        "label": label,
                        "score": round(score, 4),
                        "prediction": "propaganda" if pred_is_propaganda else "not_propaganda",
                        "sentence": sentence,
                    }
                )

            processed += 1

    precision = safe_div(tp, tp + fp)
    recall = safe_div(tp, tp + fn)
    f1 = safe_div(2 * precision * recall, precision + recall)
    accuracy = safe_div(tp + tn, tp + tn + fp + fn)

    pos_delta = []
    all_pos = sorted(set(pos_counts_propaganda) | set(pos_counts_non))
    for pos in all_pos:
        p = pos_counts_propaganda.get(pos, 0)
        n = pos_counts_non.get(pos, 0)
        pos_delta.append({"pos": pos, "propaganda_count": p, "non_count": n, "delta": p - n})
    pos_delta.sort(key=lambda item: abs(int(item["delta"])), reverse=True)

    return {
        "file": str(file_path),
        "limit": limit,
        "threshold": threshold,
        "processed": processed,
        "confusion": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        "metrics": {
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
            "accuracy": round(accuracy, 6),
        },
        "top_pos_delta": pos_delta[:12],
        "samples": sample_rows,
    }


def tsv_suggestions() -> list[str]:
    """Suggest TSV files from current directory tree for FILE prompt."""
    found = sorted(Path.cwd().glob("**/*.tsv"))
    return [str(path) for path in found[:80]]


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

        if not env_or_arg(args, "LIMIT"):
            args["LIMIT"] = prompt_text("Record limit (LIMIT)", default="500")
        if not env_or_arg(args, "THRESHOLD"):
            args["THRESHOLD"] = prompt_text("Classification threshold (THRESHOLD)", default="0.23")

        limit = parse_int_arg(args, "LIMIT", 500)
        threshold = parse_float_arg(args, "THRESHOLD", 0.23)

        result = evaluate_file(file_path, limit=limit, threshold=threshold)
        key = f"{file_path.name}:limit={limit}:thr={threshold:.4f}"
        save_data("hyper_analysis", key, result)

        print(json.dumps(result["metrics"], indent=2))
        print("Saved analysis record:", key)
        return 0
    except (ValueError, FileNotFoundError, RuntimeError, ModuleNotFoundError) as exc:
        print(f"Error: {exc}")
        print("Usage: python3 hyper-analysis.py FILE=<path/to.tsv> [LIMIT=500] [THRESHOLD=0.23]")
        return 2


if __name__ == "__main__":
    raise SystemExit(run(main))
