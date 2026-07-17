"""Data loader for propaganda detection datasets."""

import os
import sys
import argparse
import csv
import signal
from typing import List, Tuple, Dict, Any

# Suppress broken pipe errors
signal.signal(signal.SIGPIPE, signal.SIG_DFL)

# ANSI color codes
COLORS = {
    'not_propaganda': '\033[0m',      # White (no color)
    'flag_waving': '\033[31m',        # Red
    'loaded_language': '\033[32m',    # Green
    'name_calling': '\033[33m',       # Yellow
    'doubt': '\033[34m',             # Blue
    'appeal_to_fear_prejudice': '\033[35m',  # Magenta
    'causal_oversimplification': '\033[36m', # Cyan
    'repetition': '\033[91m',        # Light Red
    'exaggeration': '\033[92m',      # Light Green
    'minimisation': '\033[93m',      # Light Yellow
}

RESET_COLOR = '\033[0m'

def load_tsv_data(file_path: str) -> List[Tuple[str, str]]:
    """Load data from TSV file with label and tagged_in_context columns."""
    data = []
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            reader = csv.reader(f, delimiter='\t')
            # Read header
            header = next(reader)
            
            # Find column indices
            label_idx = None
            tagged_idx = None
            
            for i, col in enumerate(header):
                if col.strip() == 'label':
                    label_idx = i
                elif col.strip() == 'tagged_in_context':
                    tagged_idx = i
            
            if label_idx is None or tagged_idx is None:
                raise ValueError("Required columns 'label' and 'tagged_in_context' not found in TSV")
            
            # Read data rows
            for row in reader:
                if len(row) > max(label_idx, tagged_idx):
                    label = row[label_idx].strip()
                    tagged_text = row[tagged_idx].strip()
                    data.append((label, tagged_text))
    except Exception as e:
        print(f"Error loading TSV file {file_path}: {e}", file=sys.stderr)
        raise
    
    return data


def main() -> int:
    """Load training or validation data based on TRAINING flag."""
    parser = argparse.ArgumentParser(description='Load propaganda detection dataset')
    parser.add_argument('--training', action='store_true', help='Load training data')
    parser.add_argument('--val', action='store_true', help='Load validation data')
    
    args = parser.parse_args()
    
    # Determine which dataset to load
    if args.training:
        dataset_path = 'propaganda_dataset_v2/propaganda_train.tsv'
    elif args.val:
        dataset_path = 'propaganda_dataset_v2/propaganda_val.tsv'
    else:
        # Check environment variable as fallback
        training_flag = os.environ.get('TRAINING', '').lower()
        if training_flag == 'true':
            dataset_path = 'propaganda_dataset_v2/propaganda_train.tsv'
        else:
            dataset_path = 'propaganda_dataset_v2/propaganda_val.tsv'
    
    # Validate dataset path
    if not os.path.exists(dataset_path):
        print(f"Error: Dataset file {dataset_path} not found", file=sys.stderr)
        return 1
    
    try:
        data = load_tsv_data(dataset_path)
        
        # Output data with color coding (label<TAB>text) for piping
        for label, text in data:
            # Apply color to label if it's a known propaganda type
            if label in COLORS:
                colored_label = f"{COLORS[label]}{label}{RESET_COLOR}"
            else:
                colored_label = label
            
            print(f"{colored_label}\t{text}")
            
        return 0
    except Exception as e:
        print(f"Error loading data: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
