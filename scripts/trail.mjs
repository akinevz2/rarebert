#!/usr/bin/env node

import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { git } from '../lib/git.mjs';
import { cli, CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';

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

    // Handle new format with header "N memos cached\n\n{JSON}"
    let payload;
    const newlineIdx = note.indexOf('\n\n');

    if (newlineIdx >= 0) {
        const header = note.slice(0, newlineIdx);
        payload = note.slice(newlineIdx + 2);

        // Check for new meta-object format header
        if (/^\d+ memo(?:s)? cached$/.test(header.trim())) {
            // New format with timestamp/modules structure
            try {
                const data = JSON.parse(payload);
                if (data && typeof data === 'object' && Array.isArray(data.modules)) {
                    return data.modules.map((m) => ({
                        module: m.name || m.path,
                        memos: Array.isArray(m.memos) ? m.memos : []
                    }));
                }
            } catch {}
        }
    } else {
        payload = note;
    }

    // Try parsing the content as JSON
    let snap;
    try {
        const data = JSON.parse(payload);
        if (data && typeof data === 'object' && Array.isArray(data.modules)) {
            return data.modules.map((m) => ({
                module: m.name || m.path,
                memos: Array.isArray(m.memos) ? m.memos : []
            }));
        }
        snap = data;
    } catch {
        return [];
    }

    // Legacy format: array of memo entries with .module and .memos
    if (!Array.isArray(snap)) return [];

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
                    message: '  ---',
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