#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules, Module } from '../lib/modules.mjs';
import { git } from '../lib/git.mjs';
import { models } from '../lib/models.mjs';
import { memo } from '../lib/memo.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { opencode } from '../lib/opencode.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

const meta = {
    name: 'commit',
    description: 'Stage all changes, summarise them via opencode, then commit with $EDITOR',
    usage: 'node index.js commit [model] [--verbose]',
    options: [
        {
            flag: '--model <id>',
            description: 'opencode model id (otherwise prompted from opencode.json)'
        },
        { flag: '-v, --verbose', description: 'Print the full opencode prompt before the summary' }
    ]
};

function stripCommitMessage(raw) {
    return raw
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .replace(/\n+$/, '');
}

/**
 * Clean raw opencode output into a valid git commit message.
 *
 * opencode sometimes wraps its output in markdown fences, prepends
 * labels like "Commit message:" or "Here is...", or attaches trailing
 * commentary. Without cleaning, git either rejects the message as
 * empty (after fence stripping) or commits a malformed message that
 * looks like a chat transcript. This function:
 *
 *  1. Strips a leading/trailing markdown code fence (``` or ```text).
 *  2. Removes any preamble line(s) ending with ":" before the first
 *     blank line if they contain label-like text (e.g. "Commit message:").
 *  3. Removes trailing commentary after a closing fence or the last
 *     blank-line-delimited paragraph.
 *  4. Trims trailing blank lines.
 *
 * Returns the cleaned message, or '' if nothing usable remains.
 */
function cleanSummary(raw) {
    let text = (raw ?? '').trim();
    if (!text) return '';

    // Strip a wrapping markdown code fence. opencode frequently emits
    // ```text\n<message>\n``` or ```\n<message>\n```.
    const fenceOpen = text.match(/^```[^\n]*\n/);
    if (fenceOpen) {
        text = text.slice(fenceOpen[0].length);
        const fenceClose = text.match(/\n```\s*$/);
        if (fenceClose) text = text.slice(0, fenceClose.index);
    }
    text = text.trim();
    if (!text) return '';

    // Drop leading preamble lines that end with ":" and precede the
    // actual message (e.g. "Here is the commit message:" or "Sure:").
    // Stop at the first line that doesn't look like a label.
    const lines = text.split('\n');
    while (lines.length > 1) {
        const first = lines[0].trim();
        if (!first) {
            lines.shift();
            continue;
        }
        if (
            first.endsWith(':') &&
            first.length < 72 &&
            !/^(feat|fix|refactor|docs|test|chore|style|perf|build|ci)/i.test(first)
        ) {
            lines.shift();
            continue;
        }
        break;
    }
    text = lines.join('\n').trim();
    if (!text) return '';

    // Strip trailing commentary: if a closing fence appears mid-text,
    // drop everything from that fence onward (opencode often appends
    // "Let me know if..." after the fenced block).
    const trailingFence = text.search(/\n```\s*\n/);
    if (trailingFence >= 0) {
        text = text.slice(0, trailingFence).trim();
    }

    return text.replace(/\n+$/, '');
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
    // Do NOT unstage here. The only time we unstage is when the user
    // erases the entire commit message in the editor (editSummaryInEditor
    // returns null). Bailing at a prompt means the user chose not to
    // proceed — their staged files should remain staged so they can
    // rerun make commit or manually git commit.
    console.error(`Bailed: ${reason}.`);
    exit(0);
}

function previewDiff() {
    // Use the shared pipeToPager helper so colour and fallback handling are
    // consistent across all diff viewers.  Force --color=always since the
    // output is captured (not a TTY); the pager renders the ANSI codes.
    const staged = git.git('diff', ['--cached', '--name-only']);
    const diffArgs = staged.stdout.trim() ? ['--cached'] : ['HEAD'];
    const diff = git.git('diff', ['--color=always', ...diffArgs]);
    git.pipeToPager(diff.stdout);
}

const DEFAULT_PROMPT_FIRST_LINE = 'Write a git commit message for the staged changelist below.';

async function promptModifyPrompt() {
    if (process.stdin.isTTY !== true) {
        return false;
    }

    const prompt = new Enquirer.Confirm({
        name: 'modify',
        message: 'Modify the instruction line sent to opencode? (Yes = yeet the default)',
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

function summariseChangelist(model, changelist, firstLine, verbose = false) {
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

    const args = ['run', prompt, '-m', model, '--auto', '--format', 'json'];
    const promptFirstLine = prompt.split('\n')[0];
    console.log(
        `$ opencode run "<prompt: ${prompt.length} bytes, ${prompt.split('\n').length} lines, first: "${promptFirstLine}">" -m ${model} --auto --format json`
    );

    if (verbose) {
        console.log('\n--- opencode prompt ---');
        console.log(prompt);
        console.log('--- end prompt ---\n');
    }

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

    // Parse JSON event stream and extract text parts. The default format
    // can duplicate the model's output (the model sometimes emits its
    // response twice); JSON gives structured events with exactly one
    // text part per message.
    const text = (result.stdout ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            try {
                const evt = JSON.parse(line);
                if (evt.type === 'text' && evt.part?.text) return evt.part.text;
            } catch {
                /* non-JSON line — skip */
            }
            return '';
        })
        .filter(Boolean)
        .join('');

    return cleanSummary(text.trim());
}

async function main(opts, positional) {
    const interactive = process.stdin.isTTY === true;
    const verbose = opts.verbose;

    // Validate a user-supplied model id against opencode.json early so
    // typos and unfamiliar usage produce a clear error before any
    // interactive prompts or git operations run.
    const modelArg = positional[0];
    if (modelArg) {
        const known = models.list(models.readConfig());
        if (known.length > 0 && !known.some((m) => m.id === modelArg)) {
            console.error(
                `commit: unknown model "${modelArg}".\n` +
                    `Available models:\n` +
                    known.map((m) => `  ${m.id}${m.isDefault ? ' (default)' : ''}`).join('\n')
            );
            return exit(1);
        }
    }

    const status = git.git('status', ['--short']);
    const diffStat = git.git('diff', ['HEAD', '--stat']);
    const diffFull = git.git('diff', ['HEAD']);

    const memoLines = listAllModules().flatMap((mod) =>
        memo.loadMemos(mod.path).flatMap((m) => m.content.map((c) => `${mod.path}: ${c}`))
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

    // Non-interactive mode (stdin is not a TTY, e.g. piped or CI): the
    // commit module is inherently interactive (Enquirer prompts for
    // commit choice, preview, bail confirmations, and $EDITOR). Rather
    // than silently hanging or committing with no user input, error out
    // and ask the caller to run from a TTY. This prevents the previous
    // bug where piping (| head) would hang waiting for opencode.
    if (!interactive) {
        console.error(
            'commit: interactive mode required (stdin is not a TTY).\n' +
                'Run `node index.js commit` from a terminal, or use plain git for scripted commits.'
        );
        return exit(1);
    }

    const choice = await promptCommitChoice();

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
            // User declined to commit after previewing. Do NOT unstage —
            // they may want to rerun make commit or manually adjust.
            git.git('status', [], { stdio: 'inherit' });
            console.error('Aborted; staged files preserved.');
            return exit(0);
        }
    }

    if (choice === 'raw') {
        if (interactive && (await promptBail('Bail before writing a commit message by hand?'))) {
            bailCommit('declined raw commit');
        }
        // Raw mode: open $EDITOR with a blank template so the user writes
        // the commit message by hand. Passing [] to git commit would
        // invoke git's own editor, but going through editSummaryInEditor
        // gives us control over the template and the empty-message
        // bail behaviour (unstage only when the user erases everything).
        const commitArgs = await editSummaryInEditor('');
        if (!commitArgs) return exit(0);
        stageAndCommit(commitArgs);
        return;
    }

    const model = await models.resolve(modelArg);

    if (choice === 'proceed') {
        if (interactive && (await promptBail('Bail before running opencode summary?'))) {
            bailCommit('declined opencode summary');
        }

        const modify = await promptModifyPrompt();
        const firstLine = modify ? await promptPromptFirstLine() : DEFAULT_PROMPT_FIRST_LINE;
        const summary = summariseAndShow(model, changelist, firstLine, verbose);

        if (!summary) {
            console.error('No summary produced; aborting.');
            return exit(1);
        }

        // Ask the user if the summary looks good. Default is yes —
        // if accepted, commit directly with the summary text. If
        // rejected, open the editor so the user can refine it.
        const looksGood = await cli.confirm('Looks good?', true);
        if (looksGood) {
            stageAndCommit(['-m', summary]);
            return;
        }

        // User rejected — open editor with the summary as a starting point.
        const commitArgs = await editSummaryInEditor(summary);
        if (!commitArgs) return exit(0);
        stageAndCommit(commitArgs);
        return;
    }
}

function summariseAndShow(model, changelist, firstLine, verbose = false) {
    console.log('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, firstLine, verbose);
    if (summary) {
        console.log(summary);
    } else {
        console.log('(no summary produced)');
    }
    console.log('--- end summary ---\n');
    return summary;
}

async function editSummaryInEditor(summary) {
    const templateFile = path.join(os.tmpdir(), `rarebert-commit-${process.pid}.txt`);
    fs.writeFileSync(templateFile, summary + '\n');

    const editorChild = ide.spawnEditor(templateFile);
    const exitCode = editorChild ? await ide.awaitChild(editorChild) : 0;

    // Editor exited with a nonzero status — treat as abort. Unstage
    // all changes so the user can cherry-pick files or rerun.
    if (exitCode !== 0) {
        console.error(`Editor exited with status ${exitCode}; unstaging all changes.`);
        try {
            fs.unlinkSync(templateFile);
        } catch {
            /* gone */
        }
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        return null;
    }

    const stripped = stripCommitMessage(fs.readFileSync(templateFile, 'utf-8'));
    try {
        fs.unlinkSync(templateFile);
    } catch {
        /* gone */
    }

    if (!stripped) {
        // The user erased the entire commit message in the editor. This is
        // the ONLY case where we unstage (alongside nonzero editor exit):
        // it signals the user wants to completely bail on writing a commit
        // message for this changelist. They can rerun make commit for a
        // bulk commit, or manually git add and commit specific files.
        console.error('Commit message erased; unstaging all changes so you can cherry-pick files.');
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        return null;
    }

    return ['-m', stripped];
}

function stageAndCommit(commitArgs) {
    // Register an abort handler that fires only on Ctrl-C during the
    // commit. Capture the unsubscribe so we can deregister it on success
    // — otherwise process.on('exit') would fire runAbortCallbacks() after
    // a successful commit. On interrupt we do NOT unstage — the user can
    // rerun make commit or manually commit. Unstaging only happens when
    // the user erases the commit message in the editor.
    const offAbort = cli.onAbort(() => {
        console.error('\nInterrupted; staged files preserved.');
    });

    // Only mutate the index if nothing is staged yet. If the user already
    // staged files manually, leave the index exactly as they set it.
    const staged = git.git('diff', ['--cached', '--name-only']);
    if (!staged.stdout.trim()) {
        const addResult = git.add([], { all: true, stdio: 'inherit' });
        if (!addResult.ok) {
            console.error(`git add failed (status ${addResult.status})`);
            offAbort();
            exit(addResult.status ?? 1);
        }
    }

    try {
        const result = git.git('commit', commitArgs, { stdio: 'inherit' });
        if (result.status !== 0) {
            const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
            if (/empty commit message|Aborting commit/i.test(output)) {
                // Git rejected the commit (e.g. empty message from a failed
                // editor invocation). Do NOT unstage — the user can rerun
                // make commit or manually adjust.
                console.error('Empty commit message; staged files preserved.');
            } else {
                console.error(`git commit exited with status ${result.status}`);
            }
            offAbort();
            exit(result.status ?? 1);
        }
    } catch (err) {
        console.error(`Commit failed: ${err.message}`);
        offAbort();
        exit(1);
    }

    // Success — deregister the abort handler so it doesn't fire on exit.
    offAbort();
}

export { main };

const module = new Module('commit.mjs', main, meta);
export default module;
module.supportsDirectRunning(import.meta.url);
