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
        'Summarise the following staged git changelist as a concise commit message.'
    ];
    if (subject) {
        lines.push(
            `Use exactly "${subject}" as the first line, followed by two blank lines and a short body.`,
            'Infer the focus of the body from the first line and the changelist.',
            'Output only the commit message, no preamble or commentary.'
        );
    } else {
        lines.push(
            'Use the imperative mood for the subject line (<= 72 chars).',
            'Optionally follow with a blank line and a short body explaining the why.',
            'Output only the commit message, no preamble or commentary.'
        );
    }
    lines.push('', '--- staged changelist ---', changelist);
    const prompt = lines.join('\n');

    const args = ['run', prompt, '-m', model, '--auto'];
    console.error(`$ opencode ${args[0]} "<prompt>" ${args.slice(2).join(' ')}`);

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
        console.error('  Runs `git add -A`, asks opencode to summarise the staged changelist,');
        console.error('  then opens $EDITOR via `git commit -t <template>` pre-filled with the summary.');
        console.error('  Falls back to a plain `git commit` (empty editor) if no summary is produced.');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        return;
    }

    // 0. Confirm before proceeding, then prompt for an optional subject line
    const proceed = await confirmProceed();
    if (!proceed) {
        console.error('Aborted; no changes staged or committed.');
        process.exit(0);
    }
    const subject = await promptSubject();

    // 1. git add -A
    const addResult = git.add([], { all: true, stdio: 'inherit' });
    if (!addResult.ok) {
        console.error(`git add failed (status ${addResult.status})`);
        process.exit(addResult.status ?? 1);
    }

    // 2. Gather the staged changelist
    const status = git.git('status', ['--short']);
    const diff = git.git('diff', ['--cached', '--stat']);
    const changelist = `${status.stdout}${diff.stdout}`.trim();

    if (!changelist) {
        console.error('Nothing to commit: staged changelist is empty.');
        process.exit(0);
    }

    // 3. Resolve model
    const modelArg = args.find(a => !a.startsWith('-') && a);
    let model = modelArg;
    if (!model) {
        const config = readOpendeConfig();
        model = await promptModel(listModels(config), config.model);
    }

    // 4. Summarise via opencode
    console.error('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, subject);
    if (summary) {
        console.error(summary);
    } else {
        console.error('(no summary produced; opening editor with empty message)');
    }
    console.error('--- end summary ---\n');

    // 5. git commit: interactive -> editor via template; non-interactive -> -m directly.
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