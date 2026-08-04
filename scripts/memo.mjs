#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { project } from '../lib/core.mjs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { memo } from '../lib/memo.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

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
    return cli.input('Enter memo content:', {
        initial,
        validate: (v) => (v.trim() ? true : 'required')
    });
}

function printAllMemos() {
    const all = memo.loadAllMemos();
    if (all.length === 0) {
        console.log('No memos found.');
        return false;
    }

    const flat = [];
    for (const { module, memos, lastModified } of all) {
        const rel = project.relPath(module.path);
        for (const content of memos) {
            flat.push({ rel, content, lastModified });
        }
    }
    flat.sort((a, b) => a.lastModified - b.lastModified);

    for (const { rel, content } of flat) {
        console.log(`${rel}  ${content}`);
    }
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

    printAllMemos();

    const moduleArg = nonFlag[0] || '';
    const memoContentArg = nonFlag.slice(1).join(' ');

    await addMemo(moduleArg, memoContentArg);
}

async function multiSelectMemos(moduleName) {
    const memos = memo.loadMemos(moduleName);
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
            JSON.stringify({ name: target.name, content: remaining, lastModified: Date.now() }) +
                '\n'
        );
    }
    console.log(`Dropped ${selected.length} memo(s) from ${project.relPath(target.path)}`);
}

async function forgetMemosForModule(moduleArg, recursive) {
    if (!moduleArg) {
        cli.fail('A module must be specified for --forget.');
    }
    const target = await promptModule(listAllModules(), moduleArg, 'Select module to forget memos');
    memo.forgetMemos(target.path, recursive);
    console.log(
        `Forgot memos for ${project.relPath(target.path)}${recursive ? ' (recursive)' : ''}`
    );
}

async function forgetAll() {
    if (process.stdin.isTTY === true) {
        if (!(await cli.confirm('Drop ALL memo files in the repo?', false))) return;
    }
    memo.forgetAll();
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

    if (isAll) {
        printAllMemos();
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

    if (isForgetAll) {
        await forgetAll();
        memo.clearBuffer();
        return;
    }

    if (isForget) {
        await forgetMemosForModule(nonFlag[0], flags.includes('--recursive'));
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
