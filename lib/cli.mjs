import Enquirer from 'enquirer';
import { Command, Option, InvalidArgumentError } from 'commander';
import { rarebert } from './projects.mjs';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ABORT = 130;

class AbortError extends Error {
    constructor() {
        super('Aborted');
        this.name = 'AbortError';
    }
}

class Cli {
    constructor() {
        this.abortCallbacks = [];
        this.handlersInstalled = false;
        this.aborting = false;
        this.width = process.stdout.columns || 80;
    }

    truncate(str, max = this.width) {
        return str.length > max ? str.slice(0, max - 1) + '…' : str;
    }

    onAbort(callback) {
        if (typeof callback === 'function') this.abortCallbacks.push(callback);
        return () => {
            const i = this.abortCallbacks.indexOf(callback);
            if (i >= 0) this.abortCallbacks.splice(i, 1);
        };
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

    installSignalHandlers() {
        if (this.handlersInstalled) return;
        // rarebert.assertProjectRoot();
        this.handlersInstalled = true;
        const handler = () => {
            if (this.aborting) process.exit(EXIT_ABORT);
            this.aborting = true;
            this.runAbortCallbacks();
            process.exit(EXIT_ABORT);
        };
        process.on('SIGINT', () => handler());
        process.on('SIGHUP', () => handler());
        process.on('SIGTERM', () => handler());
        process.on('exit', () => this.runAbortCallbacks());
    }

    die(message, code = EXIT_FAIL) {
        if (message) {
            if (code === EXIT_OK) console.log(message);
            else console.error(message);
        }
        this.aborting = true;
        this.runAbortCallbacks();
        process.exit(code);
    }

    abort(message = '\nAborted.') {
        this.die(message, EXIT_ABORT);
    }

    ok(message) {
        if (message) console.dir(message);
        this.die(null, EXIT_OK);
    }

    fail(message) {
        this.die(message, EXIT_FAIL);
    }

    isInteractive() {
        return process.stdin.isTTY === true;
    }

    nonInteractive(message, code = EXIT_FAIL) {
        console.error(`Non-interactive; ${message}`);
        this.aborting = true;
        this.runAbortCallbacks();
        process.exit(code);
    }

    async confirm(message, initial = false) {
        if (!this.isInteractive()) return initial;
        const prompt = new Enquirer.Confirm({ name: 'confirm', message, initial });
        try {
            return await prompt.run();
        } catch {
            throw new AbortError();
        }
    }

    async input(message, options = {}) {
        const { initial = '', validate = null, nonInteractiveBehavior = 'fail' } = options;
        if (!this.isInteractive()) {
            if (nonInteractiveBehavior === 'fail') this.nonInteractive('cannot prompt for input.');
            return initial;
        }
        const prompt = new Enquirer.Input({ name: 'input', message, initial, validate });
        try {
            const result = await prompt.run();
            return result?.trim() || initial;
        } catch {
            throw new AbortError();
        }
    }

    async select(message, choices, options = {}) {
        const { initial = 0, limit = 10, nonInteractiveBehavior = 'fail' } = options;
        if (!this.isInteractive()) {
            if (nonInteractiveBehavior === 'fail')
                this.nonInteractive('cannot prompt for selection.');
            const choice = choices[initial];
            return typeof choice === 'string' ? choice : choice.name;
        }
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
    }

    /**
     * Parse argv against a Commander-derived schema built from `options`.
     *
     * Each option entry supports the following shapes (all optional except `flag`):
     *   { flag: '--verbose' }                       — boolean flag
     *   { flag: '--model <id>' }                   — string-valued option
     *   { flag: '--count <n>', type: 'int' }       — integer option
     *   { flag: '--list <items>', type: 'array' }  — repeatable / comma-list
     *   { flag: '--mode <m>', choices: ['a','b'] } — enumerated option
     *   { flag: '--port <p>', default: '4096' }     — with a default
     *   { flag: '-v, --verbose' }                   — with short alias
     *   { flag: '--debug', alias: 'd' }           — alternative alias form
     *   { flag: '--entry', label: '<file>' }       — legacy meta.options style
     *
     * Returns { flags: {...}, positional: [...] } where `flags` maps each
     * option's camelCase name to its parsed value (absent = undefined).
     *
     * @param {string[]} argv
     * @param {Array} options — array of option descriptors
     * @returns {{ flags: object, positional: string[] }}
     */
    parse(argv = [], options = []) {
        const program = new Command();
        program.exitOverride(); // prevent Commander from calling process.exit
        program.allowUnknownOption(false);
        program.allowExcessArguments(); // accept positional args without a .argument() spec
        program.helpOption(false); // we handle --help ourselves

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

        // Suppress Commander's output on parse errors so we can handle them.
        let parseError = null;
        try {
            program.parse(['node', 'rarebert', ...argv]);
        } catch (err) {
            parseError = err;
        }

        if (parseError) {
            const msg = parseError.message || String(parseError);
            if (parseError.code === 'commander.help') return { flags: {}, positional: [] };
            this.die(msg, EXIT_FAIL);
        }

        const flags = { ...program.opts() };
        const positional = program.args.slice();
        return { flags, positional };
    }

    /**
     * Create a reusable Commander instance for a module with subcommands.
     *
     * @param {{ name: string, description: string, usage?: string, options: Array }} meta
     * @returns {Command}
     */
    createCommand(meta) {
        const program = new Command();
        program.name(meta.name).description(meta.description).exitOverride();
        program.helpOption(false);
        // Modules whose CLI uses raw `--flag` subcommands (e.g. memo's
        // `--add <path> <memo> ...` groups) need unknown options passed
        // through to `positional` so their own grouping logic can run.
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

    /**
     * Build a Commander-compatible flag string from an option descriptor.
     *
     * Handles legacy `flag` without `--` prefix and `label` with `<value>`.
     */
    _flagString(opt) {
        let flag = opt.flag || '';
        let label = opt.label || '';

        // Legacy: flag is bare like 'force' or 'verbose' — needs -- prefix
        if (flag && !flag.startsWith('-')) flag = `--${flag}`;

        // Legacy: label is '<file>' — append as value placeholder
        if (label && label.startsWith('<') && label.endsWith('>')) {
            if (!flag.includes(' ')) flag = `${flag} ${label}`;
        }

        // Ensure the flag string is well-formed (e.g. '--entry <file>')
        return flag || label;
    }

    /**
     * Return a Commander value-parser function for typed options, or null
     * for plain boolean flags.
     */
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
        // If the flag string includes a <placeholder>, it's a value option
        const flagStr = this._flagString(opt);
        if (/\s<[^>]+>/.test(flagStr) || /\s\[[^\]]+\]/.test(flagStr)) {
            return (v) => v; // identity string parser
        }
        return null; // boolean
    }

    wantsHelp(args) {
        return args.includes('--help') || args.includes('-h');
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

    /**
     * Build a Commander program from `meta`, wire `main` as its action
     * callback, and return a runner suitable for `export default { main }`.
     *
     * The `main` callback receives `(opts, positional)` where:
     *   - `opts`     = the parsed options object (Commander's `program.opts()`)
     *   - `positional` = the remaining positional arguments (`program.args`)
     *
     * If `meta.subcommands` is provided, they are registered as Commander
     * subcommands instead of a single action. Each subcommand entry is
     *   { name, description, options: [...], action: async (opts, positional) => {} }
     *
     * --help / -h is handled by Commander's built-in help output.
     *
     * @param {{ name: string, description: string, usage?: string, options?: Array, subcommands?: Array }} meta
     * @param {Function} main - callback `(opts, positional) => Promise|any`
     * @returns {Function} async runner `(args = []) => Promise`
     */
    run(meta, main) {
        return async (args = []) => {
            const program = this.createCommand(meta);

            if (meta.subcommands) {
                for (const sub of meta.subcommands) {
                    const cmd = program.command(sub.name).description(sub.description || '');
                    cmd.allowExcessArguments();
                    cmd.exitOverride();
                    cmd.helpOption(false);
                    for (const opt of sub.options || []) {
                        const flagStr = this._flagString(opt);
                        const parser = this._typeParser(opt);
                        if (parser) cmd.option(flagStr, opt.description || '', parser, opt.default);
                        else cmd.option(flagStr, opt.description || '', opt.default);
                    }
                    cmd.action(async () => {
                        const opts = cmd.opts();
                        const positional = cmd.args.slice();
                        try {
                            await sub.action(opts, positional);
                        } catch (err) {
                            if (err && err.name === 'AbortError') this.abort();
                            this.die(err?.message || String(err));
                        }
                    });
                }
            } else {
                program.action(async () => {
                    const opts = program.opts();
                    const positional = program.args.slice();
                    try {
                        return await main(opts, positional);
                    } catch (err) {
                        if (err && err.name === 'AbortError') this.abort();
                        this.die(err?.message || String(err));
                    }
                });
            }

            // --help is handled by Commander when helpOption is true; we
            // intercept it here since we disable it for custom formatting.
            // Modules that handle help themselves (e.g. the dispatcher) can
            // set `meta.skipHelpIntercept` to bypass this.
            if (!meta.skipHelpIntercept && this.wantsHelp(args)) {
                program.outputHelp();
                return;
            }

            try {
                await program.parseAsync(['node', meta.name || 'rarebert', ...args]);
            } catch (err) {
                if (err && err.name === 'AbortError') this.abort();
                const msg = err?.message || String(err);
                if (err?.code === 'commander.help') return;
                this.die(msg, EXIT_FAIL);
            }
        };
    }
}

const cli = new Cli();

export { Cli, cli, AbortError, EXIT_OK, EXIT_FAIL, EXIT_ABORT };
export default cli;
