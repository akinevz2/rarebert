#!/usr/bin/env node

import { CLI, listAllModules, resolveModuleSet } from '../lib/module.mjs';
import { exit, ModuleArguments } from '../lib/core.mjs';
import {
    memo,
    cmdAdd,
    cmdCommit,
    cmdLog,
    cmdRecall,
    cmdDrop,
    cmdForget,
    cmdPrintAll,
    cmdPrintSet,
    printDagForSet,
    printFlatMemos
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
    const json = ma.bool('json');
    const modules = listAllModules();

    // Helper: invoke a cmd Module's main directly, get the ExitSignal, and
    // format the producedResult based on --json. cmd returns raw data —
    // exit(0, data) on success, exit('error') on failure. No --json check
    // inside cmd functions; this is the single presentation decision point.
    async function runCmd(cmdModule, cmdArgs) {
        const sig = await cmdModule.main(cmdArgs, cmdArgs);
        if (sig.exitCode !== 0) {
            if (json) console.log(JSON.stringify({ ok: false, error: sig.producedResult }));
            else console.error(sig.producedResult);
            return exit(sig.exitCode);
        }
        if (json && sig.producedResult !== undefined) {
            console.log(JSON.stringify(sig.producedResult, null, 2));
        } else if (!json && sig.producedResult !== undefined) {
            console.dir(sig.producedResult);
        }
        return exit(0);
    }

    if (ma.has('--add')) {
        return await runCmd(cmdAdd, ma);
    }

    if (ma.has('--commit')) {
        return await runCmd(cmdCommit, ma);
    }

    if (ma.has('--log')) {
        return await runCmd(cmdLog, ma);
    }

    if (ma.has('--recall')) {
        return await runCmd(cmdRecall, ma);
    }

    if (ma.has('--drop')) {
        const sig = await runCmd(cmdDrop, ma);
        memo.clearBuffer();
        return sig;
    }

    if (ma.has('--forget')) {
        const sig = await cmdForget.main(ma, ma);
        if (sig.exitCode !== 0) {
            if (json) console.log(JSON.stringify({ ok: false, error: sig.producedResult }));
            else console.error(sig.producedResult);
            return exit(sig.exitCode);
        }
        if (json) {
            console.log(JSON.stringify(sig.producedResult, null, 2));
        } else {
            // Human: print ✓ per module, then the data
            for (const f of sig.producedResult.forgotten) {
                if (f.content.length > 0) console.log(`\x1b[33m✓\x1b[0m Forgot all memos for ${f.module}`);
                else console.log(`No memos were found on ${f.module}`);
            }
        }
        return exit(0);
    }

    // List-only: DAG (human) or JSON
    if (ma.nonFlag().length === 0) {
        if (json) return await runCmd(cmdPrintAll, ma);
        printDagForSet(null);
        return exit(0);
    }
    const resolved = resolveModuleSet(ma.nonFlag(), modules);
    if (resolved.length === 0) {
        console.error(`No modules matched: ${ma.nonFlag().join(', ')}`);
        return exit(1);
    }
    if (json) {
        const setArgs = ModuleArguments.from([], { resolvedSet: resolved });
        return await runCmd(cmdPrintSet, setArgs);
    }
    printDagForSet(resolved);
    return exit(0);
}

export default new CLI('memo.mjs', main, META).supportsDirectRunning(import.meta.url);
