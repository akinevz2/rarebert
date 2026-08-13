#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { cli, CLI } from '../lib/module.mjs';
import {
    readCommits,
    readFullMessage,
    fileDiff,
    showInPager,
    buildTrailChoices,
    promptTrail,
    formatMemo
} from '../lib/trail.mjs';

const meta = {
    name: 'trail',
    description:
        'Walk the git history as a TrailLog: per-commit files, diffs, full messages, and memos tagged by module',
    usage: 'node index.js trail [--limit <n>]',
    options: [
        {
            flag: '--limit <n>',
            type: 'int',
            description: 'max commits to walk from HEAD (default 20)',
            default: 20
        }
    ]
};

export { meta };

export default new CLI('trail.mjs', async (opts, positional) => {
    if (!cli.isInteractive()) {
        cli.nonInteractive('trail requires an interactive terminal.');
        return;
    }

    const limit = opts.limit;
    const commits = readCommits(limit);
    if (commits.length === 0) {
        console.log('trail: no commits to display.');
        return exit(0);
    }

    const { choices, memoViews } = buildTrailChoices(commits);

    while (true) {
        let picked;
        try {
            picked = await promptTrail(choices);
        } catch {
            return exit(0);
        }

        if (!picked) return exit(0);

        const commitMatch = picked.match(/^commit\((.+)\):$/);
        if (commitMatch) {
            showInPager(readFullMessage(commitMatch[1]) + '\n');
            continue;
        }
        const fileMatch = picked.match(/^file\((.+)\):(.+):$/);
        if (fileMatch) {
            const [, filePath, sha] = fileMatch;
            showInPager(fileDiff(sha, filePath) || '(no diff)');
            continue;
        }
        if (picked.startsWith('memo-')) {
            const view = memoViews.get(picked);
            if (view) showInPager(formatMemo(view) + '\n');
            continue;
        }
    }
}, meta).supportsDirectRunning(import.meta.url);