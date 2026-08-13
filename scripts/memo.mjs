#!/usr/bin/env node

import { CLI, listAllModules } from '../lib/module.mjs';
import {
    memo,
    groupArgs,
    cmdAdd,
    cmdCommit,
    cmdLog,
    cmdRecall,
    cmdDrop,
    cmdForget,
    cmdBare
} from '../lib/memo.mjs';

const META = {
    name: 'memo',
    description: 'Enter memos: add, drop, forget, commit, recall, or log. Use `make check` to display memos.',
    usage: 'node index.js memo [--add <path> <memo>...|--drop <path> [indices]|--forget <path>...|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]]',
    allowUnknownOption: true,
    options: [
        { flag: '--yes', description: 'Skip confirmation for --commit' },
        { flag: '--fresh', description: 'Clear working sidecars after --commit' },
        { flag: '--verbose', description: 'Verbose output' }
    ]
};

async function main(opts, positional) {
    const ACTION_FLAGS = new Set(['--add', '--commit', '--log', '--recall', '--drop', '--forget']);

    const groups = groupArgs(positional);
    const actionFlagsPresent = positional.filter((a) => ACTION_FLAGS.has(a));
    const nonFlag = positional.filter((a) => (!a.startsWith('-') || /^-?\d+$/.test(a)) && a);
    const modules = listAllModules();

    const has = (f) => actionFlagsPresent.includes(f);

    if (has('--add')) {
        await cmdAdd(groups, modules);
        return;
    }

    if (has('--commit')) {
        await cmdCommit(opts.yes, opts.fresh);
        return;
    }

    if (has('--log')) {
        cmdLog(nonFlag);
        return;
    }

    if (has('--recall')) {
        cmdRecall(nonFlag[0], nonFlag.slice(1));
        return;
    }

    if (has('--drop')) {
        await cmdDrop(nonFlag[0], nonFlag[1], modules);
        memo.clearBuffer();
        return;
    }

    if (has('--forget')) {
        cmdForget(nonFlag, modules);
        return;
    }

    await cmdBare(modules);
}

export default new CLI('memo.mjs', main, META).supportsDirectRunning(import.meta.url);