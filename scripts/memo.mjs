#!/usr/bin/env node

import { CLI, listAllModules, resolveModuleSet } from '../lib/module.mjs';
import {
    memo,
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
        'node index.js memo [files...] [--add <path> <memo>...|--drop <path> [indices]|--forget <path>...|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]]. Only one mutating flag per invocation; the flag must precede at least one of its positional arguments (module or memo text). Memo text may precede the module target.',
    allowUnknownOption: true,
    options: [
        { flag: '--yes', description: 'Skip confirmation for --commit' },
        { flag: '--fresh', description: 'Clear working sidecars after --commit' },
        { flag: '--verbose', description: 'Verbose output' }
    ]
};

async function main(opts, positional) {
    const ACTION_FLAGS = new Set(['--add', '--commit', '--log', '--recall', '--drop', '--forget']);

    const actionFlagsPresent = positional.filter((a) => ACTION_FLAGS.has(a));
    const nonFlag = positional.filter((a) => (!a.startsWith('-') || /^-?\d+$/.test(a)) && a);
    const modules = listAllModules();

    if (actionFlagsPresent.length > 1) {
        console.error(
            `memo: only one mutating flag is allowed per invocation; got ${actionFlagsPresent.length} (${actionFlagsPresent.join(', ')})`
        );
        return;
    }

    if (actionFlagsPresent.length === 1) {
        const flag = actionFlagsPresent[0];
        const flagIdx = positional.indexOf(flag);
        const before = positional.slice(0, flagIdx).filter((a) => !a.startsWith('--'));
        const after = positional.slice(flagIdx + 1).filter((a) => !a.startsWith('--'));
        // Postfix (flag after all its positionals) is not allowed; the
        // flag must precede at least one positional. --commit takes no
        // module/memo positionals, so the rule does not apply to it.
        if (flag !== '--commit' && before.length > 0 && after.length === 0) {
            console.error(
                `memo: postfix form not allowed; ${flag} must precede at least one of its positional arguments (module or memo text)`
            );
            return;
        }
    }

    const has = (f) => actionFlagsPresent.includes(f);

    if (has('--add')) {
        await cmdAdd(nonFlag, modules);
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

    // Default: print memos as a DAG. No file args → whole-repo DAG
    // (root-level paths bold, ancestors dim). File args → DAG scoped
    // to those files + ancestors.
    if (nonFlag.length === 0) {
        cmdPrintAll(true);
    } else {
        const resolved = resolveModuleSet(nonFlag, modules);
        if (resolved.length === 0) {
            console.error(`No modules matched: ${nonFlag.join(', ')}`);
            return;
        }
        cmdPrintSet(resolved, true);
    }
}

export default new CLI('memo.mjs', main, META).supportsDirectRunning(import.meta.url);