#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules } from '../lib/modules.mjs';
import { git } from '../lib/git.mjs';
import { models } from '../lib/models.mjs';
import { memo } from '../lib/memo.mjs';
import { editor } from '../lib/editor.mjs';
import { opencode } from '../lib/opencode.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

const meta = {
    name: 'commit',
    description: 'Stage all changes, summarise them via opencode, then commit with $EDITOR',
    usage: 'node index.js commit [model]',
    options: [
        { label: 'model', description: 'opencode model id (otherwise prompted from opencode.json)' }
    ]
};

function stripCommitMessage(raw) {
    return raw
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .replace(/\n+$/, '');
}

async function promptCommitChoice() {
    if (process.stdin.isTTY !== true) {
        return 'raw';
    }

    const prompt = new Enquirer.Select({
        name: 'choice',
        message: 'How would you like to commit?',
        choices: [
            { name: 'proceed', message: 'Proceed with opencode summary' },
            { name: 'later', message: 'Just return me to the shell' },
            { name: 'raw', message: 'Write a regular commit message' }
        ],
        initial: 0
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

async function promptPreview() {
    if (process.stdin.isTTY !== true) {
        return false;
    }

    const prompt = new Enquirer.Confirm({
        name: 'preview',
        message: 'Preview staged changes?',
        initial: true
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

async function promptBail(message) {
    if (process.stdin.isTTY !== true) {
        return false;
    }

    const prompt = new Enquirer.Confirm({
        name: 'bail',
        message,
        initial: false
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

function bailCommit(reason) {
    const staged = git.git('diff', ['--cached', '--name-only']);
    if (staged.stdout.trim()) {
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
    }
    console.error(`Bailed: ${reason}; index restored (non-destructive).`);
    exit(0);
}

function previewDiff() {
    const pager = process.env.PAGER || 'less';
    const staged = git.git('diff', ['--cached', '--name-only']);
    const diffArgs = staged.stdout.trim() ? ['--cached'] : ['HEAD'];
    const diff = git.git('diff', diffArgs);
    const child = spawnSync(pager, [], {
        input: diff.stdout,
        stdio: ['pipe', 'inherit', 'inherit']
    });
    if (child.error) {
        console.error(`Failed to launch pager (${pager}): ${child.error.message}`);
    }
}

const DEFAULT_PROMPT_FIRST_LINE = 'Write a git commit message for the staged changelist below.';

async function promptModifyPrompt() {
    if (process.stdin.isTTY !== true) {
        return false;
    }

    const prompt = new Enquirer.Confirm({
        name: 'modify',
        message: 'Modify the instruction line sent to opencode? (No = yeet the default)',
        initial: false
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

async function promptPromptFirstLine() {
    if (process.stdin.isTTY !== true) {
        console.log('Non-interactive; using the default prompt instruction line.');
        return DEFAULT_PROMPT_FIRST_LINE;
    }

    const prompt = new Enquirer.Input({
        name: 'firstLine',
        message: 'Edit the instruction line sent to opencode:',
        initial: DEFAULT_PROMPT_FIRST_LINE,
        result: (v) => v.trim()
    });

    try {
        const edited = await prompt.run();
        return edited || DEFAULT_PROMPT_FIRST_LINE;
    } catch {
        throw new AbortError();
    }
}

function summariseChangelist(model, changelist, firstLine) {
    const prompt = [
        firstLine,
        'Strict rules (do not violate any):',
        '1. First line: imperative mood, STRICTLY 72 characters or fewer. Count them.',
        '2. One blank line after the first line.',
        '3. A body of 2-4 lines wrapped at 72 columns explaining why the change was made.',
        '4. Output ONLY the commit message — no preamble, no commentary, no markdown fences.',
        '5. Keep every line under 72 characters wide.',
        '',
        '--- staged changelist ---',
        changelist
    ].join('\n');

    const args = ['run', prompt, '-m', model, '--auto'];
    const promptFirstLine = prompt.split('\n')[0];
    console.log(
        `$ opencode run "<prompt: ${prompt.length} bytes, ${prompt.split('\n').length} lines, first: "${promptFirstLine}">" -m ${model} --auto`
    );

    const result = spawnSync(opencode.resolve(), args, {
        cwd: rarebert.root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit']
    });

    if (result.error) {
        console.error(`Failed to launch opencode: ${result.error.message}`);
        return '';
    }
    if (result.status !== 0) {
        console.error(`opencode exited with status ${result.status}; continuing without summary.`);
        return '';
    }
    return (result.stdout ?? '').trim();
}

async function main(args = []) {
    const interactive = process.stdin.isTTY === true;

    const status = git.git('status', ['--short']);
    const diffStat = git.git('diff', ['HEAD', '--stat']);
    const diffFull = git.git('diff', ['HEAD']);

    const memoLines = listAllModules().flatMap((mod) =>
        memo.loadMemos(mod.path).map((content) => `${mod.path}: ${content}`)
    );

    const changelist = [
        '--- status ---',
        status.stdout.trim(),
        '',
        '--- diffstat ---',
        diffStat.stdout.trim(),
        '',
        '--- full diff ---',
        diffFull.stdout.trim(),
        '',
        '--- memos ---',
        memoLines.join('\n')
    ].join('\n');

    if (!status.stdout.trim()) {
        console.log('Nothing to commit: working tree clean.');
        return exit(0);
    }

    const choice = interactive ? await promptCommitChoice() : 'later';


    if (choice === 'later') {
        git.git('status');
        return;
    }

    if (interactive && (await promptPreview())) {
        previewDiff();
        const prompt = new Enquirer.Confirm({
            name: 'unstage',
            message: 'Are you ready to commit?',
            initial: false
        });
        if (!(await prompt.run())) {
            git.git('status', [], { stdio: 'inherit' });
            // print the staged files
            git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
            console.error('Aborted; restored index (non-destructive).');
            return exit(0);
        }
    }

    if (choice === 'raw' || !interactive) {
        if (interactive && (await promptBail('Bail before writing a commit message by hand?'))) {
            bailCommit('declined raw commit');
        }
        stageAndCommit([]);
        return;
    }

    const model = await models.resolve(args.find((a) => !a.startsWith('-') && a));

    if (choice === 'proceed') {
        if (interactive && (await promptBail('Bail before running opencode summary?'))) {
            bailCommit('declined opencode summary');
        }

        const modify = await promptModifyPrompt();
        const firstLine = modify ? await promptPromptFirstLine() : DEFAULT_PROMPT_FIRST_LINE;
        const summary = summariseAndShow(model, changelist, firstLine);

        if (!summary && !interactive) {
            console.error('No summary produced and not interactive; aborting.');
            return exit(1);
        }

        if (interactive && (await promptBail('Summary looks bad — bail instead of editing it?'))) {
            bailCommit('declined opencode summary output');
        }

        const commitArgs = await buildCommitPlan(summary, interactive, modify);
        stageAndCommit(commitArgs);
        return;
    }
}

function summariseAndShow(model, changelist, firstLine) {
    console.log('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, firstLine);
    if (summary) {
        console.log(summary);
    } else {
        console.log('(no summary produced)');
    }
    console.log('--- end summary ---\n');
    return summary;
}

function buildCommitPlan(summary, interactive, yeet = false) {
    if (summary && interactive && !yeet) {
        return editSummaryInEditor(summary);
    }
    if (summary) {
        return Promise.resolve(['-m', summary]);
    }
    return Promise.resolve([]);
}

async function editSummaryInEditor(summary, interactive) {
    const templateFile = path.join(os.tmpdir(), `rarebert-commit-${process.pid}.txt`);
    fs.writeFileSync(templateFile, summary + '\n');

    const editorChild = editor.editFile(templateFile);

    await new Promise((resolve) => {
        editorChild.on('exit', (code) => resolve(code ?? 0));
    });

    const stripped = stripCommitMessage(fs.readFileSync(templateFile, 'utf-8'));
    try {
        fs.unlinkSync(templateFile);
    } catch {
        /* gone */
    }

    if (!stripped) {
        console.error('Commit message erased; unstaging all changes so you can cherry-pick files.');
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        exit(0);
    }

    return ['-m', stripped];
}

function stageAndCommit(commitArgs) {
    cli.onAbort(() => {
        console.error('\nInterrupted; restoring index (non-destructive).');
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
    });

    // Only mutate the index if nothing is staged yet. If the user already
    // staged files manually, leave the index exactly as they set it.
    const staged = git.git('diff', ['--cached', '--name-only']);
    if (!staged.stdout.trim()) {
        const addResult = git.add([], { all: true, stdio: 'inherit' });
        if (!addResult.ok) {
            console.error(`git add failed (status ${addResult.status})`);
            exit(addResult.status ?? 1);
        }
    }

    try {
        const result = git.git('commit', commitArgs, { stdio: 'inherit' });
        if (result.status !== 0) {
            const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
            if (/empty commit message|Aborting commit/i.test(output)) {
                console.error('Empty commit message; restoring index (non-destructive).');
                git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
            } else {
                console.error(`git commit exited with status ${result.status}`);
            }
            exit(result.status ?? 1);
        }
    } catch (err) {
        console.error(`Commit failed: ${err.message}`);
        exit(1);
    }
}

export { main };

export default {
    name: 'commit',
    description: 'Stage all, summarise via opencode, then commit with $EDITOR',
    main: cli.run(meta, main)
};
