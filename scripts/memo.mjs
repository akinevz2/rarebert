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
    cmdForgetOldest,
    cmdOldest,
    cmdPrintAll,
    cmdPrintSet
} from '../lib/memo.mjs';

const META = {
    name: 'memo',
    description:
        'Print or manage memos. Default (no flags): print memos — all, or scoped to file args. Mutating flags: --add, --drop, --forget, --commit, --recall, --log. --oldest prints the most-forgotten memo (DAG order); --forget --oldest drops exactly that one.',
    usage: 'node index.js memo [files...] [--oldest|--add <path> <memo>...|--drop <path> [indices]|--forget [--oldest|<path>...]|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]]',
    allowUnknownOption: true,
    options: [
        { flag: '--yes', description: 'Skip confirmation for --commit' },
        { flag: '--fresh', description: 'Clear working sidecars after --commit' },
        { flag: '--verbose', description: 'Verbose output' }
    ]
};

// ---------------------------------------------------------------------------
// Action dispatch table — data-driven, deterministic.
//
// The table order IS the dispatch priority: the first entry whose flag is
// present runs, exactly one action per invocation. Each entry carries its
// own metadata (clearBuffer for sidecar-mutating actions) so main() stays
// a flat loop with no per-action branches.
// ---------------------------------------------------------------------------

const ACTIONS = [
    {
        flag: '--add',
        run: ({ groups, modules }) => cmdAdd(groups, modules)
    },
    {
        flag: '--commit',
        run: ({ opts }) => cmdCommit(opts.yes, opts.fresh)
    },
    {
        flag: '--log',
        run: ({ nonFlag }) => cmdLog(nonFlag)
    },
    {
        flag: '--recall',
        run: ({ nonFlag }) => cmdRecall(nonFlag[0], nonFlag.slice(1))
    },
    {
        flag: '--drop',
        clearBuffer: true,
        run: async ({ nonFlag, modules }) => cmdDrop(nonFlag[0], nonFlag[1], modules)
    },
    {
        flag: '--forget',
        clearBuffer: true,
        // --forget --oldest → drop the single most-forgotten memo (DAG
        // order); --forget <module>... → wipe whole sidecars.
        run: ({ flags, nonFlag, modules }) =>
            flags.has('--oldest') ? cmdForgetOldest() : cmdForget(nonFlag, modules)
    },
    {
        flag: '--oldest',
        run: () => cmdOldest()
    }
];

async function main(opts, positional) {
    const groups = groupArgs(positional);
    const flags = new Set(positional.filter((a) => a.startsWith('-') && !/^-?\d+$/.test(a)));
    const nonFlag = positional.filter((a) => (!a.startsWith('-') || /^-?\d+$/.test(a)) && a);
    const modules = listAllModules();
    const ctx = { opts, groups, flags, nonFlag, modules };

    // Deterministic dispatch: first matching table entry wins.
    for (const action of ACTIONS) {
        if (!flags.has(action.flag)) continue;
        await action.run(ctx);
        if (action.clearBuffer) memo.clearBuffer();
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
