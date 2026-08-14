# Memo Module Refactoring Plan

## Current State
The `lib/memo.mjs` file manages memo sidecar files (`.`) for tracking important notes about modules. The key method is `snapshot()` which creates git notes containing memo data.

## Problem with Current Format
When running `memo --commit`, the current format stores:
```
path/to/module1.mjs, path/to/module2.mjs

[full JSON array of memo entries]
```

The issue: **git notes list/subject is verbose** - it shows all paths in git history, making diff uninformative.

## Proposed Solution
Change to a clean meta-object format that stores richer metadata for easier diffing:

### New Snapshot Format
```
2 memos cached

{
  "version": 1,
  "label": "...",
  "timestamp": 1750000000000,
  "count": 2,
  "modules": [
    { "path": "...", "name": "...", "memos": [...], "lastModified": ... },
    ...
  ]
}
```

### Benefits
1. **Subject line is clean**: `N memos cached` instead of list of paths
2. **Diff-friendly**: JSON format with version/timestamp allows meaningful diffs between commits
3. **Structured data**: Contains all info needed for restore/diff operations
4. **Backward compatible**: Can parse old formats alongside new

### Files to Modify

#### lib/memo.mjs (~1200 lines)
Key methods:
- `snapshot()` (line ~412): Change output format - DONE
- `showSnapshot()` (line ~430): Handle new JSON structure with modules/timestamp fields
- `logEntries()` (line ~483): Parse subject from note header instead of comma-splitting
- Add helper: `_parseMemoData(data)` to extract entries from new meta-object format

#### lib/trail.mjs (~165 lines)  
Key function:
- `commitMemos(sha)`: Needs updating to handle new memo format alongside existing formats

### Implementation Approach
Need to make all changes at once to keep file structure intact, then run syntax check.