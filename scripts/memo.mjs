#!/usr/bin/env node

import { CLI, listAllModules, resolveModuleSet } from '../lib/module.mjs';
import { exit, ModuleArguments } from '../lib/core.mjs';
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

async function main(args = ModuleArguments.prototype, positional) {
    const ma = positional instanceof ModuleArguments ? positional : ModuleArguments.from(positional || [], args || {});
    const groups = groupArgs(ma);
    const nonFlag = ma.nonFlag();
    const modules = listAllModules();
    const json = ma.bool('json');

    if (ma.has('--add')) {
        return exit(0, () => cmdAdd(groups, modules));
    }

    if (ma.has('--commit')) {
        return exit(0, () => cmdCommit(ma.bool('yes'), ma.bool('fresh')));
    }

    if (ma.has('--log')) {
        return exit(0, () => cmdLog(nonFlag));
    }

    if (ma.has('--recall')) {
        return exit(0, () => cmdRecall(nonFlag[0], nonFlag.slice(1)));
    }

    if (ma.has('--drop')) {
        const mod = cmdDrop(nonFlag[0], nonFlag[1], modules);
        memo.clearBuffer();
        return exit(0, () => mod);
    }

    if (ma.has('--forget')) {
        return exit(0, () => cmdForget(nonFlag, modules));
    }

    // List-only: default DAG or --json
    if (nonFlag.length === 0) {
        return exit(0, () => cmdPrintAll(true));
    }
    const resolved = resolveModuleSet(nonFlag, modules);
    if (resolved.length === 0) {
        console.error(`No modules matched: ${nonFlag.join(', ')}`);
        return exit(1);
    }
    return exit(0, () => cmdPrintSet(resolved, true));
}

export default new CLI('memo.mjs', main, META).supportsDirectRunning(import.meta.url);
