import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Command, Option, InvalidArgumentError } from 'commander';
import { rarebert, home } from './projects.mjs';
import { ExitSignal, exit, AbortError } from './core.mjs';
import { run } from './runtime.mjs';
import { CLEAR_SCREEN } from './symbols.mjs';

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ABORT = 130;

// AbortError — thrown on ctrl-c / escape from Enquirer prompts — is
// defined in core.mjs (the signal home) and re-exported here for compat.

// ---------------------------------------------------------------------------
// runInteractively — closure-producing, callback-capturing gate around
// interactive (Enquirer-based) work. Shared by Module/CLI/TUI instances and
// the cli/tui singletons so every interactive entry point funnels through
// one bail path built on the exit() machinery.
//
// runInteractively(ctx, fn, options) returns an async wrapper around `fn`.
// When the wrapper is invoked:
//   - Interactive environment → `fn` runs. Prompt rejections inside `fn`
//     surface as AbortError (see TUI.confirm/input/select) and propagate
//     to the run wrapper, which centralizes cleanup via the abort flow.
//   - Non-interactive environment → `fn` is NEVER invoked. The wrapper
//     bails with a result the runModule machinery understands: an
//     ExitSignal from exit() (via nonInteractive), or — when a `fallback`
//     is supplied — the fallback's plain value for callers that can
//     proceed without the prompt.
//
// Because the bail path returns an ExitSignal, a main callback can simply
// `return this.runInteractively(fn)()` and Module.exit() funnels it through
// the standard exit() machinery: abort callbacks run, the message prints
// to stderr, and the process exits with the signal's code.
// ---------------------------------------------------------------------------

function runInteractively(
    ctx,
    fn,
    { message = 'interactive input required', fallback = null } = {}
) {
    if (typeof fn !== 'function') {
        throw new TypeError('runInteractively: fn must be a function');
    }
    return async (...args) => {
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
// runnable via `node scripts/<name>.mjs` — call `supportsDirectRunning()`
// after the export to wire up the self-execution guard.
//
// Subclasses:
//   CLI — command-line modules with Commander arg parsing + terminal helpers
//   TUI — full-screen interactive modules (Enquirer-heavy)
// ---------------------------------------------------------------------------

class Module {
    constructor(file, main, meta) {
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
        this.abortCallbacks = [];
        this.handlersInstalled = false;
        this.aborting = false;
        this.ctrlcCount = 0;
        this.ctrlcTimer = null;
        this.width = process.stdout.columns || 80;
        this.lastCtrlcTime = 0;
    }

    toString() {
        return this.path;
    }

    memoFile() {
        return this.abs + '.';
    }

    /**
     * Run this module's main callback with the given arguments and
     * return the result. Does not exit the process.
     *
     * DEPRECATED: When the main callback is missing, this calls process.exit() directly.
     * This should instead return exit(1) to go through the exit() callback system.
     */
    async execute(args = []) {
        const runner = this.runner || this.main;
        if (!runner) {
            const { exit } = await import('./core.mjs');
            return exit(new Error(`${this.path}: module has no main callback`));
        }
        return await runner(args);
    }

    /**
     * Create a lightweight Module instance from an already-known project
     * descriptor and file — used by `listAllModules()`. Skips the project
     * auto-detection and does not wire a main callback.
     */
    static fromProject(project, file) {
        const mod = Object.create(Module.prototype);
        mod.project = project;
        mod.file = file;
        mod.name = path.basename(file, path.extname(file));
        mod.ext = path.extname(file);
        mod.abs = path.join(project.dir, file);
        mod.path = rarebert.relPath(mod.abs);
        mod.dir = project.rel;
        mod.meta = null;
        mod.main = null;
        return mod;
    }

    /**
     * Wire up direct execution: when this file is the main Node entry
     * point (i.e. `node scripts/<name>.mjs`), run the module immediately.
     */
    supportsDirectRunning(metaUrl) {
        if (!metaUrl) return this;
        const resolved = fileURLToPath(metaUrl);
        const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
        let realArgv1 = argv1;
        try {
            realArgv1 = fs.realpathSync(argv1);
        } catch {
            /* not a symlink or missing */
        }
        if ((argv1 && resolved === argv1) || (realArgv1 && resolved === realArgv1)) {
            this.installSignalHandlers();
            // The Runtime owns running the module (and any submodule
            // chains) to process exit — see lib/runtime.mjs.
            run(this, process.argv.slice(2)).catch((err) => {
                // Last-resort guard: run() already routes errors through
                // the exit() machinery; reaching here means a Runtime bug.
                console.error(err?.message || String(err));
                process.exit(1);
            });
        }
        return this;
    }
    installSignalHandlers() {
        if (this.handlersInstalled) return;
        this.handlersInstalled = true;
        this.lastCtrlcTime = 0;

        const handler = () => {
            if (this.aborting) {
                this.ctrlcCount++;
                if (this.ctrlcCount >= 2) {
                    this.clearCtrlcTimer();
                    process.exit(EXIT_ABORT);
                }
                return;
            }
            this.handleCtrlC();
        };
        process.on('SIGINT', () => handler());
        process.on('SIGHUP', () => handler());
        process.on('SIGTERM', () => handler());
        process.on('exit', () => this.runAbortCallbacks());
    }

    onAbort(callback) {
        if (typeof callback === 'function') this.abortCallbacks.push(callback);
        return () => {
            const i = this.abortCallbacks.indexOf(callback);
            if (i >= 0) this.abortCallbacks.splice(i, 1);
        };
    }

    abort(message = '\nAborted.') {
        this.aborting = true;
        this.clearCtrlcTimer();
        this.runAbortCallbacks();
        return exit(message);
    }

    nonInteractive(message, code = EXIT_FAIL) {
        this.aborting = true;
        this.runAbortCallbacks();
        return exit(`Non-interactive; ${message}`);
    }

    /**
     * runInteractively(fn, options) — closure-producing, callback-capturing
     * gate around interactive work. Returns an async wrapper around `fn`:
     * interactive → fn runs (prompts surface AbortError through the abort
     * flow); non-interactive → fn never runs and the wrapper bails with an
     * ExitSignal from exit() (or the `fallback` value), which Module.exit()
     * funnels through the standard runModule machinery. Main callbacks can
     * simply `return this.runInteractively(fn)()`.
     */
    runInteractively(fn, options = {}) {
        return runInteractively(this, fn, options);
    }

    truncate(str, max = this.width) {
        return str.length > max ? str.slice(0, max - 1) + '…' : str;
    }

    isInteractive() {
        return process.stdin.isTTY === true;
    }

    createCommand(meta) {
        const program = new Command();
        program.name(meta.name).description(meta.description).exitOverride();
        program.helpOption(false);
        program.allowUnknownOption(meta.allowUnknownOption === true);
        program.allowExcessArguments();
        if (meta.usage) program.usage(meta.usage);
        for (const opt of meta.options || []) {
            const flagStr = this._flagString(opt);
            const parser = this._typeParser(opt);
            if (parser) program.option(flagStr, opt.description || '', parser, opt.default);
            else program.option(flagStr, opt.description || '', opt.default);
        }
        return program;
    }

    _flagString(opt) {
        let flag = opt.flag || '';
        let label = opt.label || '';
        if (flag && !flag.startsWith('-')) flag = `--${flag}`;
        if (label && label.startsWith('<') && label.endsWith('>')) {
            if (!flag.includes(' ')) flag = `${flag} ${label}`;
        }
        return flag || label;
    }

    _typeParser(opt) {
        if (opt.type === 'int') {
            return (v) => {
                const n = parseInt(v, 10);
                if (isNaN(n)) throw new InvalidArgumentError(`Must be an integer`);
                return n;
            };
        }
        if (opt.type === 'float') {
            return (v) => {
                const n = parseFloat(v);
                if (isNaN(n)) throw new InvalidArgumentError(`Must be a number`);
                return n;
            };
        }
        if (opt.type === 'array') {
            return (v, prev = []) => {
                return v.includes(',') ? v.split(',').map((s) => s.trim()) : [...prev, v];
            };
        }
        if (opt.choices) {
            const choices = new Set(opt.choices);
            return (v) => {
                if (!choices.has(v))
                    throw new InvalidArgumentError(`Must be one of: ${opt.choices.join(', ')}`);
                return v;
            };
        }
        const flagStr = this._flagString(opt);
        if (/\s<[^>]+>/.test(flagStr) || /\s\[[^\]]+\]/.test(flagStr)) {
            return (v) => v;
        }
        return null;
    }

    wantsHelp(args) {
        return args.includes('--help') || args.includes('-h');
    }

    clear() {
        if (this.isInteractive()) process.stdout.write(CLEAR_SCREEN);
    }

    runAbortCallbacks() {
        for (const cb of this.abortCallbacks) {
            try {
                cb();
            } catch {
                /* never let cleanup throw cascade */
            }
        }
    }

    handleCtrlC() {
        const now = Date.now();
        if (this.ctrlcTimer && now - this.lastCtrlcTime < 1000) {
            this.ctrlcCount++;
        } else {
            this.ctrlcCount = 1;
        }
        this.lastCtrlcTime = now;

        if (this.ctrlcCount >= 2) {
            this.clearCtrlcTimer();
            process.exit(EXIT_ABORT);
            return;
        }

        this.clearCtrlcTimer();
        this.ctrlcTimer = setTimeout(() => {
            this.ctrlcCount = 0;
        }, 1000);

        this.runAbortCallbacks();
    }

    clearCtrlcTimer() {
        if (this.ctrlcTimer) {
            clearTimeout(this.ctrlcTimer);
            this.ctrlcTimer = null;
        }
    }

    printHelp(meta) {
        const { name, description, usage = '', options = [] } = meta;
        console.log(`${name}: ${description}`);
        if (usage) console.log(`  Usage: ${usage}`);
        for (const opt of options) {
            const flag = opt.flag ? `--${opt.flag}` : '';
            const label = [flag, opt.label].filter(Boolean).join('  ');
            console.log(`  ${label.padEnd(20)}${opt.description || ''}`);
        }
    }

    parse(argv = [], options = []) {
        const program = new Command();
        program.exitOverride();
        program.allowUnknownOption(false);
        program.allowExcessArguments();
        program.helpOption(false);

        for (const opt of options) {
            const flagStr = this._flagString(opt);
            const desc = opt.description || '';
            const def = opt.default;
            const parser = this._typeParser(opt);
            const action = parser
                ? program.option(flagStr, desc, parser, def)
                : program.option(flagStr, desc, def);
            if (opt.alias) action.short(opt.alias);
        }

        let parseError = null;
        try {
            program.parse(['node', 'rarebert', ...argv]);
        } catch (err) {
            parseError = err;
        }

        if (parseError) {
            const msg = parseError.message || String(parseError);
            if (parseError.code === 'commander.help') return { flags: {}, positional: [] };
            throw new AbortError(msg, 1);
        }

        const flags = { ...program.opts() };
        const positional = program.args.slice();
        return { flags, positional };
    }
}

// ---------------------------------------------------------------------------
// Argument validation — validates positional args against meta.args spec.
// meta.args is an array of { name, required } entries. When a required
// arg is missing, prints usage and exits. Called by CLI._wrap before main.
// ---------------------------------------------------------------------------

function _validateArgs(argSpec, positional, moduleName) {
    if (!argSpec || !Array.isArray(argSpec)) return null;
    for (let i = 0; i < argSpec.length; i++) {
        const spec = argSpec[i];
        if (spec.required && (positional[i] === undefined || positional[i] === null)) {
            const argList = argSpec
                .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
                .join(' ');
            return exit(1, {
                onExit: () =>
                    console.error(
                        `Missing required argument: <${spec.name}>\nUsage: rarebert ${moduleName} ${argList}`
                    )
            });
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// CLI — a Module with Commander arg parsing and terminal I/O helpers.
//
// The CLI class encapsulates all command-line interaction: signal handling,
// exit/die/abort, interactive prompts (confirm/select/input), and
// Commander-based argv parsing. The `sharedCLI` singleton is used for
// terminal helpers that aren't tied to a specific module (signal handlers,
// truncate, isInteractive) — it's imported across the codebase as `cli`.
// ---------------------------------------------------------------------------

class CLI extends Module {
    constructor(file, main, meta) {
        super(file, main, meta);
        this.runner = main ? this._wrap(meta, main) : null;
    }

    // --- Signal handling & abort ---

    // --- Terminal helpers ---

    // --- Commander integration ---

    /**
     * Build a Commander program from `meta`, wire `main` as its action
     * callback, and return a runner. The main callback receives
     * (opts, positional) where opts is the parsed options object and
     * positional is the remaining positional arguments.
     */
    _wrap(meta, main) {
        return async (args = []) => {
            const program = this.createCommand(meta);
            let actionResult;

            program.action(
                this._buildActionHandler(program, meta, main, (r) => {
                    actionResult = r;
                })
            );

            if (!meta.skipHelpIntercept && this.wantsHelp(args)) {
                program.outputHelp();
                return exit(0);
            }

            try {
                await this._parseArgv(program, meta, args);
            } catch (sig) {
                if (sig instanceof ExitSignal) return sig;
                throw sig;
            }
            return actionResult;
        };
    }

    _buildActionHandler(program, meta, main, capture) {
        return async () => {
            const opts = program.opts();
            const positional = program.args.slice();
            try {
                const validationErr = _validateArgs(meta.args, positional, meta.name);
                if (validationErr) {
                    capture(validationErr);
                    return;
                }
                capture(await main(opts, positional));
            } catch (err) {
                if (err && err.name === 'AbortError') throw err;
                capture(exit(err));
            }
        };
    }

    async _parseArgv(program, meta, args) {
        try {
            await program.parseAsync(['node', meta.name || 'rarebert', ...args]);
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            if (err?.code === 'commander.help') return;
            throw exit(err);
        }
    }
}

// ---------------------------------------------------------------------------
// TUI — a CLI subclass for full-screen interactive (Enquirer-heavy)
// interfaces. TUI inherits all of CLI's behavior (Commander arg parsing,
// terminal helpers, signal handling) and overrides execute() to clear
// the screen after the run so the next shell line doesn't clash with
// TUI output. main always receives (opts, positional) just like CLI.
// ---------------------------------------------------------------------------

class TUI extends CLI {
    constructor(file, main, meta) {
        super(file, main, meta);
        this.clearScreen = meta?.clearScreen; // default false
    }

    clear() {
        if (this.isInteractive() && this.clearScreen) {
            process.stdout.write(CLEAR_SCREEN);
        }
    }

    /**
     * Run the TUI module. Delegates to CLI's execute (which parses
     * argv via Commander and invokes the wrapped main with
     * (opts, positional)), then clears the screen so the next shell
     * line doesn't clash with TUI output.
     */
    async execute(args = []) {
        // --help is not interactive: let Commander intercept it before the
        // interactive gate bails, so TUI modules answer --help in
        // non-interactive environments too.
        if (this.wantsHelp(args)) {
            return super.execute(args);
        }
        const run = this.runInteractively(() => super.execute(args), {
            message: `tui: ${this.path} requires an interactive terminal (stdin is not a TTY).`
        });
        const result = await run();
        this.clear();
        return result;
    }
    /**
     * Lazily import the enquirer library at runtime — mirroring how
     * createCommand() pulls in commander only when argv parsing runs.
     * Enquirer therefore loads only when a TUI member method actually
     * constructs a prompt, keeping it off every module's startup path.
     */
    async createInterface() {
        const { default: Enquirer } = await import('enquirer');
        return Enquirer;
    }

    async confirm(message, initial = false) {
        const run = this.runInteractively(
            async () => {
                const Enquirer = await this.createInterface();
                const prompt = new Enquirer.Confirm({ name: 'confirm', message, initial });
                try {
                    return await prompt.run();
                } catch {
                    throw new AbortError();
                }
            },
            { fallback: async () => initial }
        );
        return run();
    }

    async input(message, options = {}) {
        const { initial = '', validate = null, nonInteractiveBehavior = 'fail' } = options;
        const run = this.runInteractively(
            async () => {
                const Enquirer = await this.createInterface();
                const prompt = new Enquirer.Input({ name: 'input', message, initial, validate });
                try {
                    const result = await prompt.run();
                    return result?.trim() || initial;
                } catch {
                    throw new AbortError();
                }
            },
            {
                message: 'cannot prompt for input.',
                // 'fail' (default) → bail with a nonInteractive ExitSignal through
                // the exit() machinery; 'default' → bail with the initial value.
                fallback: nonInteractiveBehavior === 'fail' ? null : async () => initial
            }
        );
        return run();
    }

    async select(message, choices, options = {}) {
        const { initial = 0, limit = 10, nonInteractiveBehavior = 'fail' } = options;
        const run = this.runInteractively(
            async () => {
                const Enquirer = await this.createInterface();
                const prompt = new Enquirer.Select({
                    name: 'select',
                    message,
                    choices,
                    initial,
                    limit
                });
                try {
                    return await prompt.run();
                } catch {
                    throw new AbortError();
                }
            },
            {
                message: 'cannot prompt for selection.',
                fallback:
                    nonInteractiveBehavior === 'fail'
                        ? null
                        : async () => {
                              const choice = choices[initial];
                              return typeof choice === 'string' ? choice : choice.name;
                          }
            }
        );
        return run();
    }
}

// ---------------------------------------------------------------------------
// Interface — composes UX flows as sequences of TUI -> TUI stages.
//
// Where a Module wraps a single main callback, an Interface wraps a chain
// of stages run through the exit() machinery. Each stage is either a TUI
// instance (run via its execute()) or a step function `(ctx, prev)`; a
// stage's result decides continuation — dispatched entirely by exit()'s
// argument kind (function-level polymorphism, no duck typing):
//   - exit(0)        → ADVANCE to the next stage
//   - exit("string") → TERMINATE the flow; the string is the explanation,
//     printed by the signal's onExit during complete(); the flow's code
//     is the string kind's code (EXIT_FAIL)
//   - exit(n) / n≠0  → TERMINATE the flow with code n
//   - any other value (function stages) → ADVANCE, passed to the next
//     stage as `prev`
//
// Flow-as-main: a TUI/CLI main callback may simply `return exit(flow)` —
// exit()'s kind dispatch wraps the flow as an ExitSignal submodule, and
// the Runtime drives the whole chain through complete(). No duck typing
// at the callsite; the same one-line pattern as every other result kind.
//
// CLI-runtime guard: constructing an Interface from a CLI runtime (stdin
// not a TTY) returns exit() — a nonInteractive ExitSignal — instead of an
// instance. A returned object replaces `this` in a JS constructor, so a
// main can uniformly `return exit(Interface.createInterface(...))` and
// the Runtime bails through the standard machinery without ever building
// the flow.
// ---------------------------------------------------------------------------
class Interface {
    constructor(name, { tui = null, stages = [] } = {}) {
        if (!cli.isInteractive()) {
            return cli.nonInteractive(
                `cannot construct interface "${name}" — an interactive (TUI) runtime is required.`
            );
        }
        this.name = name;
        this.path = name;
        this.tui = tui || new TUI(`${name}.interface`);
        this.stages = [...stages];
    }

    /** Append a stage (TUI instance or `(ctx, prev)` step) — fluent. */
    stage(step) {
        this.stages.push(step);
        return this;
    }

    /**
     * Run the stage chain. Returns the flow's exit code: 0 when every
     * stage advanced (each returning exit(0)), or the terminating stage's
     * code — including the string kind's EXIT_FAIL when a stage returns
     * exit("explanation"). Because execute() is Module-shaped,
     * ExitSignal's submodule kind runs the whole flow — a main callback
     * simply `return exit(flow)`.
     */
    async execute(args = []) {
        let prev;
        for (const step of this.stages) {
            const result =
                typeof step === 'function'
                    ? await step({ tui: this.tui, args, prev })
                    : await step.execute(args);

            if (result instanceof ExitSignal) {
                const code = await result.complete();
                if (code !== 0) return code;
                prev = undefined;
            } else if (typeof result === 'number') {
                if (result !== 0) return result;
                prev = undefined;
            } else {
                prev = result;
            }
        }
        return 0;
    }

    // ------------------------------------------------------------------
    // Prompt factories — parametrisable print/prompt/query creators.
    //
    // Each returns a submodule-level TUI runnable: a thenable object with
    // execute(args) that resolves to the prompt's value — or bails with a
    // nonInteractive ExitSignal through the runInteractively machinery.
    // Runnables dual-dispatch:
    //   - "return value" — await iface.select(...)  → the choice
    //   - "return exit"  — exit(iface.select(...))  → ExitSignal's
    //     submodule kind runs the runnable and folds the result to an
    //     exit code
    // and they drop straight into stage() chains as TUI-shaped stages.
    //
    // Effectful steps that produce no value (logging, spawning, ...) are
    // plain function stages — `flow.stage(() => console.log('hi'))` —
    // which never touch the interactive gate. There is deliberately no
    // print() factory for that.
    // ------------------------------------------------------------------

    /**
     * Wrap `run` in a submodule-level runnable gated by the Interface's
     * own TUI instance — same non-interactive bail/fallback semantics as
     * every other prompt path.
     */
    _runnable(run, { message = 'interactive input required', fallback = null } = {}) {
        const tui = this.tui;
        return {
            tui,
            async execute() {
                const gate = tui.runInteractively(run, { message, fallback });
                return await gate();
            },
            then(onFulfilled, onRejected) {
                return this.execute().then(onFulfilled, onRejected);
            }
        };
    }

    confirm(message, initial = false) {
        return this._runnable(() => this.tui.confirm(message, initial), {
            fallback: async () => initial
        });
    }

    input(message, options = {}) {
        const { nonInteractiveBehavior = 'fail' } = options;
        return this._runnable(() => this.tui.input(message, options), {
            message: 'cannot prompt for input.',
            fallback: nonInteractiveBehavior === 'fail' ? null : async () => options.initial ?? ''
        });
    }

    select(message, choices, options = {}) {
        const { nonInteractiveBehavior = 'fail' } = options;
        return this._runnable(() => this.tui.select(message, choices, options), {
            message: 'cannot prompt for selection.',
            fallback:
                nonInteractiveBehavior === 'fail'
                    ? null
                    : async () => {
                          const choice = choices[options.initial ?? 0];
                          return typeof choice === 'string' ? choice : choice.name;
                      }
        });
    }

    /**
     * Escape hatch for bespoke Enquirer prompts (AutoComplete, MultiSelect,
     * keypress handlers, ...): parametrise the prompt class, its full
     * options object, and an optional setup(prompt) callback for wiring
     * handlers before run(). Resolves to the raw Enquirer result.
     */
    query(promptType, options = {}, setup = null) {
        return this._runnable(async () => {
            const Enquirer = await this.tui.createInterface();
            const prompt = new Enquirer[promptType](options);
            if (typeof setup === 'function') setup(prompt);
            try {
                return await prompt.run();
            } catch {
                throw new AbortError();
            }
        });
    }

    /**
     * The single entry point for call sites: build an Interface with the
     * print/prompt/query factories attached. In a CLI runtime the
     * constructor returns exit() — callers uniformly `return` it.
     */
    static createInterface(name = 'interface', options = {}) {
        return new Interface(name, options);
    }
}

// ---------------------------------------------------------------------------
// Shared CLI instance — terminal helpers and signal handling used by
// modules and lib code that need CLI-level I/O without being a Module
// themselves (e.g. git.mjs, backend.mjs, memo.mjs).
// ---------------------------------------------------------------------------

// `cli` is the shared singleton for terminal helpers, signal handling,
// and Commander integration — used by lib/ code (git.mjs, backend.mjs,
// memo.mjs, etc.) that needs CLI-level I/O without being a Module.

// ---------------------------------------------------------------------------
// Module discovery & resolution functions
// ---------------------------------------------------------------------------

function findDirectoryTarget(key) {
    return rarebert.discover().find((t) => t.key === key) || null;
}

function directoryTargetByPath(absPath) {
    const resolved = path.resolve(absPath);
    const targets = rarebert.discover();
    return (
        targets.find((t) => t.dir === resolved) ||
        targets.find((t) => resolved.startsWith(t.dir + path.sep)) ||
        null
    );
}

/**
 * Enumerate every module across all discovered project folders.
 * Pass `{ all: true }` to index every file regardless of extension
 * (used by memo indexing where any file may receive a sidecar).
 * Returns an array of Module instances (lightweight, no main callback).
 */
function listAllModules(options = {}) {
    const modules = [];
    for (const project of rarebert.discover()) {
        for (const m of rarebert.discoverModules(project.dir, project.exts, options)) {
            modules.push(Module.fromProject(project, path.basename(m.path)));
        }
    }
    return modules;
}

function buildModuleChoices(modules) {
    return modules.map((s) => {
        const meta = rarebert.getScriptMetadata(s.abs);
        const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
        const label = cli.truncate(`${s.path}${desc ? ' - ' + desc : ''}`);
        return { name: s.path, message: label };
    });
}

function resolveModule(arg, modules) {
    const rel = path.isAbsolute(arg) ? rarebert.relPath(arg) : arg;
    const mod =
        modules.find((m) => m.path === rel) ||
        modules.find((m) => m.path.endsWith(rel)) ||
        modules.find((m) => m.name === path.basename(rel, path.extname(rel)));
    if (!mod) return null;
    return { module: mod, rel: mod.path, sidecar: mod.memoFile() };
}

function resolveModuleSet(args, modules) {
    const result = [];
    const seen = new Set();
    for (const arg of args) {
        const abs = path.isAbsolute(arg) ? arg : path.resolve(rarebert.root, arg);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            for (const m of modules) {
                if ((m.abs.startsWith(abs + path.sep) || m.abs === abs) && !seen.has(m.path)) {
                    seen.add(m.path);
                    result.push({ module: m, rel: m.path, sidecar: m.memoFile() });
                }
            }
            continue;
        }
        const resolved = resolveModule(arg, modules);
        if (resolved) {
            if (!seen.has(resolved.rel)) {
                seen.add(resolved.rel);
                result.push(resolved);
            }
        } else {
            console.error(`no module matched "${arg}"`);
        }
    }
    return result;
}

async function promptModule(modules, moduleArg, message = 'Select a module') {
    if (moduleArg) {
        const match =
            modules.find(
                (s) =>
                    rarebert.normalizeModuleName(s.name) === rarebert.normalizeModuleName(moduleArg)
            ) ||
            modules.find((s) => s.path === moduleArg) ||
            modules.find((s) => s.path.endsWith(moduleArg) || s.name === moduleArg);
        if (!match) {
            throw new AbortError(`Module not found: ${moduleArg}`, 1);
        }
        return match;
    }

    if (process.stdin.isTTY !== true) {
        throw new AbortError('Non-interactive; pass a module name as an argument.', 1);
    }

    const choices = buildModuleChoices(modules);
    const answer = await promptModuleChoices(message, choices, { limit: 12 });
    return modules.find((s) => s.path === answer);
}

async function promptModuleChoices(message, choices, options = {}) {
    const { limit = 10, specials = [] } = options;
    const specialSet = new Set(specials);

    if (!cli.isInteractive()) {
        // Non-interactive: the former `tui.select` call never constructed a
        // prompt here — it bailed through cli.nonInteractive. Call it
        // directly now that the tui singleton is gone.
        return cli.nonInteractive('cannot prompt for selection.');
    }

    const indexed = choices.map((c) => {
        const msg = (c.message || '').toLowerCase();
        const name = (c.name || '').toLowerCase();
        const basename = name.replace(/^.*\//, '').replace(/\.\w+$/, '');
        return { choice: c, name, basename, msg };
    });

    const fuzzyMatch = (text, query) => {
        const tokens = query.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return true;
        let pos = 0;
        for (const token of tokens) {
            const idx = text.indexOf(token, pos);
            if (idx === -1) return false;
            pos = idx + token.length;
        }
        return true;
    };

    const DEFAULT_CTRL = {
        a: 'first',
        b: 'backward',
        c: 'cancel',
        d: 'deleteForward',
        e: 'last',
        f: 'forward',
        g: 'reset',
        i: 'tab',
        k: 'cutForward',
        l: 'reset',
        n: 'newItem',
        m: 'cancel',
        j: 'submit',
        p: 'search',
        r: 'remove',
        s: 'save',
        u: 'undo',
        w: 'cutLeft',
        x: 'toggleCursor',
        v: 'paste'
    };
    const DEFAULT_KEYS = {
        pageup: 'pageUp',
        pagedown: 'pageDown',
        home: 'home',
        end: 'end',
        cancel: 'cancel',
        delete: 'deleteForward',
        backspace: 'delete',
        down: 'down',
        enter: 'submit',
        escape: 'cancel',
        left: 'left',
        space: 'space',
        number: 'number',
        return: 'submit',
        right: 'right',
        tab: 'next',
        up: 'up'
    };

    // Lazy enquirer import — this standalone helper is not a TUI member
    // method, so it pulls the library in at call time (same pattern as
    // backend.mjs / memo.mjs) instead of at module load.
    const { default: Enquirer } = await import('enquirer');

    const prompt = new Enquirer.AutoComplete({
        name: 'module',
        message,
        choices,
        limit,
        actions: {
            ctrl: { ...DEFAULT_CTRL, w: 'deleteWordLeft', h: 'deleteWordLeft' },
            keys: { ...DEFAULT_KEYS, backspace: 'deleteWordLeftIfCtrl' }
        },
        deleteWordLeft(input, key) {
            const inputVal = this.input || '';
            if (!inputVal) return this.alert();
            const trimmed = inputVal.replace(/\s+$/, '');
            const lastSpace = trimmed.lastIndexOf(' ');
            this.input = lastSpace >= 0 ? trimmed.slice(0, lastSpace) : '';
            this.cursor = this.input.length;
            this.render();
        },
        deleteWordLeftIfCtrl(input, key) {
            if (key && key.ctrl) {
                return this.options.deleteWordLeft.call(this, input, key);
            }
            return this.delete.call(this, input, key);
        },
        dispatch(ch, key) {
            if (ch === undefined || ch === null || typeof ch !== 'string' || !ch.trim()) {
                return this.alert();
            }
            if (ch.charCodeAt(0) < 32) {
                return this.alert();
            }
            return this.append(ch);
        },
        suggest(input) {
            const q = (input || '').toLowerCase().trim();
            if (!q) return choices;

            const tokens = q.split(/\s+/).filter(Boolean);
            const pinned = [];
            const allTokensInMsg = (msg) => tokens.every((t) => msg.includes(t));
            const lastToken = tokens[tokens.length - 1];

            const buckets = [[], [], [], [], []];
            for (const item of indexed) {
                const { choice, name, basename, msg } = item;
                if (specialSet.has(choice.name)) {
                    if (fuzzyMatch(name, q) || fuzzyMatch(msg, q)) {
                        pinned.push(choice);
                    }
                    continue;
                }
                if (!allTokensInMsg(msg)) continue;
                if (basename.includes(lastToken)) buckets[0].push(choice);
                else if (tokens.some((t) => basename.includes(t))) buckets[1].push(choice);
                else if (name.includes(lastToken)) buckets[2].push(choice);
                else if (tokens.some((t) => name.includes(t))) buckets[3].push(choice);
                else buckets[4].push(choice);
            }
            return [...pinned, ...buckets.flat()];
        }
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

export {
    Module,
    cli,
    CLI,
    TUI,
    Interface,
    AbortError,
    runInteractively,
    EXIT_OK,
    EXIT_FAIL,
    EXIT_ABORT,
    findDirectoryTarget,
    directoryTargetByPath,
    listAllModules,
    buildModuleChoices,
    resolveModule,
    resolveModuleSet,
    promptModule,
    promptModuleChoices
};
export default Module;

// DEPRECATED — the lowercase `cli` singleton is slated for removal, the
// same way the former `tui` object was. Target architecture (memo'd on
// every lib/ module): lib/ modules export one class each, re-exported from
// lib/index.mjs; terminal helpers live on Module/CLI/TUI instance members
// and are consumed through instances, not a shared object. Existing
// consumers should migrate to instance methods or lib/runtime.mjs.
//
// Module-level cli object for backward compatibility
// Provides the same interface as the old _SharedCLI singleton
const cli = {
    abortCallbacks: [],
    handlersInstalled: false,
    aborting: false,
    ctrlcCount: 0,
    ctrlcTimer: null,
    width: process.stdout.columns || 80,
    lastCtrlcTime: 0,

    clear() {
        if (this.isInteractive()) process.stdout.write('\x1b[2J\x1b[H');
    },

    truncate(str, max = this.width) {
        return str.length > max ? str.slice(0, max - 1) + '…' : str;
    },

    onAbort(callback) {
        if (typeof callback === 'function') this.abortCallbacks.push(callback);
        return () => {
            const i = this.abortCallbacks.indexOf(callback);
            if (i >= 0) this.abortCallbacks.splice(i, 1);
        };
    },

    runAbortCallbacks() {
        for (const cb of this.abortCallbacks) {
            try {
                cb();
            } catch {
                /* never let cleanup throw cascade */
            }
        }
    },

    handleCtrlC() {
        const now = Date.now();
        if (this.ctrlcTimer && now - this.lastCtrlcTime < 1000) {
            this.ctrlcCount++;
        } else {
            this.ctrlcCount = 1;
        }
        this.lastCtrlcTime = now;

        if (this.ctrlcCount >= 2) {
            this.clearCtrlcTimer();
            process.exit(130);
            return;
        }

        this.clearCtrlcTimer();
        this.ctrlcTimer = setTimeout(() => {
            this.ctrlcCount = 0;
        }, 1000);
        this.runAbortCallbacks();
    },

    clearCtrlcTimer() {
        if (this.ctrlcTimer) {
            clearTimeout(this.ctrlcTimer);
            this.ctrlcTimer = null;
        }
    },

    installSignalHandlers() {
        if (this.handlersInstalled) return;
        this.handlersInstalled = true;
        this.lastCtrlcTime = 0;
        const handler = () => {
            if (this.aborting) {
                this.ctrlcCount++;
                if (this.ctrlcCount >= 2) {
                    this.clearCtrlcTimer();
                    process.exit(130);
                }
                return;
            }
            this.handleCtrlC();
        };
        process.on('SIGINT', () => handler());
        process.on('SIGHUP', () => handler());
        process.on('SIGTERM', () => handler());
        process.on('exit', () => this.runAbortCallbacks());
    },

    abort(message = '\nAborted.') {
        this.aborting = true;
        this.clearCtrlcTimer();
        this.runAbortCallbacks();
        return exit(message);
    },

    ok(message) {
        if (message) console.dir(message);
        return exit(0);
    },

    fail(message) {
        return exit(message);
    },

    isInteractive() {
        return process.stdin.isTTY === true;
    },

    nonInteractive(message, code = 1) {
        this.aborting = true;
        this.runAbortCallbacks();
        return exit(`Non-interactive; ${message}`);
    },

    // Closure-producing gate around interactive work — see the shared
    // runInteractively() helper. Bails with an ExitSignal from exit()
    // when the environment is non-interactive, so main callbacks can
    // `return cli.runInteractively(fn)()` and let the runModule machinery
    // handle termination.
    runInteractively(fn, options = {}) {
        return runInteractively(this, fn, options);
    },

    createCommand(meta) {
        const { Command } = require('commander');
        const program = new Command();
        program.name(meta.name).description(meta.description).exitOverride();
        program.helpOption(false);
        program.allowUnknownOption(meta.allowUnknownOption === true);
        program.allowExcessArguments();
        if (meta.usage) program.usage(meta.usage);
        for (const opt of meta.options || []) {
            const flagStr = this._flagString(opt);
            const parser = this._typeParser(opt);
            if (parser) program.option(flagStr, opt.description || '', parser, opt.default);
            else program.option(flagStr, opt.description || '', opt.default);
        }
        return program;
    },

    _flagString(opt) {
        let flag = opt.flag || '';
        let label = opt.label || '';
        if (flag && !flag.startsWith('-')) flag = `--${flag}`;
        if (label && label.startsWith('<') && label.endsWith('>')) {
            if (!flag.includes(' ')) flag = `${flag} ${label}`;
        }
        return flag || label;
    },

    _typeParser(opt) {
        if (opt.type === 'int') {
            return (v) => {
                const n = parseInt(v, 10);
                if (isNaN(n)) throw new Error(`Must be an integer`);
                return n;
            };
        }
        if (opt.type === 'float') {
            return (v) => {
                const n = parseFloat(v);
                if (isNaN(n)) throw new Error(`Must be a number`);
                return n;
            };
        }
        if (opt.type === 'array') {
            return (v, prev = []) =>
                v.includes(',') ? v.split(',').map((s) => s.trim()) : [...prev, v];
        }
        if (opt.choices) {
            const choices = new Set(opt.choices);
            return (v) => {
                if (!choices.has(v)) throw new Error(`Must be one of: ${opt.choices.join(', ')}`);
                return v;
            };
        }
        const flagStr = this._flagString(opt);
        if (/\s<[^>]+>/.test(flagStr) || /\s\[[^\]]+\]/.test(flagStr)) return (v) => v;
        return null;
    },

    wantsHelp(args) {
        return args.includes('--help') || args.includes('-h');
    },

    printHelp(meta) {
        const { name, description, usage = '', options = [] } = meta;
        console.log(`${name}: ${description}`);
        if (usage) console.log(`  Usage: ${usage}`);
        for (const opt of options) {
            const flag = opt.flag ? `--${opt.flag}` : '';
            const label = [flag, opt.label].filter(Boolean).join('  ');
            console.log(`  ${label.padEnd(20)}${opt.description || ''}`);
        }
    },

    parse(argv = [], options = []) {
        const { Command } = require('commander');
        const program = new Command();
        program.exitOverride();
        program.allowUnknownOption(false);
        program.allowExcessArguments();
        program.helpOption(false);

        for (const opt of options) {
            const flagStr = this._flagString(opt);
            const desc = opt.description || '';
            const def = opt.default;
            const parser = this._typeParser(opt);
            const action = parser
                ? program.option(flagStr, desc, parser, def)
                : program.option(flagStr, desc, def);
            if (opt.alias) action.short(opt.alias);
        }

        let parseError = null;
        try {
            program.parse(['node', 'rarebert', ...argv]);
        } catch (err) {
            parseError = err;
        }

        if (parseError) {
            const msg = parseError.message || String(parseError);
            if (parseError.code === 'commander.help') return { flags: {}, positional: [] };
            throw new AbortError(msg, 1);
        }

        const flags = { ...program.opts() };
        const positional = program.args.slice();
        return { flags, positional };
    }
};

// The lowercase `tui` singleton object was removed — lib/module.mjs now
// contains class definitions only. The shared prompt instance lives in
// lib/tui.mjs as a real TUI class instance; confirm/input/select/
// runInteractively are member methods inherited from the Module/CLI/TUI
// class chain.
