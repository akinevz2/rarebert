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
        console.error('  After confirmation, if changes are already staged, offers a plain commit');
        console.error('  (skip opencode). Otherwise: `git add -A`, opencode summarises the staged');
        console.error('  changelist (with full diff), then opens $EDITOR via `git commit -t <template>`.');
        console.error('  Non-interactive mode commits with -m directly; aborts if no summary is produced.');
        console.error('  On interruption or empty commit message, the index is restored to its');
        console.error('  pre-run state (staged files unstaged; working tree never modified).');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        return;
    }

    // Snapshot the index before any mutation so we can restore it on
    // interruption (SIGINT) or a failed/empty commit. The working tree
    // is never modified by this script, so only the index needs restoring.
    const snapshot = git.git('diff', ['--cached', '--name-only']);
    const stagedBefore = snapshot.stdout.trim();

    let indexMutated = false;
    function restoreIndex() {
        if (!indexMutated) return;
        indexMutated = false;
        git.git('reset', ['HEAD', '--quiet'], { stdio: 'pipe' });
        if (stagedBefore) {
            const files = stagedBefore.split('\n');
            git.git('add', files, { stdio: 'pipe' });
        }
    }

    process.on('SIGINT', () => {
        console.error('\nInterrupted; restoring index to pre-run state.');
        restoreIndex();
        process.exit(130);
    });

    // 1. Confirm before proceeding, then prompt for an optional subject line
    const proceed = await confirmProceed();
    if (!proceed) {
        console.error('Aborted; no changes staged or committed.');
        process.exit(0);
    }
    const subject = await promptSubject();

    // 2. If changes are already staged, offer a plain commit (interactive only)
    //    so the user can write their own message without involving opencode.
    //    On failure, fall through to the summarise-and-commit flow.
    if (process.stdin.isTTY === true) {
        const staged = git.git('status', ['--short']);
        const hasStaged = staged.stdout.split('\n').some(l => /^[MADRC]/.test(l));
        if (hasStaged) {
            const skip = new (Enquirer.Confirm)({
                name: 'skip',
                message: 'Staged changes detected. Plain commit (skip opencode summary)?',
                initial: false
            });
            let doPlain = false;
            try { doPlain = await skip.run(); } catch { process.exit(130); }
            if (doPlain) {
                const quick = git.git('commit', [], { stdio: 'inherit' });
                if (quick.status === 0) {
                    indexMutated = false;
                    process.exit(0);
                }
                console.error(`Plain commit failed (status ${quick.status}); continuing to summarise flow.`);
            }
        }
    }

    // 3. git add -A
    const addResult = git.add([], { all: true, stdio: 'inherit' });
    if (!addResult.ok) {
        console.error(`git add failed (status ${addResult.status})`);
        restoreIndex();
        process.exit(addResult.status ?? 1);
    }
    indexMutated = true;

    // 4. Gather the staged changelist (status + full diff for content context)
    const status = git.git('status', ['--short']);
    const diffStat = git.git('diff', ['--cached', '--stat']);
    const diffFull = git.git('diff', ['--cached']);
    const changelist = [
        '--- status ---',
        status.stdout.trim(),
        '',
        '--- diffstat ---',
        diffStat.stdout.trim(),
        '',
        '--- full diff ---',
        diffFull.stdout.trim()
    ].join('\n');

    if (!status.stdout.trim()) {
        console.error('Nothing to commit: staged changelist is empty.');
        restoreIndex();
        process.exit(0);
    }

    // 5. Resolve model
    const modelArg = args.find(a => !a.startsWith('-') && a);
    let model = modelArg;
    if (!model) {
        const config = readOpendeConfig();
        model = await promptModel(listModels(config), config.model);
    }

    // 6. Summarise via opencode
    console.error('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, subject);
    if (summary) {
        console.error(summary);
    } else {
        console.error('(no summary produced; opening editor with empty message)');
    }
    console.error('--- end summary ---\n');

    // 7. git commit: interactive -> editor via template; non-interactive -> -m directly.
    //    In non-interactive mode, if no summary was produced, abort rather than
    //    opening an editor that would hang waiting for input.
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
    } else if (!interactive) {
        console.error('No summary produced and not interactive; aborting to avoid opening an editor.');
        restoreIndex();
        process.exit(1);
    }

    try {
        const result = git.git('commit', commitArgs, { stdio: 'inherit' });
        if (result.status !== 0) {
            console.error(`git commit exited with status ${result.status}`);
            restoreIndex();
            process.exit(result.status ?? 1);
        }
        indexMutated = false;
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