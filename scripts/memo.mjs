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
    cmdPrintSet,
    applyDrop,
    multiSelectMemos,
    printFlatMemos
} from '../lib/memo.mjs';

const META = {
    name: 'memo',
    description:
        'Print or manage memos. Default (no flags): print memos — all, or scoped to file args. Mutating flags: --add, --drop, --forget, --commit, --recall, --log.',
    usage:
        'node index.js memo [files...] [--add <path> <memo>...|--drop <path> [indices]|--forget <path>...|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]|--json]',
    allowUnknownOption: true,
    options: [
        { flag: '--yes', description: 'Skip confirmation for --commit' },
        { flag: '--fresh', description: 'Clear working sidecars after --commit' },
        { flag: '--verbose', description: 'Verbose output' },
        { flag: '--json', description: 'Output memos in JSON format' }
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
        const result = await cmdAdd(groups, modules);
        if (result.success) {
            console.log(`Added ${result.added.length} memo(s)`);
        } else {
            console.error(result.error);
            return exit(1);
        }
        return exit(0);
    }

    if (has('--commit')) {
        const result = await cmdCommit(opts.yes, opts.fresh);
        if (result.success) {
            console.log(result.message);
        } else {
            console.error(result.error);
            return exit(1);
        }
        return exit(0);
    }

    if (has('--log')) {
        const result = cmdLog(nonFlag);
        if (result.entries.length === 0) {
            console.log(result.message);
        } else {
            for (const entry of result.entries) {
                if (entry.modules) {
                    console.log(`${entry.date}  ${entry.subject}  [${entry.modules.join(', ')}]`);
                } else {
                    console.log(`${entry.date}  ${entry.subject}`);
                }
            }
        }
        return exit(0);
    }

    if (has('--recall')) {
        const result = cmdRecall(nonFlag[0], nonFlag.slice(1));
        if (!result.success) {
            console.error(result.error);
            return exit(1);
        }
        return exit(0);
    }

    if (has('--drop')) {
        const result = await cmdDrop(nonFlag[0], nonFlag[1], modules);
        memo.clearBuffer();

        if (!result.success) {
            console.error(result.error);
            if (result.help) {
                console.log(result.help);
            }
            return exit(1);
        }

        // success === 'needs_selection' means TTY mode needs TUI selection
        if (result.success === 'needs_selection') {
            const resolved = { rel: result.modulePath };
            const selected = await multiSelectMemos(resolved);
            if (selected && selected.length > 0) {
                const dropResult = applyDrop(resolved, selected);
                console.log(`Dropped ${dropResult.dropped} memo(s) from ${result.modulePath}`);
            } else {
                console.log('Aborted; no memos dropped.');
            }
            return exit(0);
        }

        console.log(`Dropped ${result.dropped} memo(s) from ${result.path}`);
        return exit(0);
    }

    if (has('--forget')) {
        const result = cmdForget(nonFlag, modules);
        if (!result.success) {
            console.error(result.error);
            return exit(1);
        }
        for (const item of result.results) {
            if (item.status === 'not_found') {
                console.log(`No memos were found on ${item.path}`);
            } else {
                console.log(`Forgot all memos for ${item.path}`);
            }
        }
        return exit(0);
    }

    // Default: print memos as a DAG. No file args → whole-repo DAG
    // (root-level paths bold, ancestors dim). File args → DAG scoped
    // to those files + ancestors.
    if (nonFlag.length === 0) {
        const result = cmdPrintAll(true, opts.json);
        if (result.format === 'json') {
            console.log(JSON.stringify(result.data, null, 2));
        } else {
            printFlatMemos(result.entries);
        }
    } else {
        const resolved = resolveModuleSet(nonFlag, modules);
        if (resolved.length === 0) {
            console.error(`No modules matched: ${nonFlag.join(', ')}`);
            return exit(1);
        }
        const result = cmdPrintSet(resolved, true, opts.json);
        if (result.format === 'json') {
            console.log(JSON.stringify(result.data, null, 2));
        } else {
            printFlatMemos(result.entries);
        }
    }
    return exit(0);
}

export default new CLI('memo.mjs', main, META).supportsDirectRunning(import.meta.url);