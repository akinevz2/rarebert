"""Data loader for propaganda detection datasets."""

import os
import sys
import argparse
import csv
import signal
from typing import List, Tuple, Optional

provided_columns = ['label', 'tagged_in_context']

# Positional ANSI palette; slot N is assigned to the Nth label discovered in
# the TSV at runtime.  No literal label names live in source.
_ANSI_PALETTE: tuple[str, ...] = (
    '\033[0m',   # 0: default
    '\033[31m',  # 1
    '\033[32m',  # 2
    '\033[33m',  # 3
    '\033[34m',  # 4
    '\033[35m',  # 5
    '\033[36m',  # 6
    '\033[91m',  # 7
    '\033[92m',  # 8
    '\033[93m',  # 9
)

_RESET = '\033[0m'


class ColorScheme:
    """ANSI color codes for different label types.

    Labels are mapped to palette slots lazily as they are encountered in
    the input stream; the mapping is opaque (positional) so no label
    names appear in this source file.
    """

    _slot_by_label: dict[str, int] = {}

    @classmethod
    def apply_color(cls, label: str) -> str:
        """Apply ANSI color to a label if it's a known type."""
        slot = cls._slot_by_label.get(label)
        if slot is None:
            slot = len(cls._slot_by_label) % len(_ANSI_PALETTE)
            cls._slot_by_label[label] = slot
        return f"{_ANSI_PALETTE[slot]}{label}{_RESET}"


class DataRecord:
    """Represents a single data record with label and text."""
    
    def __init__(self, label: str, tagged_in_context: str):
        self.label = label.strip()
        self.tagged_in_context = tagged_in_context.strip()
    
    @property
    def colored_label(self) -> str:
        """Return the color-coded label."""
        return ColorScheme.apply_color(self.label)
    
    def __str__(self) -> str:
        """Format as tab-separated output for piping."""
        return f"{self.colored_label}\t{self.tagged_in_context}"


class TSVLoader:
    """Handles loading and parsing of TSV files."""
    
    REQUIRED_COLUMNS = {'label', 'tagged_in_context'}
    
    def __init__(self, file_path: str):
        self.file_path = file_path
    
    def load(self) -> List[DataRecord]:
        """Load all records from the TSV file."""
        data: List[DataRecord] = []
        
        with open(self.file_path, 'r', encoding='utf-8') as f:
            reader = csv.reader(f, delimiter='\t')
            header = self._read_header(reader)
            col_indices = self._find_column_indices(header)
            
            for row in reader:
                record = self._parse_row(row, col_indices)
                if record:
                    data.append(record)
        
        return data
    
    def _read_header(self, reader) -> List[str]:
        """Read and return the header row."""
        try:
            return next(reader)
        except StopIteration:
            raise ValueError("TSV file is empty or missing header")
    
    def _find_column_indices(self, header: List[str]) -> dict:
        """Find indices of required columns in the header."""
        col_idx = {}
        for i, col in enumerate(header):
            col_name = col.strip().lower()
            if col_name in provided_columns:
                col_idx[col_name] = i
            else:
                raise ValueError(f"Unexpected column {col_name}")
        
        print(f"debug: {self.REQUIRED_COLUMNS=}, {col_idx.keys()=}")
        missing = self.REQUIRED_COLUMNS - set(col_idx.keys())
        if missing:
            raise ValueError(f"Required columns {missing} not found in TSV")
        
        return col_idx
    
    def _parse_row(self, row: List[str], col_indices: dict) -> Optional[DataRecord]:
        """Parse a single row into a DataRecord."""
        max_idx = max(col_indices['label'], col_indices['tagged_in_context'])
        if len(row) <= max_idx:
            return None
        
        label = row[col_indices['label']].strip()
        tagged_in_context = row[col_indices['tagged_in_context']].strip()
        return DataRecord(label, tagged_in_context)


class DataLoader:
    """Main class for loading and outputting propaganda datasets."""
    
    TRAIN_DATASET = 'propaganda_dataset_v2/propaganda_train.tsv'
    VAL_DATASET = 'propaganda_dataset_v2/propaganda_val.tsv'
    
    def __init__(self, training: bool = False):
        self.training = training
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    
    @classmethod
    def from_args(cls, args: argparse.Namespace) -> 'DataLoader':
        """Create DataLoader instance from command-line arguments."""
        if args.training:
            return cls(training=True)
        elif hasattr(args, 'val') and args.val:
            return cls(training=False)
        
        # Check environment variable as fallback
        training_flag = os.environ.get('TRAINING', '').lower()
        return cls(training=(training_flag == 'true'))
    
    @property
    def dataset_path(self) -> str:
        """Return the path to the appropriate dataset file."""
        return self.TRAIN_DATASET if self.training else self.VAL_DATASET
    
    def run(self) -> int:
        """Load and output data, returning exit code."""
        if not os.path.exists(self.dataset_path):
            print(f"Error: Dataset file {self.dataset_path} not found", file=sys.stderr)
            return 1
        
        try:
            loader = TSVLoader(self.dataset_path)
            records = loader.load()
            
            for record in records:
                print(record)
            
            return 0
        except Exception as e:
            print(f"Error loading data: {e}", file=sys.stderr)
            return 1


class DataLoaderCLI:
    """Command-line interface for the data loader."""
    
    def __init__(self):
        self.parser = argparse.ArgumentParser(
            description='Load propaganda detection dataset'
        )
        self.parser.add_argument('--training', action='store_true', help='Load training data')
        self.parser.add_argument('--val', action='store_true', help='Load validation data')
    
    def run(self) -> int:
        """Parse arguments and execute the loader."""
        args = self.parser.parse_args()
        loader = DataLoader.from_args(args)
        return loader.run()


def mark_as_pipeline_middleware() -> bool:
    """Mark this script as a pipeline middleware component.

    Returns True when stdin has piped input available, enabling the script
    to participate in Unix-style pipelines. When called without piped input,
    returns False indicating standalone execution mode.

    This function helps scripts distinguish between direct invocation and
    pipeline usage, allowing graceful handling of both scenarios.

    Returns:
        True if data is being piped via stdin, False otherwise.
    """
    import select
    return bool(select.select([sys.stdin], [], [], 0.0)[0])


if __name__ == "__main__":
    cli = DataLoaderCLI()
    sys.exit(cli.run())
