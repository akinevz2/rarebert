# Module Exit Analysis Summary

## All Memos Found in Project

### Script Modules with Memories (via sidecar files `<module>.mjs.`)
1. **scripts/add.mjs** - TUI-conversion task
2. **scripts/article.mjs** - TUI-conversion task  
3. **scripts/commit.mjs** - TUI-conversion and interactive wizard
4. **scripts/implement.mjs** - TUI-conversion for REPL-style interactions
5. **scripts/languages.mjs** - cli.fail() usage issue ✓ ADDED MEMO (2026-08-14)
6. **scripts/onboard.mjs** - TUI-conversion task
7. **scripts/open.mjs** - TUI-conversion for opencode TUI launch
8. **scripts/present.mjs** - TUI-conversion for slides
9. **scripts/status.mjs** - Reference implementation using TUI class
10. **scripts/trail.mjs** - TUI-conversion with custom keybinding

### Lib Modules with Memories  
11. **lib/article.mjs** - Module documentation + imports info
12. **lib/backend.mjs** - Unused import warnings
13. **lib/languages-helpers.mjs** - ✓ ADDED MEMO: needs refacter into scripts/languages.mjs (2026-08-14)
14. **lib/module.mjs** - CLI-related exit methods refactoring TODO
15. **lib/update.mjs** - Unused import warning

### New Memos Added (2026-08-14):
- **scripts/languages.mjs** - cli.fail() issue documented
- **scripts/list.mjs** - missing return exit() at end
- **scripts/memo.mjs** - multiple missing exits
- **scripts/refactor.mjs** - switch statement no return
- **scripts/reload.mjs** - silent exit
- **scripts/upgrades.mjs** - silent exit  
- **index.js** - multiple memos including: exit handling issues, opencode prompt for template onboarding, move support-template.json location request

## Modules NOT Returning exit() at End of Execution

### Problem Classification:

| Module | Issue Type | Lines | Fix Required |
|--------|-----------|-------|--------------|
| **scripts/languages.mjs** | Uses `cli.fail()` | 24-25 | Replace with `return exit(1)` |
| **scripts/project.mjs** | Uses `cli.fail()` | ~24 | Replace with `return exit(1)` |
| **scripts/list.mjs** | No exit call | 20-23 | Add `return exit(0)` at end |
| **scripts/memo.mjs** | Multiple missing exits | Various | Add explicit `exit()` returns |
| **scripts/refactor.mjs** | Switch statement no return | End of file | Add returns after cases |
| **scripts/reload.mjs** | Silent exit | Lines 16-34 | Add `return exit(0)` at end |
| **scripts/upgrades.mjs** | Silent exit | End of file | Add `return exit(0)` at end |

### Detailed Issues:

#### scripts/languages.mjs (line 25)
```javascript
// WRONG - calls process.exit directly, bypasses CLI wrapper
cli.fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);

// CORRECT - lets CLI wrapper handle exit properly  
return exit(1);
```

#### scripts/project.mjs (line 25)
Same issue as languages.mjs.

#### scripts/list.mjs (lines 20-23)
Missing explicit return at end of main(). Currently returns `undefined`.

#### scripts/memo.mjs (entire function)
All early returns and final path don't use exit() helper. Multiple implicit undefined returns.

#### scripts/refactor.mjs (end of file)
Switch statement uses `break` without returning value from main callback.

#### scripts/reload.mjs & upgrades.mjs  
Functions print output then implicitly return with no exit code.

## Why This Matters

When modules don't use the proper `exit()` pattern:
1. Signal handlers (registered via `installSignalHandlers()`) may not run
2. Cleanup callbacks (memo flushing, etc.) are skipped  
3. The CLI wrapper doesn't know success vs failure
4. Exit codes to parent processes are incorrect

## Additional Tasks Identified

### 1. Refactor languages-helpers.mjs into languages.mjs
**Status:** Documented in sidecar file at `lib/languages-helpers.mjs.`  
**Problem:** lib/languages-helpers.mjs exports UI functions that duplicate scripts/languages.mjs functionality. Need to consolidate into proper CLI module or merge.

### 2. Opencode Template Onboarding Prompt
**Location:** index.js memo (via sidecar)  
**When triggered:** External project uses file extension not matching built-in templates (.js, .mjs, .py)  
**Action:** Invoke opencode with instruction to generate custom language support module template

### 3. Move support-template.json
**Current location:** `lib/support-template.json` (sibling to languages.mjs)  
**Target location:** `lib/supports/support-template.json`  
**Files affected:** lib/update.mjs (line 11-14: SUPPORT_TEMPLATE_PATH constant), potentially others referencing the template