#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { PROJECT_ROOT } from '../lib/core.mjs';
import { listAllModules } from '../lib/modules.mjs';
import * as git from '../lib/git.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';
import { loadMemos } from '../lib/memo.mjs';
import { editFile } from '../lib/editor.mjs';

function stripCommitMessage(raw) {
    return raw
        .split('\n')
        .filter(line => !line.startsWith('#'))
        .join('\n')
        .replace(/\n+$/, '');
}

async function promptCommitChoice() {
    if (process.stdin.isTTY !== true) {
        return 'proceed';
    }

    const prompt = new Enquirer.Select({
        name: 'choice',
        message: 'How would you like to commit?',
        choices: [
            { name: 'proceed', message: 'Proceed with opencode summary' },
            { name: 'raw', message: 'Write a regular commit message' }
        ],
        initial: 0
    });

    try {
        return await prompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
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
        console.error('\nAborted.');
        process.exit(130);
    }
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
        initial: true
    });

    try {
        return await prompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

async function promptPromptFirstLine() {
    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; using the default prompt instruction line.');
        return DEFAULT_PROMPT_FIRST_LINE;
    }

    const prompt = new Enquirer.Input({
        name: 'firstLine',
        message: 'Edit the instruction line sent to opencode:',
        initial: DEFAULT_PROMPT_FIRST_LINE,
        result: v => v.trim()
    });

    try {
        const edited = await prompt.run();
        return edited || DEFAULT_PROMPT_FIRST_LINE;
    } catch {
        console.error('\nAborted.');
        process.exit(130);
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
    console.error(`$ opencode run "<prompt: ${prompt.length} bytes, ${prompt.split('\n').length} lines, first: "${promptFirstLine}">" -m ${model} --auto`);

    const result = spawnSync('opencode', args, {
        cwd: PROJECT_ROOT,
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
    if (args.includes('--help') || args.includes('-h')) {
        console.error('commit: Stage all changes, summarise them via opencode, then commit with $EDITOR');
        console.error('  Usage: node index.js commit [model]');
        console.error('  Offers two options: a) proceed with full opencode summary, b) write a regular');
        console.error('  git commit message.');
        console.error('  The index is only mutated right before commit; on interruption or empty');
        console.error('  commit message, `git restore --staged` reverts the index (non-destructive).');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        return;
    }

    const interactive = process.stdin.isTTY === true;

    const status = git.git('status', ['--short']);
    const diffStat = git.git('diff', ['HEAD', '--stat']);
    const diffFull = git.git('diff', ['HEAD']);

    const memoLines = listAllModules().flatMap(mod =>
        loadMemos(mod.name).map(content => `${mod.name}: ${content}`)
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
        console.error('Nothing to commit: working tree clean.');
        process.exit(0);
    }

    const choice = interactive
        ? await promptCommitChoice()
        : 'proceed';

    if (interactive && await promptPreview()) {
        previewDiff();
        const prompt = new Enquirer.Confirm({
            name: 'unstage',
            message: 'Continue?',
            initial: true
        });
        if (!await prompt.run()) {
            console.error('Aborted; restoring index (non-destructive).');
            git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
            process.exit(0);
        }
    }

    if (choice === 'raw') {
        stageAndCommit([]);
        return;
    }

    const model = await resolveModel(args);

    if (choice === 'proceed') {
        const modify = await promptModifyPrompt();
        const firstLine = modify
            ? await promptPromptFirstLine()
            : DEFAULT_PROMPT_FIRST_LINE;
        const summary = summariseAndShow(model, changelist, firstLine);

        if (!summary && !interactive) {
            console.error('No summary produced and not interactive; aborting.');
            process.exit(1);
        }

        const commitArgs = await buildCommitPlan(summary, interactive, modify);
        stageAndCommit(commitArgs);
        return;
    }
}

function summariseAndShow(model, changelist, firstLine) {
    console.error('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, firstLine);
    if (summary) {
        console.error(summary);
    } else {
        console.error('(no summary produced)');
    }
    console.error('--- end summary ---\n');
    return summary;
}

async function resolveModel(args) {
    const modelArg = args.find(a => !a.startsWith('-') && a);
    if (modelArg) return modelArg;
    const config = readOpendeConfig();
    return await promptModel(listModels(config), config.model);
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
    
    const editorChild = editFile(templateFile);
    
    await new Promise((resolve) => {
        editorChild.on('exit', (code) => resolve(code ?? 0));
    });
    
    const stripped = stripCommitMessage(fs.readFileSync(templateFile, 'utf-8'));
    try { fs.unlinkSync(templateFile); } catch { /* gone */ }
    
    if (!stripped) {
        console.error('Commit message erased; unstaging all changes so you can cherry-pick files.');
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        process.exit(0);
    }
    
    return ['-m', stripped];
}

function stageAndCommit(commitArgs) {
    process.on('SIGINT', () => {
        console.error('\nInterrupted; restoring index (non-destructive).');
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        process.exit(130);
    });

    // Only mutate the index if nothing is staged yet. If the user already
    // staged files manually, leave the index exactly as they set it.
    const staged = git.git('diff', ['--cached', '--name-only']);
    if (!staged.stdout.trim()) {
        const addResult = git.add([], { all: true, stdio: 'inherit' });
        if (!addResult.ok) {
            console.error(`git add failed (status ${addResult.status})`);
            process.exit(addResult.status ?? 1);
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
            process.exit(result.status ?? 1);
        }
    } catch (err) {
        console.error(`Commit failed: ${err.message}`);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main };

export default {
    name: 'commit',
    description: 'Stage all, summarise via opencode, then commit with $EDITOR',
    main
};
