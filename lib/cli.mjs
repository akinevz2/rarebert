import Enquirer from 'enquirer';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ABORT = 130;

export function die(message, code = EXIT_FAIL) {
    if (message) console.error(message);
    process.exit(code);
}

export function abort(message = '\nAborted.') {
    die(message, EXIT_ABORT);
}

export function ok(message) {
    if (message) console.error(message);
    process.exit(EXIT_OK);
}

export function fail(message) {
    die(message, EXIT_FAIL);
}

export function isInteractive() {
    return process.stdin.isTTY === true;
}

export function nonInteractive(message, code = EXIT_FAIL) {
    console.error(`Non-interactive; ${message}`);
    process.exit(code);
}

export async function confirm(message, initial = false) {
    if (!isInteractive()) return initial;
    const prompt = new Enquirer.Confirm({ name: 'confirm', message, initial });
    try {
        return await prompt.run();
    } catch {
        abort();
    }
}

export async function input(message, options = {}) {
    const { initial = '', validate = null, nonInteractiveBehavior = 'fail' } = options;
    if (!isInteractive()) {
        if (nonInteractiveBehavior === 'fail') nonInteractive('cannot prompt for input.');
        return initial;
    }
    const prompt = new Enquirer.Input({ name: 'input', message, initial, validate });
    try {
        const result = await prompt.run();
        return result?.trim() || initial;
    } catch {
        abort();
    }
}

export async function select(message, choices, options = {}) {
    const { initial = 0, nonInteractiveBehavior = 'fail' } = options;
    if (!isInteractive()) {
        if (nonInteractiveBehavior === 'fail') nonInteractive('cannot prompt for selection.');
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
        abort();
    }
}

export function parseArgs(argv, spec = {}) {
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
        if (slot) {
            result.positional.push(arg);
        }
        i++;
    }
    return result;
}

export function wantsHelp(args) {
    return args.includes('--help') || args.includes('-h');
}

export function printHelp(meta) {
    const { name, description, usage = '', options = [] } = meta;
    console.error(`${name}: ${description}`);
    if (usage) console.error(`  Usage: ${usage}`);
    for (const opt of options) {
        const flag = opt.flag ? `--${opt.flag}` : '';
        const label = [flag, opt.label].filter(Boolean).join('  ');
        console.error(`  ${label.padEnd(20)}${opt.description || ''}`);
    }
}

export function run(meta, main) {
    return async function entry(args = []) {
        if (wantsHelp(args)) {
            printHelp(meta);
            return;
        }
        try {
            await main(args);
        } catch (err) {
            if (err && err.name === 'AbortError') {
                abort();
            }
            die(err?.message || String(err));
        }
    };
}

export class AbortError extends Error {
    constructor() {
        super('Aborted');
        this.name = 'AbortError';
    }
}

export default {
    die,
    abort,
    ok,
    fail,
    confirm,
    input,
    select,
    parseArgs,
    wantsHelp,
    printHelp,
    run,
    isInteractive,
    nonInteractive,
    AbortError,
    EXIT_OK,
    EXIT_FAIL,
    EXIT_ABORT
};
