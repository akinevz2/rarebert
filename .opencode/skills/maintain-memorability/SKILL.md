# Maintain Memorability Skill

## Purpose
Instructs agents how to preserve file knowledge through memos before making modifications. The rarebert system uses side-car memo files (`.module-name.` suffix) to track context across operations.

## Before Overwriting Any Script File

1. **Read the entire file** - understand its API, exports, and purpose
2. **Memoize key operations** using:
   ```bash
   node index.js memo --add <relative-path> "<operation docs>"
   ```

3. Or programmatically:
   ```javascript
   import { memo } from './lib/memo.mjs';
   await memo.remember('path/to/file.mjs', 'Operations: func1(), func2() dispatches to handlerA/handlerB');
   ```

4. **Stage in git if memoizing fails** - the memo system writes sidecar files that may be gitignored

## Memo Format Template

For each file, document:
- Exported functions (name → purpose)
- Main dispatcher logic flow (arguments → what operations are checked)
- Key dependencies being imported/used

Example for scripts/memo.mjs:
```
main(args[]) - parses flags/non-flags -> dispatches to --all/--add/--drop/... or bare()
addMemo(moduleArg, content) - prompts module selection, memo.remember(path, content)  
bare(args) - prints memos + TUI menu (Add/Commit/Fresh/Exit)
```

## Supersession Tracking

After modifying a memoized file:
- Check the `.module-name.` sidecar for old notes
- Compare with new code to identify what changed
- Document any operations that are no longer present or behaviorally different