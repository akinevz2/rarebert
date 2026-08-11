#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { rarebert } from '../lib/projects.mjs';
import {
    listAllModules,
    promptModule,
    resolveModule,
    resolveModuleSet,
    promptModuleChoices,
    Module
} from '../lib/modules.mjs';
import { memo } from '../lib/memo.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

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
// Shared constants & helpers
// ---------------------------------------------------------------------------

const YELLOW_TICK = '\x1b[33m✓\x1b[0m';
const RED_BOLD = '\x1b[1;31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function printMemoAdded(rel) {
    console.log(`${YELLOW_TICK} Memo added to ${rel}`);
}

async function promptMemoContent(initial = '') {
    return cli.input('Enter memo content:', {
        initial,
        validate: (v) => (v.trim() ? true : 'required')
    });
}

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split argv into a list of { flags: string[], positional: string[] } groups,
 * where each `--flag` starts a new group that consumes following positionals
 * until the next `--flag`. Non-flag positionals before any flag form a leading
 * group with an empty flags array.
 */
function groupArgs(argv) {
    const groups = [];
    let current = { flags: [], positional: [] };
    groups.push(current);
    for (const arg of argv) {
        if (arg.startsWith('--')) {
            if (current.flags.length || current.positional.length) {
                current = { flags: [arg], positional: [] };
                groups.push(current);
            } else {
                current.flags.push(arg);
            }
        } else {
            current.positional.push(arg);
        }
    }
    return groups.filter((g) => g.flags.length || g.positional.length);
}

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------

function printFlatMemos(entries) {
    if (entries.length === 0) {
        console.log('No memos found.');
        return false;
    }
    const flat = [];
    for (const { module, memos: contents, lastModified } of entries) {
        for (const content of contents) {
            flat.push({ path: module.path, content, lastModified });
        }
    }
    flat.sort((a, b) => a.lastModified - b.lastModified);
    for (const { path: p, content } of flat) {
        console.log(`${p}  ${content}`);
    }
    return true;
}

/**
 * Print the memo DAG, optionally filtered to a set of resolved module
 * descriptors. When a set is given, ancestors are emitted before the
 * members that reference them (deepest-first).
 */
function printDagForSet(resolvedSet) {
    const groups = memo.walkAll();
    if (groups.length === 0) {
        console.log('No memos found.');
        return false;
    }

    const totalCycles = groups.totalCycles ?? 0;
    const cyclePaths = groups.cycles ?? [];
    const wanted = resolvedSet ? new Set(resolvedSet.map((r) => r.rel)) : null;
    const byPath = new Map(groups.map((g) => [g.path, g]));
    const emitted = new Set();
    let shown = 0;

    const emitGroup = (groupPath, indent) => {
        if (emitted.has(groupPath)) return;
        emitted.add(groupPath);
        const g = byPath.get(groupPath);
        if (!g) return;

        for (const entry of g.related) {
            if (!entry.cycle) emitGroup(entry.path, true);
        }

        shown++;
        const prefix = indent ? '  ' : '';
        const style = indent ? DIM : '\x1b[1m';
        console.log(`\n${style}${prefix}${g.path}${RESET}`);

        if (g.related.length) {
            for (let i = 0; i < g.related.length; i++) {
                const entry = g.related[i];
                const isLast = i === g.related.length - 1;
                const branch = isLast ? '└── ' : '├── ';
                if (entry.cycle) {
                    console.log(`${prefix}  ${RED_BOLD}${branch}${entry.path} ↻${RESET}`);
                } else {
                    console.log(`${prefix}  ${DIM}${branch}${entry.path}${RESET}`);
                }
            }
        }

        for (const content of g.memos) {
            console.log(`${prefix}  ${content}`);
        }
    };

    if (wanted) {
        for (const { path } of groups) {
            if (wanted.has(path)) emitGroup(path, false);
        }
    } else {
        for (const { path } of groups) emitGroup(path, false);
    }

    if (shown === 0) {
        console.log('No memos found for the given modules.');
        return false;
    }
    if (totalCycles > 0) {
        console.log(
            `\n${RED_BOLD}⚠ ${totalCycles} cyclic import${totalCycles === 1 ? '' : 's'} detected:${RESET}`
        );
        for (const c of cyclePaths) {
            console.log(`  ${RED_BOLD}${c.path.join(' → ')}${RESET}`);
        }
    }
    console.log();
    return true;
}

// ---------------------------------------------------------------------------
// --drop helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated indices string into 0-based array indices.
 * 1-based positive; negative counts from end; 0 is invalid.
 */
function parseIndices(arg, count) {
    if (count === 0) {
        console.error('No memos to drop.');
        return null;
    }
    const raw = arg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (!raw.length) {
        console.error(`No indices provided in "${arg}".`);
        return null;
    }

    const indices = [];
    for (const token of raw) {
        const n = parseInt(token, 10);
        if (Number.isNaN(n)) {
            console.error(`Invalid index "${token}"; expected an integer.`);
            return null;
        }
        if (n === 0) {
            console.error(
                `Index 0 is invalid; indices are 1-based (use 1 for the first memo, -1 for the last).`
            );
            return null;
        }
        const idx = n > 0 ? n - 1 : count + n;
        if (idx < 0 || idx >= count) {
            const range = `1–${count} (or -1 to -${count} from end)`;
            console.error(`Index ${n} is out of bounds; valid range: ${range}.`);
            return null;
        }
        indices.push(idx);
    }
    return indices;
}

function applyDrop(resolved, selected) {
    const remaining = memo
        .loadMemos(resolved.rel)
        .flatMap((m) => m.content)
        .filter((c) => !selected.includes(c));
    if (!remaining.length) {
        try {
            fs.unlinkSync(resolved.sidecar);
        } catch {
            /* already absent */
        }
    } else {
        fs.writeFileSync(
            resolved.sidecar,
            JSON.stringify(
                { name: resolved.module.name, content: remaining, lastModified: Date.now() },
                null,
                2
            ) + '\n'
        );
    }
    console.log(`Dropped ${selected.length} memo(s) from ${resolved.rel}`);
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

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdBare(modules) {
    if (modules.length === 0) {
        cli.fail('No modules found.');
    }

    const choices = [{ name: '__view', message: 'view — print all memos' }];
    for (const m of modules) {
        const meta = rarebert.getScriptMetadata(m.abs);
        const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
        const label = desc ? `add memo to ${m.path} — ${desc}` : `add memo to ${m.path}`;
        choices.push({ name: m.path, message: cli.truncate(label) });
    }
    choices.push({ name: '__exit', message: 'exit' });

    const selection = await promptModuleChoices('Memo', choices, {
        limit: 8,
        specials: ['__view', '__exit']
    });

    if (selection === '__exit') return;
    if (selection === '__view') {
        printDagForSet(null);
        return;
    }

    const target = modules.find((m) => m.path === selection);
    if (!target) return;
    const content = await promptMemoContent();
    memo.remember(target.path, content);
    printMemoAdded(target.path);
}

function cmdPrintSet(resolvedSet, withAncestors) {
    if (withAncestors) {
        printDagForSet(resolvedSet);
    } else {
        const setPaths = new Set(resolvedSet.map((r) => r.rel));
        const all = memo.loadAllMemos().filter((e) => setPaths.has(e.module.path));
        printFlatMemos(all);
    }
}

function cmdPrintAll() {
    printFlatMemos(memo.loadAllMemos());
}

async function cmdAdd(groups, modules) {
    for (const g of groups) {
        if (g.flags[0] !== '--add') continue;
        const [modArg, ...rest] = g.positional;
        if (!modArg) {
            console.error('memo --add: missing module path');
            continue;
        }
        const content = rest.join(' ').trim();
        if (!content) {
            console.error(`memo --add: missing memo content for "${modArg}"`);
            continue;
        }
        const resolved = resolveModule(modArg, modules);
        if (!resolved) {
            console.error(`memo --add: module not found: ${modArg}`);
            continue;
        }
        memo.remember(resolved.rel, content);
        printMemoAdded(resolved.rel);
    }
}

async function cmdCommit(isYes, isFresh) {
    const label = 'memo snapshot';
    const hadMemos = memo.loadAllMemos().length > 0;
    if (!hadMemos) {
        console.log('No memos to commit.');
        return;
    }
    if (!isYes) {
        const ok = await cli.confirm('Commit memos to git notes?');
        if (!ok) {
            console.log('Aborted; memos not committed.');
            return;
        }
    }
    memo.snapshot(label);
    if (isFresh) {
        memo.forgetAll();
        console.log('Fresh slate (working sidecars cleared).');
    }
    memo.clearBuffer();
}

function cmdLog(nonFlag) {
    const entries = memo.logEntries();
    if (entries.length === 0) {
        console.log('memo: no snapshots in refs/notes/memos');
        return;
    }
    const wanted = nonFlag.length ? new Set(nonFlag) : null;
    let shown = 0;
    for (const e of entries) {
        if (wanted) {
            const hits = e.modules.filter((m) => wanted.has(m));
            if (hits.length === 0) continue;
            console.log(`${e.date}  ${e.subject}  [${hits.join(', ')}]`);
        } else {
            console.log(`${e.date}  ${e.subject}`);
        }
        shown++;
    }
    if (shown === 0) {
        console.log('memo: no snapshots reference the given filenames');
    }
}

function cmdRecall(ref, nonFlag) {
    if (!ref) {
        console.error('memo --recall: missing ref argument');
        return;
    }
    memo.restore(ref, nonFlag.length ? nonFlag : null);
    memo.clearBuffer();
}

async function cmdDrop(moduleArg, indicesArg, modules) {
    if (!moduleArg) {
        cli.fail("A memo'd module must be specified for --drop.");
    }

    const target = await promptModule(modules, moduleArg, 'Select module to drop memos from');
    const resolved = { module: target, rel: target.path, sidecar: target.memoFile() };

    const allMemos = memo.loadMemos(resolved.rel).flatMap((m) => m.content);
    if (!allMemos.length) {
        console.log('No memos found for this module.');
        return;
    }

    if (process.stdin.isTTY !== true) {
        if (!indicesArg) {
            console.error(
                `Error: missing indices argument for non-interactive --drop:\n` +
                    `Non-interactive mode cannot prompt for memo selection.\n` +
                    `  Pass comma-separated indices (1 for first, -1 for last): --drop ${moduleArg} 1,3,-1\n` +
                    `  Or to remove all memos for this module, use: --forget ${moduleArg}`
            );
            cli.fail();
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
    if (indicesArg) {
        const indices = parseIndices(indicesArg, allMemos.length);
        if (!indices) return;
        selected = indices.map((i) => allMemos[i]);

        console.log(`\n\x1b[1mMemos to drop from ${resolved.rel}:\x1b[0m`);
        for (const [i, content] of selected.entries()) {
            console.log(`  ${indicesArg.split(',')[i]?.trim() || i + 1}. ${content}`);
        }
        console.log();
        const confirmed = await cli.select('Proceed?', [
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

function cmdForget(moduleArgs, modules) {
    if (!moduleArgs || moduleArgs.length === 0) {
        console.error('memo --forget: missing module argument');
        return;
    }

    // Resolve every argument first; if any module is not found, error
    // out completely without forgetting anything.
    const resolved = [];
    for (const moduleArg of moduleArgs) {
        const r = resolveModule(moduleArg, modules);
        if (!r) {
            console.error(`memo --forget: module not found: ${moduleArg}`);
            return;
        }
        resolved.push(r);
    }

    for (const r of resolved) {
        if (!fs.existsSync(r.sidecar)) {
            console.log(`${YELLOW_TICK} No memos were found on ${r.rel}`);
            continue;
        }
        memo.forgetByPath(r.rel);
        console.log(`${YELLOW_TICK} Forgot all memos for ${r.rel}`);
    }
}

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

export { main };

const module = new Module('memo.mjs', main, META);

export default module;
module.supportsDirectRunning(import.meta.url);
