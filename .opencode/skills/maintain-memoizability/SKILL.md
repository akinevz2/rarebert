# Maintain Memoizability Skill

## Purpose
Ensures modules can receive memos for tracking context across operations. A module is "memoizable" if:
1. It exists in the module registry (tracked by lib/modules.mjs)
2. Has a corresponding `.<module-name>.` file for memo storage
3. Can accept `remember()` calls to store contextual information

## Operations Exposed by scripts/memo.mjs
- **addMemo(moduleArg, memoContentArg)** - Adds memo to specified module
  - Uses `memo.remember(target.path, memoContent)` to persist
  - Interactive or non-interactive modes

## Key Memo Methods Used:
- `memo.remember(path, content)` - Store memo for a module
- `memo.loadMemos(moduleRef)` - Load memos from file
- `memo.loadMemoWithTimestamps()` - Load with timestamps for sorting
- `memo.clearBuffer()` - Clear the in-memory buffer

## Operations to Memoize:
The `--add` operation allows users to memoize any module with contextual notes.