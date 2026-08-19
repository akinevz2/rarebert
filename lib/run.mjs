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
            if (callbackResult instanceof ExitSignal) {
                return callbackResult;
            }
            if (callbackResult && typeof callbackResult.execute === 'function') {
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

class Runtime {
    constructor(module) {
        this.module = module;
    }

    async execute(args = []) {
        for (;;) {
            const result = await this.module.execute(args);
            const completed = await result.complete();
            if (completed && typeof completed.execute === 'function') {
                this.module = completed;
                args = [];
                continue;
            }

            const { exitCode, producedResult } = completed;

            if (producedResult !== undefined && producedResult !== null) {
                if (exitCode === 0) {
                    console.dir(producedResult);
                } else {
                    console.error(producedResult);
                }
            }

            return exitCode;
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
            const opts = program.opts();
            const positional = program.args.slice();
            try {
                const validationErr = Runtime.validateArgs(meta.args, positional, meta.name);
                if (validationErr) {
                    capture(validationErr);
                    return;
                }
                capture(await main(opts, positional));
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
        program.name(meta.name).description(meta.description).exitOverride();
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
