#!/usr/bin/env node

import fs from 'fs';
import { project } from '../lib/core.mjs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { memo } from '../lib/memo.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

const META = {
    name: 'memo',
    description: 'Inspect and mutate memos stored alongside modules',
    usage: 'node index.js memo [bare|--add|--all|--commit|--log|--restore|--fresh|--drop]',
    options: [
        { flag: '', label: 'bare', description: 'Print all memos, then TUI to add one' },
        { flag: 'add', label: '--add', description: 'Add a memo non-interactively (skip TUI)' },
        { flag: 'all', label: '--all', description: 'Print all memos and exit' },
        {
            flag: 'drop',
            label: '--drop',
            description: 'Remove selected memos for a module (interactive)'
        },
        {
            flag: 'commit',
            label: '--commit [label]',
            description: 'Snapshot current memos to git notes (refs/notes/memos)'
        },
        { flag: 'log', label: '--log', description: 'Show memo snapshot history from git notes' },
        {
            flag: 'restore',
            label: '--restore [ref]',
            description: 'Restore memos from a git notes snapshot (default: HEAD)'
        },
        {
            flag: 'fresh',
            label: '--fresh [label]',
            description: 'Snapshot current memos, then clear working sidecars (clean slate)'
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

    for (const { module, memos, libs } of groups) {
        console.log(`\n\x1b[1m${module.path}\x1b[0m`);
        for (const content of memos) {
            console.log(`  ${content}`);
        }
        for (const lib of libs) {
            console.log(`  \x1b[2m${lib.path}:\x1b[0m`);
            for (const content of lib.memos) {
                console.log(`    ${content}`);
            }
        }
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
    console.log(`\x1b[33m✓\x1b[0m Memo added to ${project.relPath(target.path)}`);
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

    const remaining = memo.loadMemos(target.path).filter((c) => !selected.includes(c));
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
    console.log(`Dropped ${selected.length} memo(s) from ${project.relPath(target.path)}`);
}

async function multiSelectMemos(modulePath) {
    const memos = memo.loadMemos(modulePath);
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

async function main(args = []) {
    const flags = args.filter((a) => a.startsWith('-'));
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);

    const isAll = flags.includes('--all');
    const isDrop = flags.includes('--drop');
    const isAdd = flags.includes('--add');
    const isCommit = flags.includes('--commit');
    const isLog = flags.includes('--log');
    const isRestore = flags.includes('--restore');
    const isFresh = flags.includes('--fresh');
    const isBare = !flags.length && !nonFlag.length;

    if (isAll) {
        const all = memo.loadAllMemos();
        if (all.length === 0) {
            console.log('No memos found.');
        } else {
            const flat = [];
            for (const { module, memos, lastModified } of all) {
                for (const content of memos) {
                    flat.push({ path: module.path, content, lastModified });
                }
            }
            flat.sort((a, b) => a.lastModified - b.lastModified);
            for (const { path, content } of flat) {
                console.log(`${path}  ${content}`);
            }
        }
        memo.clearBuffer();
        return;
    }

    if (isAdd) {
        await addMemo(nonFlag[0], nonFlag.slice(1).join(' '));
        return;
    }

    if (isDrop) {
        await dropMemos(nonFlag[0]);
        memo.clearBuffer();
        return;
    }

    if (isCommit) {
        memo.snapshot(nonFlag.join(' ') || 'memo snapshot');
        memo.clearBuffer();
        return;
    }

    if (isLog) {
        memo.log();
        memo.clearBuffer();
        return;
    }

    if (isRestore) {
        memo.restore(nonFlag[0] || 'HEAD');
        memo.clearBuffer();
        return;
    }

    if (isFresh) {
        const label = nonFlag.join(' ') || 'memo fresh slate';
        const hadMemos = memo.loadAllMemos().length > 0;
        if (hadMemos) {
            memo.snapshot(label);
        }
        memo.forgetAll();
        console.log(hadMemos ? `Fresh slate (previous memos snapshotted).` : 'Already clean.');
        memo.clearBuffer();
        return;
    }

    if (isBare) {
        await bare(args);
        return;
    }

    await bare(args);
}

export { main };

export default {
    ...META,
    main
};
