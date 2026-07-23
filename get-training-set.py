"""Build a JSON training set from propaganda TSV files."""

from __future__ import annotations

import csv
import json
import re
import signal
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Iterator, TextIO


# Suppress broken pipe errors (common when piping to commands that exit early)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)


@dataclass
class TSVRecord:
    """Represents a single training set record."""
    
    classification: str
    raw_data: str = ""
    span: str = ""
    clean: str = ""
    
    def __post_init__(self):
        """Clean and normalize fields after initialization."""
        self.classification = self.classification.strip()
        self.raw_data = self._normalize_spaces(self.raw_data)
        self.span = self._normalize_spaces(self.span) if self.span else ""
        self.clean = self._normalize_spaces(self.clean) if self.clean else ""
    
    @staticmethod
    def _normalize_spaces(text: str) -> str:
        """Collapse repeated whitespace into single spaces."""
        return re.sub(r"\s+", " ", text).strip()
    
    @classmethod
    def from_row(cls, row: List[str], index: int = 0) -> Optional['TSVRecord']:
        """Create a TSVRecord from a CSV row.
        
        Args:
            row: The parsed TSV row (list of strings)
            index: Row index for header detection
            
        Returns:
            TSVRecord if valid, None if empty or header row
        """
        if not row:
            return None
        
        # Skip header rows
        if index == 0 and row[0].strip().lower() in {"label", "class", "classification"}:
            return None
        
        classification = row[0].strip()
        raw_data = "\t".join(row[1:]).strip() if len(row) > 1 else ""
        
        span, clean = cls._extract_span_and_clean(raw_data)
        
        return cls(
            classification=classification,
            raw_data=raw_data,
            span=span,
            clean=clean
        )
    
    @classmethod
    def _extract_span_and_clean(cls, raw_data: str) -> tuple[str, str]:
        """Extract BOS/EOS span and clean marker-free text."""
        span_match = re.search(r"<BOS>\s*(.*?)\s*<EOS>", raw_data, flags=re.DOTALL)
        span = cls._normalize_spaces(span_match.group(1)) if span_match else ""
        clean = cls._normalize_spaces(raw_data.replace("<BOS>", "").replace("<EOS>", ""))
        return span, clean
    
    def to_dict(self) -> dict:
        """Convert record to dictionary format for JSON serialization."""
        return {
            "classification": self.classification,
            "raw_data": self.raw_data,
            "span": self.span,
            "clean": self.clean,
        }


class TSVReader:
    """Reads and parses TSV files or streams into training records."""
    
    def __init__(self):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    
    def read_from_file(self, file_path: Path) -> List[TSVRecord]:
        """Read TSV records from a file path.
        
        Args:
            file_path: Path to the TSV file
            
        Returns:
            List of TSVRecord objects
            
        Raises:
            FileNotFoundError: If file doesn't exist
        """
        if not file_path.exists():
            raise FileNotFoundError(f"file not found: {file_path}")
        
        records: List[TSVRecord] = []
        with file_path.open(newline="", encoding="utf-8") as handle:
            reader = csv.reader(handle, delimiter="\t")
            for index, row in enumerate(reader):
                record = TSVRecord.from_row(row, index)
                if record is not None:
                    records.append(record)
        
        return records
    
    def read_from_stream(self, stream: TextIO) -> List[TSVRecord]:
        """Read TSV records from a text stream (e.g., stdin).
        
        Args:
            stream: A file-like object with readable text
            
        Returns:
            List of TSVRecord objects
        """
        records: List[TSVRecord] = []
        reader = csv.reader(stream, delimiter="\t")
        
        for index, row in enumerate(reader):
            record = TSVRecord.from_row(row, index)
            if record is not None:
                records.append(record)
        
        return records


class TrainingSetBuilder:
    """Builds JSON training sets from TSV data."""
    
    def __init__(self):
        self.reader = TSVReader()
    
    def build_from_file(self, file_path: Path) -> List[dict]:
        """Build a training set from a TSV file.
        
        Args:
            file_path: Path to the TSV file
            
        Returns:
            List of dictionaries ready for JSON serialization
        """
        records = self.reader.read_from_file(file_path)
        return [record.to_dict() for record in records]
    
    def build_from_stream(self, stream: TextIO) -> List[dict]:
        """Build a training set from a text stream.
        
        Args:
            stream: A file-like object with readable text
            
        Returns:
            List of dictionaries ready for JSON serialization
        """
        records = self.reader.read_from_stream(stream)
        return [record.to_dict() for record in records]


class TrainingSetCLI:
    """Command-line interface for training set builder."""
    
    def __init__(self):
        pass
    
    def _has_stdin_input(self) -> bool:
        """Check if stdin has piped input available."""
        import select
        return select.select([sys.stdin], [], [], 0.0)[0] == [sys.stdin]
    
    def run(self, argv: Optional[List[str]] = None) -> int:
        """Main entry point for CLI execution.
        
        Args:
            argv: Command-line arguments (defaults to sys.argv[1:])
            
        Returns:
            Exit code (0 for success, non-zero for errors)
        """
        if argv is None:
            argv = sys.argv[1:]
        
        try:
            # Parse FILE argument from command line
            file_path = self._parse_file_arg(argv)
            
            builder = TrainingSetBuilder()
            payload: List[dict] = []
            
            if file_path:
                payload = builder.build_from_file(Path(file_path))
            else:
                # Check for stdin input
                if not self._has_stdin_input():
                    print("Error: No FILE argument provided and no stdin input available", 
                          file=sys.stderr)
                    print("Usage: python3 get-training-set.py FILE=<path/to.tsv>", 
                          file=sys.stderr)
                    print("Or pipe TSV data via stdin for pipeline usage", file=sys.stderr)
                    return 2
                
                payload = builder.build_from_stream(sys.stdin)
            
            # Output as formatted JSON
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0
            
        except (ValueError, FileNotFoundError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            print("Usage: python3 get-training-set.py FILE=<path/to.tsv>", file=sys.stderr)
            return 2
        except Exception as exc:
            print(f"Unexpected error: {exc}", file=sys.stderr)
            return 1
    
    @staticmethod
    def _parse_file_arg(argv: List[str]) -> Optional[str]:
        """Parse FILE=VALUE argument from argv list.
        
        Args:
            argv: List of command-line arguments
            
        Returns:
            File path string if found, None otherwise
        """
        for arg in argv or []:
            if arg.startswith("FILE="):
                return arg.split("=", 1)[1]
        return None


if __name__ == "__main__":
    cli = TrainingSetCLI()
    raise SystemExit(cli.run())
