#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { PROJECT_ROOT } from '../lib/core.mjs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { remember, forgetAllMemos, forgetMemos, loadAllMemos, loadMemos } from '../lib/memo.mjs';
import { AbortError, confirm, input, nonInteractive, fail } from '../lib/cli.mjs';

const META = {
    name: 'memo',
    description: 'Inspect and mutate memos stored alongside modules',
    usage: 'node index.js memo [bare|--add|--all|--drop|--forget|--help]',
    options: [
        { flag: '', label: 'bare', description: 'Print all memos, then TUI to add one' },
        { flag: 'add', label: '--add', description: 'Add a memo non-interactively (skip TUI)' },
        { flag: 'all', label: '--all', description: 'Print all memos and exit' },
        {
            flag: 'drop',
            label: '--drop',
            description: 'Remove selected memos for a module (interactive)'
        },
        { flag: 'forget', label: '--forget', description: 'Forget all memos for a module' },
        {
            flag: 'forget-all',
            label: '--forget --all',
            description: 'Drop every memo file in the repo'
        },
        {
            flag: 'recursive',
            label: '--recursive',
            description: 'With --forget, also propagate to libs-owned memos'
        }
    ]
};

async function promptMemoContent(moduleName, initial = '') {
    return input('Enter memo content:', {
        initial,
        validate: (v) => (v.trim() ? true : 'required')
    });
}

function printAllMemos() {
    const all = loadAllMemos();
    if (all.length === 0) {
        console.log('No memos found.');
        return false;
    }
    for (const { module, memos, lastModified } of all) {
        const rel = path.relative(PROJECT_ROOT, module.path);
        const ts = new Date(lastModified).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`${module.name}  (${rel})  [${ts}]`);
        for (const content of memos) {
            console.log(`  - ${content}`);
        }
    }
    return true;
}

async function addMemo(moduleArg, memoContentArg) {
    const modules = listAllModules();
    if (modules.length === 0) {
        fail('No modules found.');
    }
    const target = await promptModule(modules, moduleArg, 'Select a module to memoize');
    const memoContent = memoContentArg.trim() || (await promptMemoContent(target.name));
    remember(target.name, memoContent);
    console.log(`\x1b[33m✓\x1b[0m Memo added to ${path.relative(PROJECT_ROOT, target.path)}`);
    console.log(`  When run, prints: ${target.name}: ${memoContent}`);
    if (process.env.FORGET) {
        console.log('>>FORGET env var is set: memo array will drop previous memos.');
    }
}

async function bare(args) {
    const hadMemos = printAllMemos();

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    if (nonFlag.length >= 2) {
        await addMemo(nonFlag[0], nonFlag.slice(1).join(' '));
        return;
    }

    if (!hadMemos) {
        const proceed = await confirm('No memos found. Add one now?', true);
        if (!proceed) return;
    }

    const action = await promptChoice(['add', 'exit'], 'What next?', 'Add a memo or exit');
    if (action === 'add') {
        const moduleArg = nonFlag[0] || '';
        await addMemo(moduleArg, '');
    }
}

async function promptChoice(choices, message, name = 'choice') {
    const prompt = new Enquirer.Select({
        name,
        message,
        choices: choices.map((c) => ({ name: c, message: c }))
    });
    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

async function multiSelectMemos(moduleName) {
    const memos = loadMemos(moduleName);
    if (!memos.length) return [];

    const prompt = new Enquirer.MultiSelect({
        name: 'memos',
        message: `Select memos to drop for ${moduleName}:`,
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

async function dropMemos(moduleArg) {
    if (!moduleArg) {
        fail("A memo'd module must be specified for --drop.");
    }
    if (process.stdin.isTTY !== true) {
        nonInteractive('cannot prompt for memo selection.');
    }

    const target = await promptModule(
        listAllModules(),
        moduleArg,
        'Select module to drop memos from'
    );
    const selected = await multiSelectMemos(target.name);
    if (!selected.length) {
        console.log('No memos selected; nothing dropped.');
        return;
    }

    const remaining = loadMemos(target.name).filter((c) => !selected.includes(c));
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
            JSON.stringify({ name: target.name, content: remaining, lastModified: Date.now() }) +
                '\n'
        );
    }
    console.log(`Dropped ${selected.length} memo(s) from ${target.name}`);
}

async function forgetMemosForModule(moduleArg, recursive) {
    if (!moduleArg) {
        fail('A module must be specified for --forget.');
    }
    const target = await promptModule(listAllModules(), moduleArg, 'Select module to forget memos');
    forgetMemos(target.name, recursive);
    console.log(`Forgot memos for ${target.name}${recursive ? ' (recursive)' : ''}`);
}

async function forgetAll() {
    if (process.stdin.isTTY === true) {
        if (!(await confirm('Drop ALL memo files in the repo?', false))) return;
    }
    forgetAllMemos();
    console.log('Dropped all memo files.');
}

async function main(args = []) {
    const flags = args.filter((a) => a.startsWith('-'));
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);

    const isForget = flags.includes('--forget');
    const isForgetAll = flags.includes('--forget') && flags.includes('--all');
    const isAll = flags.includes('--all') && !isForget;
    const isDrop = flags.includes('--drop');
    const isAdd = flags.includes('--add');
    const isBare = !flags.length && !nonFlag.length;

    if (isBare) {
        await bare(args);
        return;
    }

    if (isAdd) {
        await addMemo(nonFlag[0], nonFlag.slice(1).join(' '));
        return;
    }

    if (isAll) {
        printAllMemos();
        return;
    }

    if (isDrop) {
        await dropMemos(nonFlag[0]);
        return;
    }

    if (isForgetAll) {
        await forgetAll();
        return;
    }

    if (isForget) {
        await forgetMemosForModule(nonFlag[0], flags.includes('--recursive'));
        return;
    }

    await bare(args);
}

export { main };

export default {
    ...META,
    main
};
