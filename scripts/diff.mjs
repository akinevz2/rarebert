#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { PROJECT_ROOT } from '../lib/core.mjs';
import * as git from '../lib/git.mjs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { relPath } from '../lib/libs.mjs';

function showDiff(diffArgs, usePager) {
    const result = git.git('diff', diffArgs);
    if (result.status !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        return result.status ?? 1;
    }
    if (!result.stdout.trim()) {
        console.error('(no changes)');
        return 0;
    }
    if (!usePager) {
        process.stdout.write(result.stdout);
        return 0;
    }
    const pager = process.env.PAGER || 'less';
    const child = spawnSync(pager, [], {
        input: result.stdout,
        stdio: ['pipe', 'inherit', 'inherit']
    });
    if (child.error) {
        process.stderr.write(`Failed to launch pager (${pager}): ${child.error.message}\n`);
        process.stdout.write(result.stdout);
    }
    return child.status ?? 0;
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('diff: Show working-tree changes (or staged) in a pager');
        console.error('  Usage: node index.js diff [--staged] [--stat] [module]');
        console.error('  --staged   show only staged (cached) changes');
        console.error('  --stat     show diffstat only');
        console.error('  module     restrict to a single module (by name)');
        console.error('  Falls back to stdout when not a TTY or no pager is available.');
        return;
    }

    const staged = args.includes('--staged');
    const stat = args.includes('--stat');
    const nonFlag = args.filter(a => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];

    let pathspecs = [];
    if (moduleArg) {
        const target = await promptModule(listAllModules(), moduleArg, 'Select a module to diff');
        pathspecs = [relPath(target.path)];
    }

    const diffArgs = [];
    if (!staged) diffArgs.push('HEAD');
    if (staged) diffArgs.push('--cached');
    if (stat) diffArgs.push('--stat');
    diffArgs.push(...pathspecs);

    const usePager = process.stdin.isTTY === true && process.stdout.isTTY === true;
    const status = showDiff(diffArgs, usePager);
    process.exit(status);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main };

export default {
    name: 'diff',
    description: 'Show working-tree changes (or staged) in a pager',
    main
};