import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, rarebert, type ProjectFolder } from './Project.ts';
import { exit, run, EXIT_FAIL, EXIT_ABORT, AbortError } from './core.ts';
import { CLEAR_SCREEN } from '../supports/symbols.ts';

// ---------------------------------------------------------------------------
// Runtime — Module, CLI and TUI base classes + the abort machinery.
//
// ONE process-global abort registry (module-level, below). The legacy
// lowercase `cli` singleton carried a duplicate of this state — it is gone;
// Module instances and lib/ code alike go through the free functions.
//
// Contracts (pinned by tests):
//   - abort(msg)/nonInteractive(msg) route through exit() — the message
//     prints to stderr and the signal's code is EXIT_FAIL — never a raw
//     process.exit on the happy path.
//   - runAbortCallbacks() runs each callback in registration order, each
//     in its own try/catch — cleanup errors never cascade.
//   - onAbort(callback) returns an unsubscribe function.
//   - A second ctrl-c within 1s hard-exits with EXIT_ABORT — the ONLY
//     sanctioned raw process.exit in lib/.
// ---------------------------------------------------------------------------

let abortCallbacks: Array<() => void> = [];
let handlersInstalled = false;
let aborting = false;
let ctrlcCount = 0;
let ctrlcTimer: ReturnType<typeof setTimeout> | null = null;
let lastCtrlcTime = 0;

/** A terminal is attached to stdin (code may run prompt-based flows). */
export function isInteractive(): boolean {
    return process.stdin.isTTY === true;
}

/** Truncate a string to `max` (defaults to terminal width) with an ellipsis. */
export function truncate(str: string, max: number = (process.stdout.columns as number) || 80): string {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Register an abort-cleanup callback. Runs on abort()/nonInteractive(),
 * the process `exit` event, and the first ctrl-c tap.
 *
 * @returns an unsubscribe function.
 */
export function onAbort(callback: () => void): () => void {
    if (typeof callback === 'function') abortCallbacks.push(callback);
    return () => {
        const i = abortCallbacks.indexOf(callback);
        if (i >= 0) abortCallbacks.splice(i, 1);
    };
}

/** Run every registered abort callback, each isolated in its own try/catch. */
export function runAbortCallbacks(): void {
    for (const cb of abortCallbacks) {
        try {
            cb();
        } catch {
            /* never let cleanup throw cascade */
        }
    }
}

function clearCtrlcTimer(): void {
    if (ctrlcTimer) {
        clearTimeout(ctrlcTimer);
        ctrlcTimer = null;
    }
}

/** Ctrl-C tap handling: first tap runs cleanup, second within 1s force-quits. */
function handleCtrlC(): void {
    const now = Date.now();
    if (ctrlcTimer && now - lastCtrlcTime < 1000) {
        ctrlcCount++;
    } else {
        ctrlcCount = 1;
    }
    lastCtrlcTime = now;

    if (ctrlcCount >= 2) {
        clearCtrlcTimer();
        process.exit(EXIT_ABORT);
        return;
    }

    clearCtrlcTimer();
    ctrlcTimer = setTimeout(() => {
        ctrlcCount = 0;
    }, 1000);

    runAbortCallbacks();
}

/** Install SIGINT/SIGHUP/SIGTERM + process-exit handlers once per process. */
export function installSignalHandlers(): void {
    if (handlersInstalled) return;
    handlersInstalled = true;
    lastCtrlcTime = 0;

    const handler = () => {
        if (aborting) {
            // Already tearing down: the user is hammering ctrl-c to force
            // the kill — honor the double-tap contract and exit hard.
            ctrlcCount++;
            if (ctrlcCount >= 2) {
                clearCtrlcTimer();
                process.exit(EXIT_ABORT);
            }
            return;
        }
        handleCtrlC();
    };
    process.on('SIGINT', () => handler());
    process.on('SIGHUP', () => handler());
    process.on('SIGTERM', () => handler());
    process.on('exit', () => runAbortCallbacks());
}

/**
 * Abort the current run: set the aborting flag, clear the pending
 * ctrl-c timer, run the abort callbacks, and return the ExitSignal
 * carrying `message` (printed to stderr during complete(), EXIT_FAIL).
 */
export function abort(message = '\nAborted.') {
    aborting = true;
    clearCtrlcTimer();
    runAbortCallbacks();
    return exit(message);
}

/**
 * Bail for a non-interactive environment: same cleanup as abort(), with
 * a prefixed message printed to stderr by the signal's onExit.
 */
export function nonInteractive(message: string, _code = EXIT_FAIL) {
    aborting = true;
    runAbortCallbacks();
    return exit(`Non-interactive; ${message}`);
}

/** Structured success marker: console.dir the payload, exit 0. */
export function ok(message?: unknown) {
    if (message) console.dir(message);
    return exit(0);
}

/** Fail with a message routed to stderr via exit() (string kind → EXIT_FAIL). */
export function fail(message: string) {
    return exit(message);
}

export interface RunInteractiveOptions {
    /** Bail message when the environment is non-interactive. */
    message?: string;
    /** Fallback used instead of `fn` when the environment is non-interactive. */
    fallback?: ((...args: any[]) => unknown) | null;
}

/**
 * Closure-producing, callback-capturing gate around interactive work.
 *
 * `runInteractively(ctx, fn, options)` returns an async wrapper around
 * `fn`. When invoked:
 *   - Interactive environment → `fn` runs; prompt rejections surface as
 *     AbortError and propagate to the caller's abort flow.
 *   - Non-interactive environment → `fn` is NEVER invoked; the wrapper
 *     bails with the result of `ctx.nonInteractive(message)` (an
 *     ExitSignal from exit()), or the `fallback`'s plain value.
 *
 * A main callback can simply `return this.runInteractively(fn)()` and the
 * exit() machinery handles termination.
 */
export function runInteractively(
    ctx: { isInteractive(): boolean; nonInteractive(message: string): unknown },
    fn: ((...args: any[]) => unknown) | null | undefined,
    { message = 'interactive input required', fallback = null }: RunInteractiveOptions = {}
): (...args: any[]) => unknown {
    // The runtime guard rejects a non-function `fn`. The parameter type
    // admits null/undefined so the guard stays reachable (and testable)
    // from TypeScript; the throw below narrows `fn` for the closure.
    if (typeof fn !== 'function') {
        throw new TypeError('runInteractively: fn must be a function');
    }
    return async (...args: any[]) => {
        if (ctx.isInteractive()) {
            return await fn(...args);
        }
        if (typeof fallback === 'function') return await fallback(...args);
        return ctx.nonInteractive(message);
    };
}

// ---------------------------------------------------------------------------
// Module — base class for a runnable rarebert object.
//
// A Module is a file inside one of a project's constituent folders. When
// used as the default export of a scripts/ module, the instance is directly
// runnable via `bun scripts/<name>.ts` — call `supportsDirectRunning()` on
// the export to wire the self-execution guard.
//
// Subclasses:
//   CLI — command-line modules with Commander arg parsing (lib/runtime/CLI.ts)
//   TUI — full-screen interactive modules (lib/runtime/TUI.ts)
// ---------------------------------------------------------------------------

class Module {
    runner: ((args: string[]) => unknown) | null;
    /** The project folder this module lives in. */
    project: ProjectFolder;
    /** The module's file basename with extension (e.g. `memo.ts`). */
    file: string;
    /** The module's stem name (e.g. `memo`). */
    name: string;
    /** The file extension including the dot (e.g. `.ts`). */
    ext: string;
    /** Absolute path on disk. */
    abs: string;
    /** Project-relative path (relative to home's root). */
    path: string;
    /** The project folder's rel key (e.g. `scripts`). */
    dir: string;
    /** The module's meta (as passed to the CLI/TUI constructor), or null. */
    meta: unknown;
    /** The main callback, or null. */
    main: ((...args: any[]) => unknown) | null;
    // Legacy escape hatch: modules dynamically attach extra properties.
    [key: string]: any;

    constructor(file: string, main?: (...args: any[]) => unknown, meta?: unknown) {
        // Auto-detect the project folder by matching the file basename
        // against rarebert's own install folders (home), since scripts
        // always live there regardless of the user's cwd.
        const ext = path.extname(file);
        const basename = path.basename(file, ext);
        const allFolders = home.discover();
        const project =
            allFolders.find((f) => fs.existsSync(path.join(f.dir, file))) || allFolders[0];

        this.project = project;
        this.file = file;
        this.name = basename;
        this.ext = ext;
        this.abs = path.join(project.dir, file);
        this.path = home.relPath(this.abs);
        this.dir = project.rel;
        this.meta = meta || null;
        this.main = main || null;
        this.runner = null;
    }

    toString(): string {
        return this.path;
    }

    /** Path of the local-only memo sidecar (`<file>.`). */
    memoFile(): string {
        return this.abs + '.';
    }

    /**
     * Run this module's main callback with the given arguments and return
     * the result. Does not exit the process — the Runtime (core.ts run())
     * folds the returned signal (or bare code) to process exit. The
     * Commander-wrapped runner is preferred when one is wired (CLI/TUI).
     */
    async execute(args: string[] = []): Promise<unknown> {
        const runner = this.runner || this.main;
        if (!runner) {
            return exit(
                new Error(`${this.path}: module has no main callback — use exit() to signal completion.`)
            );
        }
        return await (runner as (...a: any[]) => unknown)(args);
    }

    /**
     * Create a lightweight Module instance from an already-known project
     * descriptor and file — used by `listAllModules()`. Skips the project
     * auto-detection and does not wire a main callback.
     */
    static fromProject(project: ProjectFolder, file: string): Module {
        const mod = Object.create(Module.prototype) as Module;
        mod.project = project;
        mod.file = file;
        mod.name = path.basename(file, path.extname(file));
        mod.ext = path.extname(file);
        mod.abs = path.join(project.dir, file);
        mod.path = rarebert.relPath(mod.abs);
        mod.dir = project.rel;
        mod.meta = null;
        mod.main = null;
        mod.runner = null;
        return mod;
    }

    /**
     * DEPRECATED — direct-launch guard, currently a no-op.
     *
     * This used to wire self-execution for `bun scripts/<name>.ts` (comparing
     * import.meta.url against process.argv[1], installing signal handlers,
     * preloading the memo trail, and handing off to core.run()). It is
     * deprecated because `import.meta` is not reliably available across all
     * runtime/target contexts.
     *
     * Scripts now run exclusively through the dispatcher (launch.ts), which
     * owns module resolution, the memo loadForRun cascade, and process
     * termination. The method is kept as a no-op so existing call sites
     * (`…supportsDirectRunning(import.meta.url)`) remain valid; prefer
     * dropping the call entirely. Returns `this` for chaining.
     */
    supportsDirectRunning(_metaUrl?: string): this {
        return this;
    }

    // -- terminal helpers & abort machinery (delegates to free functions) --

    isInteractive(): boolean {
        return isInteractive();
    }

    /** Bail for a non-interactive environment (see the free function). */
    nonInteractive(message: string, code = EXIT_FAIL) {
        return nonInteractive(message, code);
    }

    /** Abort with cleanup callbacks running (see the free function). */
    abort(message = '\nAborted.') {
        return abort(message);
    }

    /** Register an abort handler; returns an unsubscribe function. */
    onAbort(callback: () => void): () => void {
        return onAbort(callback);
    }

    /** Install the process-global signal handlers (idempotent). */
    installSignalHandlers(): void {
        installSignalHandlers();
    }

    /** Run the registered abort callbacks (cleanup errors don't cascade). */
    runAbortCallbacks(): void {
        runAbortCallbacks();
    }

    /**
     * Closure-producing gate — `return this.runInteractively(fn)()`.
     */
    runInteractively(
        fn: (...args: any[]) => unknown,
        options?: RunInteractiveOptions
    ): ((...args: any[]) => unknown) {
        return runInteractively(this, fn, options);
    }

    /** Truncate a string for terminal display. */
    truncate(str: string, max: number = (process.stdout.columns as number) || 80): string {
        return truncate(str, max);
    }

    /** Clear the screen when attached to a TTY. */
    clear(): void {
        if (isInteractive()) process.stdout.write(CLEAR_SCREEN);
    }
}

export { Module };
