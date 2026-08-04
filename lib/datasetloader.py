#!/usr/bin/env python3
"""
datasetloader module - dataset loading API scaffold.

Terse API spec (implementations deferred):
    load(name)            -> Dataset
    load_path(path)       -> Dataset
    load_csv(path, **kw)  -> Dataset
    load_json(path, **kw) -> Dataset
    load_dir(path)        -> list[Dataset]
    splits(name)          -> dict[str, Dataset]
    columns(dataset)      -> list[str]
    schema(dataset)       -> dict[str, type]
    iter_rows(dataset)    -> Iterator[dict]
    write(dataset, path)  -> None
    register(name, path)  -> None
    available()           -> set[str]
"""

from typing import Any, Dict, Iterator, List, Sequence, Set

class Dataset:
    """Minimal dataset container. Not implemented."""
    def __init__(self, rows: Sequence[dict] | None = None) -> None:
        self.rows = list(rows or [])

    def __len__(self) -> int:
        raise NotImplementedError

    def __iter__(self) -> Iterator[dict]:
        raise NotImplementedError

def load(name: str) -> "Dataset":
    """Load a registered dataset by name. Not implemented."""
    raise NotImplementedError

def load_path(path: str) -> "Dataset":
    """Load a dataset from an arbitrary file path (format inferred). Not implemented."""
    raise NotImplementedError

def load_csv(path: str, **kwargs: Any) -> "Dataset":
    """Load a CSV file into a Dataset. Not implemented."""
    raise NotImplementedError

def load_json(path: str, **kwargs: Any) -> "Dataset":
    """Load a JSON file (or JSONL) into a Dataset. Not implemented."""
    raise NotImplementedError

def load_dir(path: str) -> List["Dataset"]:
    """Load every recognized file in a directory. Not implemented."""
    raise NotImplementedError

def splits(name: str) -> Dict[str, "Dataset"]:
    """Return train/val/test (or similar) splits for a named dataset. Not implemented."""
    raise NotImplementedError

def columns(dataset: "Dataset") -> List[str]:
    """Return the column names of a dataset. Not implemented."""
    raise NotImplementedError

def schema(dataset: "Dataset") -> Dict[str, type]:
    """Return a {column: python_type} mapping for a dataset. Not implemented."""
    raise NotImplementedError

def iter_rows(dataset: "Dataset") -> Iterator[dict]:
    """Yield rows of a dataset as dicts. Not implemented."""
    raise NotImplementedError

def write(dataset: "Dataset", path: str) -> None:
    """Persist a dataset to disk (format inferred from extension). Not implemented."""
    raise NotImplementedError

def register(name: str, path: str) -> None:
    """Register a local path under a dataset name. Not implemented."""
    raise NotImplementedError

def available() -> Set[str]:
    """Return the set of registered dataset names. Not implemented."""
    raise NotImplementedError