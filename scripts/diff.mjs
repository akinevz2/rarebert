#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { listAllModules, promptModule, CLI } from '../lib/module.mjs';
import { libs } from '../lib/libs.mjs';
import { git } from '../lib/git.mjs';

/**
 * Run `git diff --color=always` with the given args and optionally
 * pipe through the pager. Returns the exit status.
 */
function showDiff(diffArgs, usePager) {
    const result = git.git('diff', ['--color=always', ...diffArgs]);
    if (result.status !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        return result.status ?? 1;
    }
    if (!result.stdout.trim()) {
        console.log('(no changes)');
        return 0;
    }
    if (!usePager) {
        process.stdout.write(result.stdout);
        return 0;
    }
    return git.pipeToPager(result.stdout);
}

const meta = {
    name: 'diff',
    description: 'Show working-tree changes (or staged) in a pager',
    usage: 'node index.js diff [--staged] [--stat] [module]',
    options: [
        { flag: '--staged', description: 'Show staged (cached) changes' },
        { flag: '--stat', description: 'Show diffstat summary only' }
    ]
};

export { meta };

export default new CLI(
    'diff.mjs',
    async (opts, positional) => {
        const staged = opts.staged;
        const stat = opts.stat;
        const moduleArg = positional[0];

        let pathspecs = [];
        if (moduleArg) {
            const target = await promptModule(
                listAllModules(),
                moduleArg,
                'Select a module to diff'
            );
            pathspecs = [libs.relPath(target.path)];
        }

        const diffArgs = [];
        if (!staged) diffArgs.push('HEAD');
        if (staged) diffArgs.push('--cached');
        if (stat) diffArgs.push('--stat');
        diffArgs.push(...pathspecs);

        const usePager = process.stdin.isTTY === true && process.stdout.isTTY === true;
        const status = showDiff(diffArgs, usePager);
        return exit(status);
    },
    meta
).supportsDirectRunning(import.meta.url);
