import Enquirer from 'enquirer';
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
        rarebert.assertProjectRoot();
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
        const { initial = 0, nonInteractiveBehavior = 'fail' } = options;
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
            initial
        });
        try {
            return await prompt.run();
        } catch {
            throw new AbortError();
        }
    }

    parseArgs(argv, spec = {}) {
        const { flags = [], positional = [], greedy = false } = spec;
        const flagSet = new Set(flags);
        const result = { flags: {}, positional: [] };
        let i = 0;
        while (i < argv.length) {
            const arg = argv[i];
            if (arg.startsWith('--')) {
                const key = arg.replace(/^--/, '');
                if (flagSet.has(key)) {
                    result.flags[key] = true;
                    i++;
                    continue;
                }
                if (key.includes('=')) {
                    const [k, v] = key.split('=', 2);
                    result.flags[k] = v;
                    i++;
                    continue;
                }
            }
            if (greedy && result.positional.length >= positional.length) {
                result.positional.push(arg);
                i++;
                continue;
            }
            const slot = positional[result.positional.length];
            if (slot) result.positional.push(arg);
            i++;
        }
        return result;
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

    run(meta, main) {
        return async (args = []) => {
            if (this.wantsHelp(args)) {
                this.printHelp(meta);
                return;
            }
            try {
                return await main(args);
            } catch (err) {
                if (err && err.name === 'AbortError') this.abort();
                this.die(err?.message || String(err));
            }
        };
    }
}

const cli = new Cli();

export { Cli, cli, AbortError, EXIT_OK, EXIT_FAIL, EXIT_ABORT };
export default cli;
