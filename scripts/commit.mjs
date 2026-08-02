#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { PROJECT_ROOT } from '../lib/core.mjs';
import * as git from '../lib/git.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';

async function confirmProceed(message = 'Proceed with autocommit?') {
    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; proceeding with autocommit.');
        return true;
    }

    const prompt = new Enquirer.Confirm({
        name: 'proceed',
        message,
        initial: true
    });

    try {
        return await prompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

async function promptSubject() {
    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; letting opencode write the full commit message.');
        return '';
    }

    const prompt = new Enquirer.Input({
        name: 'subject',
        message: 'Commit first line (leave empty to let opencode write the whole message)',
        result: v => v.trim()
    });

    try {
        return await prompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

function summariseChangelist(model, changelist, subject) {
    const lines = [
        'Write a git commit message for the staged changelist below.',
        'Strict rules (do not violate any):',
        '1. First line: imperative mood, STRICTLY 72 characters or fewer. Count them.',
        '2. One blank line after the first line.',
        '3. A body of 2-4 lines wrapped at 72 columns explaining why the change was made.',
        '4. Output ONLY the commit message — no preamble, no commentary, no markdown fences.'
    ];
    if (subject) {
        lines.push(
            `5. Use exactly "${subject}" as the first line (it must still be <= 72 chars; truncate if needed).`,
            '6. Infer the body focus from the first line and the changelist.'
        );
    } else {
        lines.push('5. Infer the subject and body from the changelist.');
    }
    lines.push('', '--- staged changelist ---', changelist);
    const prompt = lines.join('\n');

    const args = ['run', prompt, '-m', model, '--auto'];
    const firstLine = prompt.split('\n')[0];
    console.error(`$ opencode run "<prompt: ${prompt.length} bytes, ${prompt.split('\n').length} lines, first: "${firstLine}">" -m ${model} --auto`);

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
        console.error('  If changes are already staged, first attempts a plain `git commit`;');
        console.error('  on failure, unstages the pending changeset and falls through to the');
        console.error('  full flow: `git add -A`, opencode summarises the staged changelist,');
        console.error('  then opens $EDITOR via `git commit -t <template>` pre-filled with the summary.');
        console.error('  Falls back to a plain `git commit` (empty editor) if no summary is produced.');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        return;
    }

    // 0. Short-circuit (interactive only): if anything is already staged,
    //    try a plain `git commit` so the user can write their own message.
    //    On failure, unstage the whole changeset and fall through to the
    //    full summarise-and-commit flow.
    if (process.stdin.isTTY === true) {
        const staged = git.git('status', ['--short']);
        const hasStaged = staged.stdout.split('\n').some(l => /^[MADRC]/.test(l));
        if (hasStaged) {
            console.error('Staged changes detected; attempting plain commit...');
            const quick = git.git('commit', [], { stdio: 'inherit' });
            if (quick.status === 0) {
                process.exit(0);
            }
            console.error(`Plain commit failed (status ${quick.status}); unstaging pending changeset and continuing.`);
            git.git('reset', ['HEAD'], { stdio: 'inherit' });
        }
    }

    // 1. Confirm before proceeding, then prompt for an optional subject line
    const proceed = await confirmProceed();
    if (!proceed) {
        console.error('Aborted; no changes staged or committed.');
        process.exit(0);
    }
    const subject = await promptSubject();

    // 2. git add -A
    const addResult = git.add([], { all: true, stdio: 'inherit' });
    if (!addResult.ok) {
        console.error(`git add failed (status ${addResult.status})`);
        process.exit(addResult.status ?? 1);
    }

    // 3. Gather the staged changelist
    const status = git.git('status', ['--short']);
    const diff = git.git('diff', ['--cached', '--stat']);
    const changelist = `${status.stdout}${diff.stdout}`.trim();

    if (!changelist) {
        console.error('Nothing to commit: staged changelist is empty.');
        process.exit(0);
    }

    // 4. Resolve model
    const modelArg = args.find(a => !a.startsWith('-') && a);
    let model = modelArg;
    if (!model) {
        const config = readOpendeConfig();
        model = await promptModel(listModels(config), config.model);
    }

    // 5. Summarise via opencode
    console.error('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, subject);
    if (summary) {
        console.error(summary);
    } else {
        console.error('(no summary produced; opening editor with empty message)');
    }
    console.error('--- end summary ---\n');

    // 6. git commit: interactive -> editor via template; non-interactive -> -m directly.
    //    `git commit -t <template>` aborts when the editor doesn't modify the file
    //    (e.g. no TTY), so in non-interactive mode we pass the summary with -m instead.
    const interactive = process.stdin.isTTY === true;
    let commitArgs = [];
    let templateFile = null;
    if (summary) {
        if (interactive) {
            templateFile = path.join(os.tmpdir(), `rarebert-commit-${process.pid}.txt`);
            fs.writeFileSync(templateFile, summary + '\n');
            commitArgs = ['-t', templateFile];
        } else {
            commitArgs = ['-m', summary];
        }
    }

    try {
        const result = git.git('commit', commitArgs, { stdio: 'inherit' });
        if (result.status !== 0) {
            console.error(`git commit exited with status ${result.status}`);
            process.exit(result.status ?? 1);
        }
    } finally {
        if (templateFile) {
            try { fs.unlinkSync(templateFile); } catch { /* already removed */ }
        }
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