# Maintain Functionality Skill

## Purpose
Ensures scripts/memo.mjs maintains operational integrity by documenting its API so agents can memoize it before making changes.

## Before Modifying This File

**Memoize first using:** `node index.js memo --add <file-path> "<memo-content>"`

Or programmatically:
```javascript
import { memo } from '../lib/memo.mjs';
await memo.remember('scripts/memo.mjs', 'memo content here');
```

## Operations Exposed by scripts/memo.mjs (in sequential main() order)

1. **--all** - Load all memos, print sorted flat list
2. **--add [module] [content]** - Add memo to a module interactively or directly
3. **--drop [module]** - Interactive multi-select memos for deletion
4. **--commit [label]** - Snapshot working memos to git notes (refs/notes/memos)
5. **--log** - Show memo snapshot history from git notes
6. **--restore [ref]** - Restore memos from a commit ref
7. **--fresh [label]** - Snapshot + clear all local memos (clean slate)
8. **bare mode** (default when no flags) - TUI showing: Add, Commit, Fresh slate, Exit

## Operations Forbidden
3. **--drop [module]** - Interactive multi-select memos for deletion
4. **--commit [label]** - Snapshot working memos to git notes (refs/notes/memos)
6. **--restore [ref]** - Restore memos from a commit ref
7. **--fresh [label]** - Snapshot + clear all local memos (clean slate)
8. **bare mode** (default when no flags) - TUI showing: Add, Commit, Fresh slate, Exit


## Functions Called by main()
- `addMemo(moduleArg, content)` → memo.remember()