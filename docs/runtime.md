# Runtime

**Location:** `lib/core.mjs`

**Role:** The Runtime class is the core execution orchestrator for rarebert modules. It replaces the former single-shot `executeAndExit` pattern with a recursive loop that re-executes Module instances until an `ExitSignal` is resolved. It sits at the heart of the exit chain: `index.js` → `runModule()` → `Runtime.execute()` → `Module.execute()` → user `main()` callback → `return exit(code)` → `Module.exit(result)` → `Runtime` handles the loop and display.

---

## Class Signature

```js
new Runtime(module);
```

| Parameter | Type     | Description                    |
| --------- | -------- | ------------------------------ |
| `module`  | `Module` | The Module instance to execute |

```js
async execute(args = [])
```

**Executes the module and manages the exit signal loop.**

**Returns:** `number` — the final exit code.

---

## JSDoc

```js
/**
 * Runtime orchestrates the recursive execution loop for a Module.
 *
 * The execution model follows a `for (;;)` loop:
 *   1. Call `this.module.execute(args)` to run the module's main callback
 *   2. Call `result.complete()` to resolve any `onExit` hooks
 *   3. If `completed.execute` is a function, re-assign `this.module = completed`
 *      and continue the loop (re-execute the submodule with fresh args)
 *   4. Otherwise, display `producedValue` via `console.dir()` (exit 0) or
 *      `console.error()` (non-zero exit code)
 *   5. Return the final `exitCode`
 *
 * This loop continues until a module return produces no submodule trigger,
 * at which point the exit code and produced value are finalized.
 */
```

---

## Execution Model

The recursive execution loop:

```pseudo
for (;;) {
  const result = await this.module.execute(args);
  const completed = await result.complete();
  if (completed && typeof completed.execute === 'function') {
    this.module = completed;   // re-execute submodule
    args = [];
    continue;
  }
  const { exitCode, producedValue } = completed;
  if (producedValue !== undefined && producedValue !== null) {
    if (exitCode === 0) {
      console.dir(producedValue);
    } else {
      console.error(producedValue);
    }
  }
  return exitCode;
}
```

**Flow diagram (text form):**

```
       enter Runtime.execute(args)
              |
              v
       -----------------
       |   execute()   |----------> runs Module.main(callback)(args)
       -----------------
              |
              v
       -----------------
       |  complete()   |---> resolves onExit(callback)
       -----------------
              |
       if has execute(fn)  ------------------- yes
              |                                |
              v                                v
      this.module = completed           display producedValue
              |                                |
              |           exitCode 0 → console.dir
              |           exitCode ≠ 0 → console.error
              |                                |
              +---------- return exitCode -----+
                                             |
                                             v
                                   process.exit(exitCode)
```

---

## ExitSignal Contract

`exit()` maps to `ExitSignal(exitCode, producedValue, onExit)` via the standalone `exit()` function in `lib/core.mjs:99`:

| `exit()` arguments          | → `ExitSignal` fields                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `exit(code)`                | `exitCode = code, producedValue = undefined, onExit = undefined`     |
| `exit(code, onExit)`        | `exitCode = code, producedValue = undefined, onExit = onExit`        |
| `exit(code, producedValue)` | `exitCode = code, producedValue = producedValue, onExit = undefined` |
| `exit(undefined)`           | `exitCode = 0, producedValue = undefined, onExit = undefined`        |
| `exit(string)`              | `exitCode = 1, producedValue = string, onExit = undefined`           |
| `exit(number, onExitFn)`    | `exitCode = number, producedValue = undefined, onExit = onExitFn`    |

`ExitSignal.complete()`:

- If `onExit` is a function, calls `onExit(producedValue)`
- If the callback returns an object with an `execute` property (a submodule), returns that object
- Otherwise returns `{ exitCode, producedValue }`

---

## ProducedValue Display Rules

Within `Runtime.execute()` (and `Module.exit()`):

| Condition                                             | Display method                 |
| ----------------------------------------------------- | ------------------------------ |
| `exitCode === 0` AND `producedValue` exists           | `console.dir(producedValue)`   |
| `exitCode !== 0` OR `producedValue` is null/undefined | `console.error(producedValue)` |
| `producedValue` is `undefined`/`null`                 | nothing displayed              |

The rule of thumb: **exit 0 → dir; non-zero → error**.

---

## Submodule Escalation

When a module's `main` callback does `return exit(0, new TUI(...))` or `return exit(0, new CLI(...))`:

1. `Module.exit(result)` receives the `ExitSignal`
2. `result.complete()` runs the `onExit` callback, which returns a Module instance
3. `completed.execute` is a function → `this.module = completed` in `Runtime.execute()`
4. The loop re-executes with the new submodule, resetting `args = []`
5. This is the **elevation pattern** — designing for CLI first, then elevating to TUI (or another Module) at runtime

---

## Module Integration

### `Module.exit(result)`

In `lib/module.mjs:106`, `exit(result)` is a thin wrapper that:

1. Validates `result` is an `ExitSignal` instance
2. Calls `result.complete()` to resolve `onExit` hooks
3. If `completed.execute` is a function, returns the Module instance (triggers re-execution in Runtime)
4. Otherwise displays `producedValue` and returns `exitCode`

### `Module.executeAndExit(args)`

The former single-shot pattern (documented in KNOWN_ISSUES.md§1):

```js
async executeAndExit(args = []) {
  const result = await this.execute(args);
  const code = await this.handleResult(result, args);
  this.terminate(code);
}
```

**Runtime replaces this** by providing the loop natively — no separate `handleResult`/`terminate` calls needed.

### `index.js runModule(ref, args)`

In `index.js:42`, `runModule()`:

1. Discovers and resolves the module by name/path
2. Imports the module's default export (must be a `Module` instance)
3. Creates `new Runtime(exported)`
4. Returns `exit(await runtime.execute(args))`

### `index.js supportsDirectRunning()`

When a module is run directly via `node scripts/foo.mjs`:

- `Module.supportsDirectRunning(metaUrl)` wires signal handlers and calls `Runtime.execute(process.argv.slice(2))`

---

## Entry Points

### `index.js runModule(ref, args)`

```js
async function runModule(ref, args = []) {
    // ... resolve module ...
    const mod = await import('file://' + home.absPath(script.path));
    const exported = mod.default;
    const runtime = new Runtime(exported);
    return exit(await runtime.execute(args));
}
```

### `index.js main(opts, positional)`

```js
return exit(await runModule(cmd, rest));
```

### Direct execution `node scripts/foo.mjs`

```js
// Module default export supplies .supportsDirectRunning(import.meta.url)
export default new CLI('foo.mjs', main, meta).supportsDirectRunning(import.meta.url);
```

When run directly, `supportsDirectRunning` sets up SIGINT/SIGHUP/SIGTERM handlers via `cli.installSignalHandlers()` and calls `Runtime.execute(process.argv.slice(2))`.

---

## Minimal Working Example

```js
// scripts/hello.mjs
import { Module, exit, Runtime } from '../lib/core.mjs';

async function main(opts, positional) {
    console.log('Hello, world!');
    return exit(0);
}

export default new Module('hello.mjs', main);
```

Running `node index.js hello` triggers:

1. `index.js` resolves `hello.mjs`, imports it, gets the `Module` default export
2. Creates `new Runtime(module)`
3. `Runtime.execute([])` loops: calls `module.execute([])` → `main()` → `return exit(0)`
4. `result.complete()` → `{ exitCode: 0, producedValue: undefined }`
5. No `execute` function on completed → display rules: `producedValue` is undefined → nothing displayed
6. Return `exitCode` (0)
7. `exit(0)` → `new ExitSignal(0, undefined)` → `process.exit(0)`

```

```
