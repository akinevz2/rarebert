#!/usr/bin/env node

import { CLI, listAllModules, resolveModuleSet } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import {
    memo,
    groupArgs,
    cmdAdd,
    cmdCommit,
    cmdLog,
    cmdRecall,
    cmdDrop,
    cmdForget,
    cmdPrintAll,
    cmdPrintSet
} from '../lib/memo.mjs';

const META = {
    name: 'memo',
    description:
        'Print or manage memos. Default (no flags): print memos — all, or scoped to file args. Mutating flags: --add, --drop, --forget, --commit, --recall, --log.',
    usage:
        'node index.js memo [files...] [--add <path> <memo>...|--drop <path> [indices]|--forget <path>...|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]|--json',
    allowUnknownOption: true,
    options: [
        { flag: '--yes', description: 'Skip confirmation for --commit' },
        { flag: '--fresh', description: 'Clear working sidecars after --commit' },
        { flag: '--verbose', description: 'Verbose output' },
        { flag: '--json', description: 'Output memos as JSON instead of DAG format' }
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
        return await cmdAdd(groups, modules);
    }

    if (has('--commit')) {
        return await cmdCommit(opts.yes, opts.fresh);
    }

    if (has('--log')) {
        return await cmdLog(nonFlag);
    }

    if (has('--recall')) {
        return await cmdRecall(nonFlag[0], nonFlag.slice(1));
    }

    if (has('--drop')) {
        const result = await cmdDrop(nonFlag[0], nonFlag[1], modules);
        memo.clearBuffer();
        return result;
    }

    if (has('--forget')) {
        return await cmdForget(nonFlag, modules);
    }

    if (has('--json')) {
        const all = memo.loadAllMemos();
        if (!all.length) {
            return exit(1, 'no memos');
        }
        console.log(JSON.stringify(all, null, 2));
        return exit(0);
    }

    // Default: print memos as a DAG. No file args → whole-repo DAG
    // (root-level paths bold, ancestors dim). File args → DAG scoped
    // to those files + ancestors.
    if (nonFlag.length === 0) {
        cmdPrintAll(true);
    } else {
        const resolved = resolveModuleSet(nonFlag, modules);
        if (resolved.length === 0) {
            console.error(`No modules matched: ${nonFlag.join(', ')}`);
            return exit(1);
        }
        cmdPrintSet(resolved, true);
    }
    return exit(0);
}

export default new CLI('memo.mjs', main, META).supportsDirectRunning(import.meta.url);