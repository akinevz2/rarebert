# Maintain Functionality Skill

## Purpose
Ensures the scripts/memo.mjs module maintains its operational integrity through memo tracking. The main function follows a sequential dispatch pattern based on argument parsing.

## Sequential Flow in main():
1. Parse flags (args starting with '-') and non-flags
2. Initialize boolean flags for each operation mode
3. Execute early-return operations:
   - `isAll` → print all memos flat, then return
   - `isAdd` → add memo to module, then return
   - `isDrop` → drop selected memos, clear buffer, return
   - `isCommit` → snapshot to git notes, clear buffer, return
   - `isLog` → show history, clear buffer, return
   - `isRestore` → restore from ref, clear buffer, return
   - `isFresh` → snapshot + clear all, clear buffer, return
4. `isBare` or default → run interactive TUI via bare() function

## Operations Exposed:
- **bare(args)** - Default mode with TUI for common actions
  - Shows memos if present (via printGroupedMemos)
  - Presents menu: add, commit, fresh, exit
  
- **dropMemos(moduleArg)** - Interactive memo removal
  - Uses multiSelectMemos() helper

## Meta Information (imported but operation-level):
- cli.input() for prompts
- cli.select() for TUI menus
- cli.fail(), cli.nonInteractive(), cli.onAbort()