#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { CLI } from '../lib/module.mjs';
import { load } from '../lib/analyze.mjs';

const meta = {
    name: 'analyze',
    description:
        'Analyze a module: record imports (foo::mod / foo<-mod / mod notation), segment the main() function into whitespace-delimited blocks via opencode, document each block, and memoize the documentation. Falls back to documenting public members when no main() exists.',
    usage: 'node index.js analyze <module> [--yes] [-v]',
    options: [
        { flag: '-v, --verbose', description: 'Verbose output' },
        { flag: '-y, --yes', description: 'Skip confirmation prompts' }
    ]
};

export { meta };

export default new CLI('analyze.mjs', async (opts = {}, positional = []) => {
    const args = Array.isArray(positional) ? positional : [];
    if (args.length === 0) {
        console.error('Usage: node index.js analyze <module> [--yes] [-v]');
        return exit(1);
    }

    const moduleArg = args[0];
    const verbose = !!opts.verbose;
    const yes = !!opts.yes;

    try {
        await load(moduleArg, { verbose, yes });
    } catch (err) {
        console.error('Error:', err.message);
        return exit(1);
    }

    return exit(0);
}, meta).supportsDirectRunning(import.meta.url);