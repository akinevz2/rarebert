# Modules Without Proper Exit Handling

## Analysis Date
2026-08-14

## Summary
After analyzing all scripts/ modules, several fail to properly handle module exit through the `exit()` helper function. This breaks consistency with the rarebert CLI framework and may skip cleanup handlers registered via signal handling and memo flushing.

## The Problem
The `CLI` class's `_wrap` method expects main callbacks to return values that will be passed to `Module.exit()`. When a module:
1. Uses `cli.fail()` or `die()` directly - these call `process.exit()` immediately, short-circuiting the normal flow
2. Returns implicitly (undefined) without an explicit exit code
3. Has control flow that doesn't reach any return statement

...the signal handlers registered via `installSignalHandlers()` and cleanup callbacks won't run properly.

## Modules NEEDING FIXES

### 1. scripts/languages.mjs - Uses cli.fail()
**Line:** ~25  
**Problem:** Calls `cli.fail(...)` which triggers immediate process.exit(1) inside `_SharedCLI.die()`, bypassing the Module's exit mechanism entirely.

```javascript
// CURRENT (wrong):
cli.fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);

// SHOULD BE:
return exit(1, () => console.error(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`));
```

### 2. scripts/project.mjs - Uses cli.fail() 
**Line:** ~24  
**Problem:** Same issue as languages.mjs.

### 3. scripts/list.mjs - No exit() call at all
**Lines:** 20-23  
**Problem:** Main function returns after awaiting `listModules(args)` but never calls `exit()`. The CLI wrapper receives undefined and doesn't know if it's success or failure.

```javascript
// CURRENT:
export default new CLI('list.mjs', async (opts, positional) => {
    const args = Array.isArray(positional) ? positional : [];
    await listModules(args);  // No return!
}, meta).supportsDirectRunning(import.meta.url);

// SHOULD ADD:
await listModules(args);
return exit(0);
```

### 4. scripts/memo.mjs - Missing final exit()  
**Lines:** Multiple returns without exit()  
**Problem:** The `main()` function has multiple early returns with no return value, and the default path (lines 75-84) falls through to implicit undefined return.

```javascript
// CURRENT: Missing return at end
if (nonFlag.length === 0) {
    cmdPrintAll(true);
} else {
    const resolved = resolveModuleSet(nonFlag, modules);
    if (resolved.length === 0) {
        console.error(`No modules matched: ${nonFlag.join(', ')}`);
        return;  // Returns undefined!
    }
    cmdPrintSet(resolved, true);  // Falls through to implicit undefined
}

// SHOULD ADD AT EACH EXIT POINT or at end:
if (resolved.length === 0) {
    console.error(`No modules matched...`);
    return exit(1);
}
cmdPrintSet(resolved, true);
return exit(0);
```

### 5. scripts/refactor.mjs - Switch statement no exit()  
**Lines:** End of file  
**Problem:** The switch statement has `break` statements that don't return a value from main(). Falls through to implicit undefined.

The `runInteractive`, `detectDamage`, and other subcommands may have issues too, but the wrapper pattern needs fixing.

### 6. scripts/reload.mjs - No exit() at end
**Lines:** End of function (lines 16-34)  
**Problem:** Function prints output then implicitly returns undefined after calling `refreshMakefile()`.

```javascript
// CURRENT:
console.log(`done: ${result.scriptCount} module(s)`);
}, meta).supportsDirectRunning(import.meta.url);

// SHOULD ADD:
return exit(0);
```

### 7. scripts/upgrades.mjs - No exit() call
**Lines:** End of file  
**Problem:** Calls `printSummary()` at end with no return statement.

```javascript
const buckets = categorize(rows);
const inventory = inventoryAddedModules(buckets.added, git.root);
printSummary(buckets, inventory, base);  // No return!
}, meta).supportsDirectRunning(import.meta.url);
```

### 8. scripts/symbols.mjs - Not a script module (skip)
This file only exports constants but is counted since it matches the pattern. It's not a CLI module - just a symbol definitions file. Exempt.

## Pattern to Follow

Most modules follow this pattern:

```javascript
async function main(opts, positional) {
    // ... logic ...
    
    if (errorCondition) return exit(1);
    
    // success path
    
    return exit(0);  // <-- ALWAYS REQUIRED at end or each early return
}

export default new CLI('module.mjs', main, meta).supportsDirectRunning(import.meta.url);
```

Or with cli.ok() for simple cases:
```javascript
if (success) {
    cli.ok(message);  // This calls process.exit() internally! DON'T use this pattern in main
}
// BETTER:
return exit(0, () => console.log(message));
```