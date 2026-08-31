#!/usr/bin/env node

import { CLI, TUI, Interface, listAllModules } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import { models } from '../lib/models.mjs';
import { memo } from '../lib/memo.mjs';
import {
    promptCommitChoice,
    promptPreview,
    promptBail,
    bailCommit,
    previewDiff,
    promptModifyPrompt,
    promptPromptFirstLine,
    summariseAndShow,
    editSummaryInEditor,
    stageAndCommit,
    DEFAULT_PROMPT_FIRST_LINE,
    git
} from '../lib/git.mjs';

const meta = {
    name: 'commit',
    description: 'Stage all changes, summarise them via opencode, then commit with $EDITOR',
    usage: 'node index.js commit [model] [--verbose]',
    options: [
        {
            flag: '-m, --model <id>',
            description: 'opencode model id (overrides the default from opencode.json)'
        },
        { flag: '-v, --verbose', description: 'Print the full opencode prompt before the summary' }
    ]
};

async function main(opts, positional) {
    const interactive = process.stdin.isTTY === true;
    const verbose = opts.verbose;

    // Validate a user-supplied model id against opencode.json early so
    // typos and unfamiliar usage produce a clear error before any
    // interactive prompts or git operations run.
    const modelArg = opts.model;
    if (modelArg) {
        const known = models.list(models.readConfig());
        if (known.length > 0 && !known.some((m) => m.id === modelArg)) {
            return exit(1, () => {
                console.error(
                    `commit: unknown model "${modelArg}".\n` +
                        `Available models:\n` +
                        known.map((m) => `  ${m.id}${m.isDefault ? ' (default)' : ''}`).join('\n')
                );
            });
        }
    }
    const status = git.git('status', ['--porcelain']);
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
        return exit(0, () => console.log('Nothing to commit: working tree clean.'));
    }

    // Non-interactive mode (stdin is not a TTY, e.g. piped or CI): the
    // commit module is inherently interactive (Enquirer prompts for
    // commit choice, preview, bail confirmations, and $EDITOR). Rather
    // than silently hanging or committing with no user input, error out
    // and ask the caller to run from a TTY. This prevents the previous
    // bug where piping (| head) would hang waiting for opencode.
    if (!interactive) {
        return exit(1, () => {
            console.error(
                'commit: interactive mode required (stdin is not a TTY).\n' +
                    'Run `node index.js commit` from a terminal, or use plain git for scripted commits.'
            );
        });
    }

    return exit(
        new TUI(
            'commit.mjs',
            async (o = opts, p = positional) => {
                const iface = Interface.createInterface('commit');
                const choice = await promptCommitChoice();

                if (choice === 'later') {
                    git.git('status');
                    return exit(0);
                }

                if (await promptPreview()) {
                    previewDiff();
                    if (!(await iface.confirm('Are you ready to commit?', false))) {
                        git.git('status', [], { stdio: 'inherit' });
                        return exit(0, () => console.error('Aborted; staged files preserved.'));
                    }
                }

                if (choice === 'raw') {
                    if (await promptBail('Bail before writing a commit message by hand?')) {
                        bailCommit('declined raw commit');
                    }
                    const commitArgs = await editSummaryInEditor('');
                    if (!commitArgs) return exit(0);
                    stageAndCommit(commitArgs);
                    return exit(0);
                }

                const model = modelArg ? await models.resolve(modelArg) : models.resolveDefault();

                if (choice === 'proceed') {
                    if (await promptBail('Bail before running opencode summary?')) {
                        bailCommit('declined opencode summary');
                    }

                    const modify = await promptModifyPrompt();
                    const firstLine = modify
                        ? await promptPromptFirstLine()
                        : DEFAULT_PROMPT_FIRST_LINE;
                    const summary = summariseAndShow(model, changelist, firstLine, verbose);

                    if (!summary) {
                        return exit(1, () => console.error('No summary produced; aborting.'));
                    }

                    const looksGood = await iface.confirm('Looks good?', true);
                    if (looksGood) {
                        stageAndCommit(['-m', summary]);
                        return exit(0);
                    }

                    const commitArgs = await editSummaryInEditor(summary);
                    if (!commitArgs) return exit(0);
                    stageAndCommit(commitArgs);
                    return exit(0);
                }
            },
            meta
        )
    );
}

export default new CLI('commit.mjs', main, meta).supportsDirectRunning(import.meta.url);
