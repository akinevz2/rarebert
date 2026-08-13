#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { CLI } from '../lib/module.mjs';
import { load } from '../lib/analyze.mjs';

const meta = {
    name: 'analyze',
    description:
        'Analyze a module: print imports, main() spans, and public members as a neat list. Launches a TUI module picker when no module is given. Pass --document to run an opencode-based documentation pass that segments main(), documents each block, and memoizes.',
    usage: 'node index.js analyze [module] [--document] [--yes] [-v]',
    args: [{ name: 'module', required: false }],
    options: [
        { flag: '--document', description: 'Run opencode documentation pass (segment, document, memoize)' },
        { flag: '-v, --verbose', description: 'Verbose output' },
        { flag: '-y, --yes', description: 'Skip confirmation prompts' }
    ]
};

export { meta };

export default new CLI('analyze.mjs', async (opts = {}, positional = []) => {
    const args = Array.isArray(positional) ? positional : [];
    const moduleArg = args.length > 0 ? args[0] : null;
    const verbose = !!opts.verbose;
    const yes = !!opts.yes;
    const document = !!opts.document;

    try {
        await load(moduleArg, { verbose, yes, document });
    } catch (err) {
        console.error('Error:', err.message);
        return exit(1);
    }

    return exit(0);
}, meta).supportsDirectRunning(import.meta.url);