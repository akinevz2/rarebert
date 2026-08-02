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
        console.error('  (skip opencode). Otherwise: opencode summarises the changelist (with full diff),');
        console.error('  then stages and commits. Non-interactive mode commits with -m directly;');
        console.error('  aborts if no summary is produced.');
        console.error('  The index is only mutated right before commit; on interruption or empty');
        console.error('  commit message, `git restore --staged` reverts the index (non-destructive).');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        return;
    }

    // 1. Confirm before proceeding, then prompt for an optional subject line
    const proceed = await confirmProceed();
    if (!proceed) {
        console.error('Aborted; no changes staged or committed.');
        process.exit(0);
    }
    const subject = await promptSubject();

    // 2. If changes are already staged, offer a plain commit (interactive only)
    //    so the user can write their own message without involving opencode.
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
                if (quick.status === 0) process.exit(0);
                console.error(`Plain commit failed (status ${quick.status}); continuing to summarise flow.`);
            }
        }
    }

    // 3. Gather the changelist WITHOUT mutating the index.
    //    Use HEAD diff (staged + unstaged) so opencode sees all pending changes.
    const status = git.git('status', ['--short']);
    const diffStat = git.git('diff', ['HEAD', '--stat']);
    const diffFull = git.git('diff', ['HEAD']);

    const memoLines = [];
    for (const mod of listAllModules()) {
        for (const content of loadMemos(mod.name)) {
            memoLines.push(`${mod.name}: ${content}`);
        }
    }

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

    // 4. Resolve model
    const modelArg = args.find(a => !a.startsWith('-') && a);
    let model = modelArg;
    if (!model) {
        const config = readOpendeConfig();
        model = await promptModel(listModels(config), config.model);
    }

    // 5. Summarise via opencode (index still untouched)
    console.error('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, subject);
    if (summary) {
        console.error(summary);
    } else {
        console.error('(no summary produced)');
    }
    console.error('--- end summary ---\n');

    // 6. Non-interactive with no summary: abort without touching the index.
    const interactive = process.stdin.isTTY === true;
    if (!summary && !interactive) {
        console.error('No summary produced and not interactive; aborting.');
        process.exit(1);
    }

    // 7. Stage everything and commit. The index is only mutated here.
    //    On SIGINT or empty commit message, restore the index with
    //    `git restore --staged` (non-destructive: only touches the index,
    //    never the working tree).
    //    In interactive mode we open $EDITOR on the prefilled summary
    //    ourselves (git's `-t` aborts on any unmodified template, which
    //    would prevent accepting the message as-is). After the editor
    //    closes we strip comment lines: an unmodified-but-non-empty
    //    message is committed as-is; an erased/empty message abandons.
    let commitArgs = [];
    let templateFile = null;
    if (summary) {
        if (interactive) {
            templateFile = path.join(os.tmpdir(), `rarebert-commit-${process.pid}.txt`);
            fs.writeFileSync(templateFile, summary + '\n');
            const editStatus = editFile(templateFile);
            if (editStatus !== 0) {
                console.error(`Editor exited with status ${editStatus}; abandoning.`);
                try { fs.unlinkSync(templateFile); } catch { /* gone */ }
                process.exit(editStatus);
            }
            const edited = stripCommitMessage(fs.readFileSync(templateFile, 'utf-8'));
            if (!edited) {
                console.error('Commit message erased; abandoning (no changes committed, index untouched).');
                try { fs.unlinkSync(templateFile); } catch { /* gone */ }
                process.exit(0);
            }
            commitArgs = ['-F', templateFile];
        } else {
            commitArgs = ['-m', summary];
        }
    }

    const addResult = git.add([], { all: true, stdio: 'inherit' });
    if (!addResult.ok) {
        console.error(`git add failed (status ${addResult.status})`);
        process.exit(addResult.status ?? 1);
    }

    process.on('SIGINT', () => {
        console.error('\nInterrupted; restoring index (non-destructive).');
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        process.exit(130);
    });

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