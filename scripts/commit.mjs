#!/usr/bin/env node

import { cli, CLI, TUI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
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
    Enquirer,
    models,
    git,
    memo,
    listAllModules
} from '../lib/git.mjs';

const meta = {
    name: 'commit',
    description: 'Stage all changes, summarise them via opencode, then commit with $EDITOR',
    usage: 'node index.js commit [model] [--verbose]',
    options: [
        {
            flag: '--model <id>',
            description: 'opencode model id (otherwise prompted from opencode.jsonc)'
        },
        { flag: '-v, --verbose', description: 'Print the full opencode prompt before the summary' }
    ]
};

async function mainMenu(opts, positional) {
    const interactive = process.stdin.isTTY === true;
    const verbose = opts.verbose;

    // Validate a user-supplied model id against opencode.jsonc early so
    // typos and unfamiliar usage produce a clear error before any
    // interactive prompts or git operations run.
    const modelArg = positional[0];
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
            return exit(0, () => console.error('Aborted; staged files preserved.'));
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
            return exit(1, () => console.error('No summary produced; aborting.'));
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

const tui = new TUI('commit.mjs', mainMenu, meta);

// CLI errors non-interactive; delegates to TUI when interactive
export default new CLI(
    'commit.mjs',
    async () => {
        if (cli.isInteractive()) return tui.execute([]);
        cli.nonInteractive(
            'commit: interactive mode required (stdin is not a TTY).\n' +
                'Run `node index.js commit` from a terminal.'
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
