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
    // Backwards-compat bridge: Runtime passes a single ModuleArguments as
    // both params. `positional` is the same ModuleArguments instance.
    const ma = positional instanceof ModuleArguments ? positional : ModuleArguments.from(positional || [], args || {});
    const groups = groupArgs(ma);
    const nonFlag = ma.nonFlag();
    const modules = listAllModules();

    if (ma.has('--add')) {
        return await cmdAdd(groups, modules);
    }

    if (ma.has('--commit')) {
        return await cmdCommit(ma.bool('yes'), ma.bool('fresh'));
    }

    if (ma.has('--log')) {
        return await cmdLog(nonFlag);
    }

    if (ma.has('--recall')) {
        return await cmdRecall(nonFlag[0], nonFlag.slice(1));
    }

    if (ma.has('--drop')) {
        const result = await cmdDrop(nonFlag[0], nonFlag[1], modules);
        memo.clearBuffer();
        return result;
    }

    if (ma.has('--forget')) {
        return await cmdForget(nonFlag, modules);
    }

    if (ma.has('--json')) {
        const all = memo.loadAllMemos();
        if (!all.length) {
            return exit(1, 'no memos');
        }
        console.log(JSON.stringify(all, null, 2));
        return exit(0);
    }

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
