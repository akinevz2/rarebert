#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { rarebert } from '../lib/projects.mjs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { memo } from '../lib/memo.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

const META = {
    name: 'memo',
    description: 'Inspect and mutate memos stored alongside modules',
    usage: 'node index.js memo [files...|--all|--add <path> <memo>...|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]]',
    options: [
        { flag: '', label: '(no args)', description: 'TUI: select a module to add a memo to' },
        { flag: 'all', label: '--all', description: 'Print all memos (flat, oldest-first)' },
        {
            flag: 'files',
            label: '<files/folders>',
            description: 'Print memos only for modules within the given set'
        },
        {
            flag: 'files --all',
            label: '<files/folders> --all',
            description: 'Ancestor-traversal: print memos for the set and its ancestors'
        },
        {
            flag: 'add',
            label: '--add <path> <memo>',
            description: 'Add a memo non-interactively; repeat --add for multiple'
        },
        {
            flag: 'commit',
            label: '--commit [--yes] [--fresh]',
            description:
                'Snapshot memos to git notes (TUI confirm; --yes skips; --fresh clears after)'
        },
        {
            flag: 'log',
            label: '--log [files...]',
            description: 'Show memo snapshot history, optionally filtered to filenames'
        },
        {
            flag: 'recall',
            label: '--recall <ref> [files...]',
            description: 'Restore memos for filenames from a git notes snapshot ref'
        },
        {
            flag: 'drop',
            label: '--drop <module>',
            description: 'Remove selected memos for a module (interactive)'
        }
    ]
};

async function promptMemoContent(moduleName, initial = '') {
    return cli.input('Enter memo content:', {
        initial,
        validate: (v) => (v.trim() ? true : 'required')
    });
}

function printGroupedMemos() {
    const groups = memo.walkAll();
    if (groups.length === 0) {
        console.log('No memos found.');
        return false;
    }

    const RED_BOLD = '\x1b[1;31m';
    const DIM = '\x1b[2m';
    const RESET = '\x1b[0m';
    const totalCycles = groups.totalCycles ?? 0;

    for (const { path, memos, related } of groups) {
        console.log(`\n\x1b[1m${path}\x1b[0m`);
        for (const content of memos) {
            console.log(`  ${content}`);
        }
        for (const entry of related) {
            if (entry.cycle) {
                console.log(`  ${RED_BOLD}${entry.path}: ↻ cyclic import${RESET}`);
            } else {
                console.log(`  ${DIM}${entry.path}${RESET}`);
            }
        }
    }

    if (totalCycles > 0) {
        console.log(
            `\n${RED_BOLD}⚠ ${totalCycles} cyclic import${totalCycles === 1 ? '' : 's'} detected${RESET}`
        );
    }
    console.log();
    return true;
}

async function addMemo(moduleArg, memoContentArg) {
    const modules = listAllModules();
    if (modules.length === 0) {
        cli.fail('No modules found.');
    }
    const target = await promptModule(modules, moduleArg, 'Select a module to memoize');
    const memoContent = memoContentArg.trim() || (await promptMemoContent(target.name));
    memo.remember(target.path, memoContent);
    console.log(`\x1b[33m✓\x1b[0m Memo added to ${rarebert.relPath(target.path)}`);
}

async function bare(args) {
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);

    if (nonFlag.length >= 2) {
        await addMemo(nonFlag[0], nonFlag.slice(1).join(' '));
        return;
    }

    const hasMemos = memo.loadAllMemos().length > 0;
    if (hasMemos) {
        printGroupedMemos();
    } else {
        console.log('No memos found.\n');
    }

    const choices = [
        { name: 'add', message: 'Add a memo' },
        { name: 'commit', message: 'Snapshot to git notes' },
        { name: 'fresh', message: 'Fresh slate (snapshot + clear)' },
        { name: 'exit', message: 'Exit' }
    ];
    const action = await cli.select('What next?', choices);
    if (action === 'exit') return;
    if (action === 'add') {
        await addMemo(nonFlag[0] || '', nonFlag.slice(1).join(' '));
        return;
    }
    if (action === 'commit') {
        memo.snapshot(nonFlag.join(' ') || 'memo snapshot');
        memo.clearBuffer();
        return;
    }
    if (action === 'fresh') {
        const label = nonFlag.join(' ') || 'memo fresh slate';
        const hadMemos = memo.loadAllMemos().length > 0;
        if (hadMemos) memo.snapshot(label);
        memo.forgetAll();
        console.log(hadMemos ? 'Fresh slate (previous memos snapshotted).' : 'Already clean.');
        memo.clearBuffer();
        return;
    }
}

async function dropMemos(moduleArg) {
    if (!moduleArg) {
        cli.fail("A memo'd module must be specified for --drop.");
    }
    if (process.stdin.isTTY !== true) {
        cli.nonInteractive('cannot prompt for memo selection.');
    }

    const target = await promptModule(
        listAllModules(),
        moduleArg,
        'Select module to drop memos from'
    );
    const selected = await multiSelectMemos(target.path);
    if (!selected.length) {
        console.log('No memos selected; nothing dropped.');
        return;
    }

    const remaining = memo
        .loadMemos(target.path)
        .flatMap((m) => m.content)
        .filter((c) => !selected.includes(c));
    const file = target.path + '.';
    if (!remaining.length) {
        try {
            fs.unlinkSync(file);
        } catch {
            /* already absent */
        }
    } else {
        fs.writeFileSync(
            file,
            JSON.stringify(
                { name: target.name, content: remaining, lastModified: Date.now() },
                null,
                2
            ) + '\n'
        );
    }
    console.log(`Dropped ${selected.length} memo(s) from ${rarebert.relPath(target.path)}`);
}

async function multiSelectMemos(modulePath) {
    const memos = memo.loadMemos(modulePath).flatMap((m) => m.content);
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
        return result;
    } catch {
        throw new AbortError();
    }
}

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split argv into a list of { flags: string[], positional: string[] } groups,
 * where each `--flag` starts a new group that consumes following positionals
 * until the next `--flag`. Non-flag positionals before any flag form a leading
 * group with an empty flags array.
 *
 * Example: ['a.mjs', '--add', 'b.mjs', 'note', '--add', 'c.mjs', 'note2']
 *   -> [ { flags: [], positional: ['a.mjs'] },
 *        { flags: ['--add'], positional: ['b.mjs', 'note'] },
 *        { flags: ['--add'], positional: ['c.mjs', 'note2'] } ]
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

/**
 * Resolve a list of file/folder arguments to a set of module paths.
 * - A folder expands to all modules under it (recursively for lib/).
 * - A file is matched against module paths/names.
 * Returns a Set of module path strings.
 */
function resolveModuleSet(args, modules) {
    const result = new Set();
    for (const arg of args) {
        const abs = path.isAbsolute(arg) ? arg : path.resolve(rarebert.root, arg);
        // folder: expand to all modules under it
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            for (const m of modules) {
                if (m.abs.startsWith(abs + path.sep) || m.abs === abs) {
                    result.add(m.path);
                }
            }
            continue;
        }
        // file: match by path, suffix, or name
        const rel = path.isAbsolute(arg) ? rarebert.relPath(arg) : arg;
        const match =
            modules.find((m) => m.path === rel) ||
            modules.find((m) => m.path.endsWith(rel)) ||
            modules.find((m) => m.name === rel || m.name === path.basename(rel, path.extname(rel)));
        if (match) result.add(match.path);
        else console.error(`memo: no module matched "${arg}"`);
    }
    return result;
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
    for (const { module, memos, lastModified } of entries) {
        for (const content of memos) {
            flat.push({ path: module.path, content, lastModified });
        }
    }
    flat.sort((a, b) => a.lastModified - b.lastModified);
    for (const { path: p, content } of flat) {
        console.log(`${p}  ${content}`);
    }
    return true;
}

function printDagForSet(modules, set) {
    const groups = memo.walkAll();
    if (groups.length === 0) {
        console.log('No memos found.');
        return false;
    }

    const RED_BOLD = '\x1b[1;31m';
    const DIM = '\x1b[2m';
    const RESET = '\x1b[0m';
    const totalCycles = groups.totalCycles ?? 0;
    const cyclePaths = groups.cycles ?? [];

    // When a set is given, emit the set members AND their ancestors
    // (the related entries), each with its own memo content. Ancestors
    // are printed BEFORE the member that references them (deepest-first),
    // so dependencies always appear before dependents.
    const wanted = set ? new Set(set) : null;
    const byPath = new Map(groups.map((g) => [g.path, g]));
    const emitted = new Set();
    let shown = 0;

    const emitGroup = (groupPath, indent) => {
        if (emitted.has(groupPath)) return;
        emitted.add(groupPath);
        const g = byPath.get(groupPath);
        if (!g) return;

        // Recurse into ancestors FIRST so they print before us
        for (const entry of g.related) {
            if (entry.cycle) {
                // cycle — will be summarised in the warning, don't recurse
            } else {
                emitGroup(entry.path, true);
            }
        }

        // Now emit this node
        shown++;
        const prefix = indent ? '  ' : '';
        const style = indent ? DIM : '\x1b[1m';
        console.log(`\n${style}${prefix}${g.path}${RESET}`);
        for (const content of g.memos) {
            console.log(`${prefix}  ${content}`);
        }
        // Show related references (dim, no content — already emitted above)
        for (const entry of g.related) {
            if (entry.cycle) {
                console.log(`${prefix}  ${RED_BOLD}${entry.path}: ↻ cyclic import${RESET}`);
            } else {
                console.log(`${prefix}  ${DIM}${entry.path}${RESET}`);
            }
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
// Command handlers
// ---------------------------------------------------------------------------

async function cmdBare() {
    // No args: directly enter "select module to add a memo to" TUI
    const modules = listAllModules();
    if (modules.length === 0) {
        cli.fail('No modules found.');
    }
    const target = await promptModule(modules, '', 'Select a module to add a memo to');
    const memoContent = await promptMemoContent(target.name);
    memo.remember(target.path, memoContent);
    console.log(`\x1b[33m✓\x1b[0m Memo added to ${rarebert.relPath(target.path)}`);
}

function cmdPrintSet(modules, set, withAncestors) {
    if (withAncestors) {
        // ancestor-traversal: DAG walk filtered to the set
        printDagForSet(modules, set);
    } else {
        // plain: flat list of memos for modules in the set
        const all = memo.loadAllMemos().filter((e) => set.has(e.module.path));
        printFlatMemos(all);
    }
}

function cmdPrintAll() {
    printFlatMemos(memo.loadAllMemos());
}

async function cmdAdd(groups) {
    // Each --add group: positional[0] = path, positional.slice(1).join(' ') = memo
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
        const modules = listAllModules();
        const match =
            modules.find((m) => m.path === modArg) ||
            modules.find((m) => m.path.endsWith(modArg)) ||
            modules.find(
                (m) => m.name === modArg || m.name === path.basename(modArg, path.extname(modArg))
            );
        if (!match) {
            console.error(`memo --add: module not found: ${modArg}`);
            continue;
        }
        memo.remember(match.path, content);
        console.log(`\x1b[33m✓\x1b[0m Memo added to ${rarebert.relPath(match.path)}`);
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

function cmdLog(set) {
    const entries = memo.logEntries();
    if (entries.length === 0) {
        console.log('memo: no snapshots in refs/notes/memos');
        return;
    }
    const wanted = set && set.length ? new Set(set) : null;
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

function cmdRecall(ref, set) {
    if (!ref) {
        console.error('memo --recall: missing ref argument');
        return;
    }
    memo.restore(ref, set && set.length ? set : null);
    memo.clearBuffer();
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(args = []) {
    const groups = groupArgs(args);
    const allFlags = args.filter((a) => a.startsWith('--'));
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const modules = listAllModules();

    const has = (f) => allFlags.includes(f);

    // --add: one or more groups, each with a path + memo content
    if (has('--add')) {
        await cmdAdd(groups);
        return;
    }

    // --commit [--yes] [--fresh]
    if (has('--commit')) {
        await cmdCommit(has('--yes'), has('--fresh'));
        return;
    }

    // --log [files...]
    if (has('--log')) {
        cmdLog(nonFlag);
        return;
    }

    // --recall <ref> [files...]
    if (has('--recall')) {
        cmdRecall(nonFlag[0], nonFlag.slice(1));
        return;
    }

    // --drop <module> (preserved from before)
    if (has('--drop')) {
        await dropMemos(nonFlag[0]);
        memo.clearBuffer();
        return;
    }

    // --all [files...] : print DAG view for all, or ancestor-traversal for a set
    if (has('--all')) {
        if (nonFlag.length) {
            const set = resolveModuleSet(nonFlag, modules);
            cmdPrintSet(modules, set, true);
        } else {
            // No files: full DAG view (topological, deepest-first)
            printDagForSet(modules, null);
        }
        return;
    }

    // files/folders only (no --all): print memos for the set
    if (nonFlag.length) {
        const set = resolveModuleSet(nonFlag, modules);
        cmdPrintSet(modules, set, false);
        return;
    }

    // no args: TUI to select a module and add a memo
    await cmdBare();
}

export { main };

export default {
    ...META,
    main
};
