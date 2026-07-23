"""Build a JSON training set from propaganda TSV files."""

from __future__ import annotations

import csv
import json
import re
import signal
import sys
from pathlib import Path
from typing import Iterator, Optional


# Suppress broken pipe errors (common when piping to commands that exit early)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)


class TSVRecord:
    """Represents a single record from the TSV file."""
    
    def __init__(self, classification: str, raw_data: str):
        self.classification = classification.strip()
        self.raw_data = raw_data.strip()
        self._span, self._clean = self._extract_fields(raw_data)
    
    @staticmethod
    def _normalize_spaces(text: str) -> str:
        """Collapse repeated whitespace into single spaces."""
        return re.sub(r"\s+", " ", text).strip()
    
    @classmethod
    def _extract_fields(cls, raw_data: str) -> tuple[str, str]:
        """Extract span and clean text from raw data with BOS/EOS markers."""
        span_match = re.search(r"<BOS>\s*(.*?)\s*<EOS>", raw_data, flags=re.DOTALL)
        span = cls._normalize_spaces(span_match.group(1)) if span_match else ""
        
        clean = cls._normalize_spaces(
            raw_data.replace("<BOS>", "").replace("<EOS>", "")
        )
        return span, clean
    
    def to_dict(self) -> dict[str, str]:
        """Convert record to dictionary format for JSON output."""
        return {
            "classification": self.classification,
            "raw_data": self.raw_data,
            "span": self._span,
            "clean": self._clean,
        }


class TSVReader:
    """Handles reading and parsing of TSV data streams."""
    
    def __init__(self, stream: Iterator[str]):
        self.stream = stream
    
    def read_records(self) -> list[TSVRecord]:
        """Read all records from the TSV stream."""
        result: list[TSVRecord] = []
        reader = csv.reader(self.stream, delimiter="\t")
        
        for index, row in enumerate(reader):
            if not row:
                continue
            
            # Skip header row
            if index == 0 and row[0].strip().lower() in {"label", "class", "classification"}:
                continue
            
            record = self._parse_row(row)
            if record:
                result.append(record)
        
        return result
    
    def _parse_row(self, row: list[str]) -> Optional[TSVRecord]:
        """Parse a single row into a TSVRecord."""
        classification = row[0].strip()
        raw_data = "\t".join(row[1:]).strip() if len(row) > 1 else ""
        return TSVRecord(classification, raw_data)


class TrainingSetBuilder:
    """Builds JSON training sets from TSV data."""
    
    def build(self, records: list[TSVRecord]) -> dict[str, object]:
        """Build the final training set structure."""
        return [record.to_dict() for record in records]
    
    def to_json(self, data: list[dict]) -> str:
        """Convert data to JSON string."""
        return json.dumps(data, ensure_ascii=False, indent=2)


class TrainingSetCLI:
    """Command-line interface for training set builder."""
    
    def __init__(self):
        self.builder = TrainingSetBuilder()
    
    def run(self) -> int:
        """Main entry point for CLI execution."""
        try:
            stream = sys.stdin
            
            reader = TSVReader(stream)
            records = reader.read_records()
            
            data = self.builder.build(records)
            print(self.builder.to_json(data))
            
            return 0
        except (ValueError, FileNotFoundError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            print("Usage: python3 get-training-set.py < input.tsv", file=sys.stderr)
            return 2


if __name__ == "__main__":
    cli = TrainingSetCLI()
    raise SystemExit(cli.run())