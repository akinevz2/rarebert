import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { rarebert } from './projects.mjs';
import { listAllModules } from './module.mjs';

let _srcDir;
let _defaultModule;
function srcDir() {
    return _srcDir ??= path.join(rarebert.root, 'src');
}
function defaultModule() {
    return _defaultModule ??= path.join(srcDir(), 'main.py');
}

function rel(p) {
    return path.relative(rarebert.root, p);
}

function runProcess(cmd, args) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
        stdio: 'inherit',
        cwd: rarebert.root
    });
    child.on('error', (err) => {
        console.error(`Failed to launch ${cmd}: ${err.message}`);
        return exit(`Failed to launch ${cmd}: ${err.message}`);
    });
    child.on('exit', (code) => process.exit(code ?? 0));
}

function findJsModule(name) {
    const normalized = rarebert.normalizeModuleName(name);
    return listAllModules().find(
        (s) =>
            (s.ext === '.mjs' || s.ext === '.js') &&
            rarebert.normalizeModuleName(s.name) === normalized
    );
}

function findPyModule(name) {
    const candidates = [
        path.join(srcDir(), name.endsWith('.py') ? name : `${name}.py`),
        path.isAbsolute(name) ? name : null
    ].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p));
}

// ---------------------------------------------------------------------------
// Runtime / exit / ExitSignal system (moved from lib/core.mjs).
//
// ExitSignal represents the result of a module execution. It wraps an
// exit code, a produced value, and an optional onExit callback. The
// callback may return a Module (for re-execution loop) or another
// ExitSignal (for nested exit routing — see complete()).
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ABORT = 130;

/**
 * ExitSignal represents the result of a module execution.
 * It can wrap an exit code, a submodule (CLI/TUI instance), or an onExit callback.
 */
class ExitSignal {
    constructor(exitCode = 0, producedResult = undefined, onExit = undefined) {
        this.exitCode = exitCode;
        this.producedResult = producedResult;
        this.onExit = onExit;
    }

    async complete() {
        if (typeof this.onExit === 'function') {
            const callbackResult = await this.onExit(this.producedResult);
            // Return the callback's result only when it's something Runtime
            // can act on — a runnable Module (meta + main) or another
            // ExitSignal. For anything else (42, undefined, a string), fall
            // back to `this` so Runtime reads this signal's exitCode.
            if (callbackResult instanceof ExitSignal) return callbackResult;
            if (callbackResult && typeof callbackResult === 'object' && callbackResult.meta && typeof callbackResult.main === 'function') {
                return callbackResult;
            }
        }
        return this;
    }
}

class HelpRequestedSignal extends Error {
    constructor() {
        super('Help requested');
        this.name = 'HelpRequestedSignal';
    }
}

/**
 * ModuleArguments — the single object passed to a module's `main(args)`.
 * It is an Array subclass (so `args[0]`, `args.length`, `args.slice()`,
 * `args.filter()` work for positional operands) with the parsed Commander
 * option keys merged directly onto it via Object.assign, so:
 *   - `args.verbose`      → the parsed --verbose value
 *   - `'verbose' in args` → true when --verbose was declared
 *   - `args[0]`           → the first positional operand
 *   - `args.has('--add')` → standardized flag-presence check
 *
 * `Runtime.buildActionHandler` constructs one from `(program.args, program.opts())`
 * and passes it as the sole argument to main. For backwards compatibility with
 * the old `main(opts, positional)` signature, buildActionHandler passes the
 * same ModuleArguments instance as BOTH parameters, so legacy code that
 * destructures `(opts, positional)` keeps working (opts.trace ✓, positional[0] ✓).
 */
class ModuleArguments extends Array {
    /**
     * Build a ModuleArguments from a positional array + the opts object.
     * The opts keys are merged onto the instance via Object.assign so the
     * `in` operator and direct key access work. Use this instead of
     * `new ModuleArguments(...)` to preserve Array subclass semantics.
     */
    static from(positional, opts) {
        const inst = super.from(Array.isArray(positional) ? positional : []);
        inst._opts = opts || {};
        Object.assign(inst, inst._opts);
        return inst;
    }

    /** The raw Commander opts object (`{ verbose: true, trace: '...' }`). */
    get opts() {
        return this._opts;
    }

    /**
     * True if a flag is present — either as a parsed option key merged
     * onto this instance (e.g. `args.verbose`) or as a literal `--flag`
     * token still present in the positional array (for `allowUnknownOption`
     * modules). Replaces the ad-hoc `const has = (f) => arr.includes(f)`.
     */
    has(flag) {
        const key = flag.replace(/^--?/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (this._opts[key] !== undefined && this._opts[key] !== false) return true;
        return this.includes(flag);
    }

    /** Boolean coercion of an option (`!!opts[name]`). */
    bool(name) {
        return !!this._opts[name];
    }

    /** Get an option value, or `fallback` (default null) when unset. */
    get(name, fallback = null) {
        return this._opts[name] ?? fallback;
    }

    /** First positional arg (`this[0]`). */
    first() {
        return this[0];
    }

    /** Positional args after the first (`this.slice(1)`). */
    rest() {
        return this.slice(1);
    }

    /**
     * Positional args that are not flags — i.e. real module/path operands.
     * A leading `-` excludes a token unless it is purely numeric (memo
     * `--drop` indices). Mirrors the filter used in scripts/memo.mjs.
     */
    nonFlag() {
        return [...this].filter((a) => (!a.startsWith('-') || /^-?\d+$/.test(a)) && a);
    }
}

class Runtime {
    constructor(module) {
        this.module = module;
    }

    /**
     * Owns the full module execution lifecycle. Runtime IS the runner — it
     * builds the Commander runner from module.meta + module.main directly.
     * For each Module:
     *   1. guard  — module.guard(args) may reject (TUI non-interactive).
     *   2. invoke — Runtime.createRunner(module.meta, module.main)(args),
     *               awaiting its ExitSignal result.
     *   3. decide — result.complete():
     *      - returns a Module → re-execute it (loop), forwarding the SAME
     *        args to the produced Module's main (not reset to []).
     *      - returns an ExitSignal → route producedResult to the right
     *        stream, return the exitCode.
     *   4. cleanup — module.cleanup(args) after a terminal result (TUI
     *               screen-clear). Skipped when looping to a new Module.
     */
    async execute(args = []) {
        for (;;) {
            const mod = this.module;
            if (!mod || !mod.meta || typeof mod.main !== 'function') {
                console.error(`${mod?.path || mod}: module is not runnable (needs meta + main).`);
                return 1;
            }
            if (typeof mod.guard === 'function') await mod.guard(args);
            const runner = Runtime.createRunner(mod.meta, mod.main);
            const result = await runner(args);
            if (!(result instanceof ExitSignal)) {
                console.error(
                    `${mod.path}: main returned ${typeof result} — expected an ExitSignal from exit().`
                );
                return 1;
            }
            const completed = await result.complete();
            if (completed instanceof ExitSignal) {
                // Nested exit — route its producedResult and return its exitCode.
                if (typeof mod.cleanup === 'function') {
                    try { await mod.cleanup(args); } catch { /* never let cleanup throw cascade */ }
                }
                const { exitCode, producedResult } = completed;
                if (producedResult !== undefined && producedResult !== null) {
                    if (exitCode === 0) console.dir(producedResult);
                    else console.error(producedResult);
                }
                return exitCode;
            }
            // complete() returned a runnable Module — re-execute with same args.
            this.module = completed;
            continue;
        }
    }

    /**
     * Test-only: run a Module through the full lifecycle and assert a
     * sane exit branch. Returns { ok, exitCode, threw, error, module, args }.
     * `ok` is false (and `error` set) when the result is undefined/absent
     * or the Module threw. Does NOT print to stdout/stderr — callers
     * (test/modules.test.mjs) inspect the returned report.
     */
    static async assertSaneExit(mod, args = []) {
        const report = { ok: false, exitCode: null, threw: false, error: null, module: mod.path, args };
        try {
            if (!mod || !mod.meta || typeof mod.main !== 'function') {
                report.error = `${mod?.path || mod}: not runnable (needs meta + main)`;
                return report;
            }
            if (typeof mod.guard === 'function') await mod.guard(args);
            const runner = Runtime.createRunner(mod.meta, mod.main);
            const result = await runner(args);
            if (result === undefined || result === null) {
                report.error = `${mod.path}: main returned ${result} — expected an ExitSignal`;
                return report;
            }
            if (!(result instanceof ExitSignal)) {
                report.error = `${mod.path}: main returned ${typeof result}, not ExitSignal`;
                return report;
            }
            const completed = await result.complete();
            if (completed instanceof ExitSignal) {
                const { exitCode, producedResult } = completed;
                if (exitCode === undefined || exitCode === null) {
                    report.error = `${mod.path}: complete() returned exitCode ${exitCode}`;
                    return report;
                }
                report.ok = true;
                report.exitCode = exitCode;
                report.producedResult = producedResult;
                return report;
            }
            // complete() returned a runnable Module.
            report.ok = true;
            report.exitCode = null;
            report.reExecutes = completed.path || true;
            return report;
        } catch (err) {
            report.threw = true;
            report.error = `${mod.path}: threw ${err?.name || 'Error'}: ${err?.message || String(err)}`;
            return report;
        }
    }

    // --- Commander integration helpers ---

    static createRunner(meta, main) {
        return async (args = []) => {
            const program = Runtime.createCommand(meta);
            let actionResult;

            program.action(
                Runtime.buildActionHandler(program, meta, main, (r) => {
                    actionResult = r;
                })
            );

            if (!meta.skipHelpIntercept && Runtime.wantsHelp(args)) {
                program.outputHelp();
                return exit(0);
            }

            try {
                await Runtime.parseArgv(program, meta, args);
            } catch (sig) {
                if (sig instanceof ExitSignal) return sig;
                throw sig;
            }
            return actionResult;
        };
    }

    static buildActionHandler(program, meta, main, capture) {
        return async () => {
            const args = ModuleArguments.from(program.args.slice(), program.opts());
            try {
                const validationErr = Runtime.validateArgs(meta.args, args, meta.name);
                if (validationErr) {
                    capture(validationErr);
                    return;
                }
                // Pass `args` as the sole parameter. For backwards compat with
                // the old `main(opts, positional)` signature, also pass it as
                // both params — legacy destructuring `(opts, positional)`
                // keeps working because args has the opts keys merged on AND
                // is array-indexable for positionals.
                capture(await main(args, args));
            } catch (err) {
                if (err && err.name === 'AbortError') throw err;
                capture(exit(1));
            }
        };
    }

    static async parseArgv(program, meta, args) {
        try {
            await program.parseAsync(['node', meta.name || 'rarebert', ...args]);
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            if (err?.code === 'commander.help') return;
            throw exit(1);
        }
    }

    static validateArgs(argSpec, positional, moduleName) {
        if (!argSpec || !Array.isArray(argSpec)) return null;
        for (let i = 0; i < argSpec.length; i++) {
            const spec = argSpec[i];
            if (spec.required && (positional[i] === undefined || positional[i] === null)) {
                const argList = argSpec
                    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
                    .join(' ');
                return exit(1, () =>
                    console.error(
                        `Missing required argument: <${spec.name}>\nUsage: rarebert ${moduleName} ${argList}`
                    )
                );
            }
        }
        return null;
    }

    static wantsHelp(args) {
        return args.includes('--help') || args.includes('-h');
    }

    static flagString(opt) {
        let flag = opt.flag || '';
        let label = opt.label || '';
        if (flag && !flag.startsWith('-')) flag = `--${flag}`;
        if (label && label.startsWith('<') && label.endsWith('>')) {
            if (!flag.includes(' ')) flag = `${flag} ${label}`;
        }
        return flag || label;
    }

    static typeParser(opt) {
        if (opt.type === 'int') {
            return (v) => {
                const n = parseInt(v, 10);
                if (isNaN(n)) throw new Error('Must be an integer');
                return n;
            };
        }
        if (opt.type === 'float') {
            return (v) => {
                const n = parseFloat(v);
                if (isNaN(n)) throw new Error('Must be a number');
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
        const flagStr = Runtime.flagString(opt);
        if (/\s<[^>]+>/.test(flagStr) || /\s\[[^\]]+\]/.test(flagStr)) {
            return (v) => v;
        }
        return null;
    }

    static createCommand(meta) {
        const program = new Command();
        program.name(meta.name || 'rarebert');
        if (meta.description) program.description(meta.description);
        program.exitOverride();
        program.helpOption(false);
        program.allowUnknownOption(meta.allowUnknownOption === true);
        program.allowExcessArguments();
        if (meta.usage) program.usage(meta.usage);
        for (const opt of meta.options || []) {
            const flagStr = Runtime.flagString(opt);
            const parser = Runtime.typeParser(opt);
            if (parser) program.option(flagStr, opt.description || '', parser, opt.default);
            else program.option(flagStr, opt.description || '', opt.default);
        }
        return program;
    }
}

function exit(exitCodeOrValue, exitResult) {
    if (exitCodeOrValue instanceof ExitSignal) {
        return exitCodeOrValue;
    }

    if (exitCodeOrValue === undefined || exitCodeOrValue === null) {
        return new ExitSignal(0, undefined);
    }

    if (typeof exitCodeOrValue === 'function') {
        return new ExitSignal(0, undefined, exitCodeOrValue);
    }

    if (typeof exitCodeOrValue === 'string') {
        return new ExitSignal(1, exitCodeOrValue);
    }

    if (typeof exitCodeOrValue === 'number') {
        const onExit = typeof exitResult === 'function' ? exitResult : undefined;
        const producedResult = onExit ? undefined : exitResult;
        return new ExitSignal(exitCodeOrValue, producedResult, onExit);
    }

    return new ExitSignal(0, undefined);
}

export {
    EXIT_OK,
    EXIT_FAIL,
    EXIT_ABORT,
    ExitSignal,
    HelpRequestedSignal,
    ModuleArguments,
    Runtime,
    exit,
    srcDir as SRC_DIR,
    defaultModule as DEFAULT_MODULE,
    rel,
    runProcess,
    findJsModule,
    findPyModule
};
export default { runProcess, findJsModule, findPyModule };
