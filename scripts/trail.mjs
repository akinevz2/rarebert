#!/usr/bin/env node

import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { exit } from '../lib/core.mjs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';
import { Module } from '../lib/modules.mjs';

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

function fullScreenLimit() {
    return Math.max(8, (process.stdout.rows || 24) - 4);
}

function readCommits(limit) {
    const r = git.git('log', [`--pretty=format:%H%x00%s`, `--max-count=${limit}`]);
    if (!r.ok) return [];
    return r.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [sha, subject] = line.split('\0');
            return { sha, subject };
        });
}

function readCommitFiles(sha) {
    const r = git.git('show', ['--name-status', '--pretty=format:', sha]);
    if (!r.ok) return [];
    return r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
            const [status, ...rest] = line.split('\t');
            return { status, path: rest.join('\t') };
        });
}

function readFullMessage(sha) {
    const r = git.git('show', ['-s', '--pretty=format:%B', sha]);
    return r.ok ? r.stdout.trim() : '';
}

function fileDiff(sha, filePath) {
    const r = git.git('diff', [`${sha}^`, sha, '--', filePath]);
    return r.stdout;
}

function commitMemos(sha) {
    const note = git.notesShow(sha);
    if (!note) return [];
    const newlineIdx = note.indexOf('\n\n');
    const payload = newlineIdx >= 0 ? note.slice(newlineIdx + 2) : note;
    let snap;
    try {
        snap = JSON.parse(payload);
    } catch {
        return [];
    }
    return snap.map((entry) => ({
        module: entry.module?.name || entry.module?.path || 'unknown',
        memos: entry.memos || []
    }));
}

function showInPager(content) {
    const pager = process.env.PAGER || 'less';
    const child = spawnSync(pager, [], {
        input: content,
        stdio: ['pipe', 'inherit', 'inherit']
    });
    if (child.error) {
        console.error(`Failed to launch pager (${pager}): ${child.error.message}`);
        process.stdout.write(content);
    }
}

function buildTrailChoices(commits) {
    const choices = [];
    const memoViews = new Map();

    const push = (entry) => choices.push(entry);
    const sep = () => push({ role: 'separator', name: `sep:${choices.length}` });

    commits.forEach((c, ci) => {
        const shortSha = c.sha.slice(0, 8);
        const files = readCommitFiles(c.sha);
        const subscript = files.map((f) => f.path).join(', ');

        if (ci > 0) sep();

        push({
            name: `commit(${c.sha}):`,
            message: `${shortSha} ${c.subject}`
        });
        for (const f of files) {
            push({
                name: `file(${f.path}):${c.sha}:`,
                message: `  ${f.status}  ${f.path}`
            });
        }
        for (const m of commitMemos(c.sha)) {
            sep();
            for (const content of m.memos) {
                const name = `memo-${m.module}(${c.sha}):${content.slice(0, 40)}`;
                memoViews.set(name, {
                    header: `${shortSha}->${m.module}`,
                    body: content,
                    subscript
                });
                push({
                    name,
                    message: `  memo(${shortSha}): ${content.slice(0, 40)}`
                });
                push({
                    name: `tapeoff:${name}`,
                    message: `  ---`,
                    disabled: true,
                    hint: ''
                });
                push({
                    name: `subscript:${name}`,
                    message: `  mod: ${subscript}`,
                    disabled: true,
                    hint: ''
                });
            }
        }
    });
    return { choices, memoViews };
}

async function promptTrail(choices) {
    const prompt = new Enquirer.Select({
        name: 'trail',
        message: 'TrailLog (enter to open, q/esc to close)',
        choices,
        initial: 0,
        limit: fullScreenLimit()
    });
    prompt.on('keypress', (input) => {
        if (input === 'q') prompt.cancel();
    });
    return prompt.run();
}

function formatMemo(view) {
    return [view.header, '---', view.body, '---', `mod: ${view.subscript}`].join('\n');
}

async function main(opts, positional) {
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
}

export { main };

const module = new Module('trail.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
