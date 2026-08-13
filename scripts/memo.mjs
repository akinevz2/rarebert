#!/usr/bin/env node

import { CLI, listAllModules, resolveModuleSet } from '../lib/module.mjs';
import {
    memo,
    groupArgs,
    cmdAdd,
    cmdCommit,
    cmdLog,
    cmdRecall,
    cmdDrop,
    cmdForget,
    cmdPrintSet,
    cmdBare,
    printDagForSet
} from '../lib/memo.mjs';

const META = {
    name: 'memo',
    description: 'Inspect and mutate memos stored alongside modules',
    usage: 'node index.js memo [files...|--all|--add <path> <memo>...|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]]',
    allowUnknownOption: true,
    options: [
        {
            flag: '--all',
            description: 'Print all memos (flat, oldest-first); with files, ancestor-traversal'
        },
        { flag: '--yes', description: 'Skip confirmation for --commit' },
        { flag: '--fresh', description: 'Clear working sidecars after --commit' },
        { flag: '--verbose', description: 'Verbose output' }
    ]
};

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(opts, positional) {
    // `--add`, `--commit`, `--log`, `--recall`, `--drop`, and `--forget`
    // are "action" subcommands: with `meta.allowUnknownOption` they pass
    // through Commander into `positional` so groupArgs can preserve their
    // argument grouping. The boolean toggles (--all/--yes/--fresh/--verbose)
    // are declared options and arrive on `opts`.
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

    if (opts.all) {
        if (nonFlag.length) {
            const resolvedSet = resolveModuleSet(nonFlag, modules);
            cmdPrintSet(resolvedSet, true);
        } else {
            printDagForSet(null);
        }
        return;
    }

    if (nonFlag.length) {
        const resolvedSet = resolveModuleSet(nonFlag, modules);
        cmdPrintSet(resolvedSet, false);
        return;
    }

    await cmdBare(modules);
}

export default new CLI('memo.mjs', main, META).supportsDirectRunning(import.meta.url);