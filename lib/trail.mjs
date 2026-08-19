import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { git } from './git.mjs';

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

export {
    fullScreenLimit,
    readCommits,
    readCommitFiles,
    readFullMessage,
    fileDiff,
    commitMemos,
    showInPager,
    buildTrailChoices,
    promptTrail,
    formatMemo
};
export default {
    readCommits,
    buildTrailChoices,
    promptTrail,
    showInPager,
    formatMemo
};
