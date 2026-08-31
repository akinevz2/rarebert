#!/usr/bin/env node

import {
    CLI,
    listAllModules,
    resolveModuleSet,
    cli,
    Interface,
    resolveModule
} from '../lib/module.mjs';
import { exit, AbortError } from '../lib/core.mjs';
import { BOLD, RESET } from '../lib/symbols.mjs';
import {
    memo,
    groupArgs,
    cmdAdd,
    cmdLog,
    cmdRecall,
    cmdForget,
    cmdForgetOldest,
    cmdOldest,
    cmdPrintAll,
    cmdPrintSet,
    parseIndices,
    applyDrop
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
        run: ({ opts }) => runCommit(opts)
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
        run: ({ nonFlag, modules }) => runDrop(nonFlag[0], nonFlag[1], modules)
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

// ---------------------------------------------------------------------------
// --commit / --drop orchestration — moved here from lib/memo.mjs as part of
// the lib-purity inversion: Interface construction lives in scripts/, while
// lib/memo.mjs keeps only data transformations (memo.commitMemos,
// memo.loadMemos, parseIndices, applyDrop).
// ---------------------------------------------------------------------------

async function runCommit(opts) {
    if (!opts.yes) {
        // The memo CLI can run non-interactively (make flows, CI) — guard
        // before constructing the Interface.
        if (!cli.isInteractive()) {
            throw new AbortError(
                'memo --commit: confirmation required; pass --yes for non-interactive runs.',
                1
            );
        }
        const iface = Interface.createInterface('memo');
        const ok = await iface.confirm('Commit memos to git notes?');
        if (!ok) {
            console.log('Aborted; memos not committed.');
            return;
        }
    }
    if (!memo.commitMemos({ label: 'memo snapshot', fresh: opts.fresh })) {
        console.log('No memos to commit.');
    }
}

async function runDrop(moduleArg, indicesArg, modules) {
    if (!moduleArg) {
        throw new AbortError("A memo'd module must be specified for --drop.", 1);
    }

    // Resolve by name/path locally — no prompting when a module arg is given.
    const resolved = resolveModule(moduleArg, modules);
    if (!resolved) {
        throw new AbortError(`Module not found: ${moduleArg}`, 1);
    }

    const allMemos = memo.loadMemos(resolved.rel).flatMap((m) => m.content);
    if (!allMemos.length) {
        console.log('No memos found for this module.');
        return;
    }

    if (process.stdin.isTTY !== true) {
        if (!indicesArg) {
            throw new AbortError(
                `Error: missing indices argument for non-interactive --drop:\n` +
                    `Non-interactive mode cannot prompt for memo selection.\n` +
                    `  Pass comma-separated indices (1 for first, -1 for last): --drop ${moduleArg} 1,3,-1\n` +
                    `  Or to remove all memos for this module, use: --forget ${moduleArg}`,
                1
            );
        }
        const indices = parseIndices(indicesArg, allMemos.length);
        if (!indices) return;
        applyDrop(
            resolved,
            indices.map((i) => allMemos[i])
        );
        return;
    }

    let selected;
    // Interactive path only — the non-interactive branch above has already
    // returned, so Interface construction is safe here.
    const iface = Interface.createInterface('memo');
    if (indicesArg) {
        const indices = parseIndices(indicesArg, allMemos.length);
        if (!indices) return;
        selected = indices.map((i) => allMemos[i]);

        console.log(`\n${BOLD}Memos to drop from ${resolved.rel}:${RESET}`);
        for (const [i, content] of selected.entries()) {
            console.log(`  ${indicesArg.split(',')[i]?.trim() || i + 1}. ${content}`);
        }
        console.log();
        const confirmed = await iface.select('Proceed?', [
            { name: 'drop', message: 'Drop the listed memos' },
            { name: 'cancel', message: 'Cancel' }
        ]);
        if (confirmed === 'cancel') {
            console.log('Aborted; no memos dropped.');
            return;
        }
    } else {
        selected = await multiSelectMemos(resolved);
    }

    if (!selected.length) {
        console.log('No memos selected; nothing dropped.');
        return;
    }
    applyDrop(resolved, selected);
}

async function multiSelectMemos(resolved) {
    const memos = memo.loadMemos(resolved.rel).flatMap((m) => m.content);
    if (!memos.length) return [];

    const { default: Enquirer } = await import('enquirer');
    const prompt = new Enquirer.MultiSelect({
        name: 'memos',
        message: `Select memos to drop:`,
        choices: memos.map((content, idx) => ({
            name: idx.toString(),
            message: content,
            value: content
        }))
    });
    try {
        const result = await prompt.run();
        return result.map((idx) => memos[parseInt(idx, 10)]);
    } catch {
        throw new AbortError();
    }
}

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
