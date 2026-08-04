import { spawnSync } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';

const ALLOWED = new Set(['add', 'commit', 'restore', 'stash', 'status', 'diff', 'log', 'branch']);

export function git(subcommand, args = [], options = {}) {
    if (!ALLOWED.has(subcommand)) {
        throw new Error(`Disallowed git command: ${subcommand ?? '(none)'}`);
    }
    const flagArgs = [];
    if (options.all && subcommand === 'add') flagArgs.push('-A');
    if (options.message && subcommand === 'commit') flagArgs.push('-m', options.message);
    if (options.keepIndex && subcommand === 'stash') flagArgs.push('keep-index');
    const fullArgs = [subcommand, ...flagArgs, ...args];
    const result = spawnSync('git', fullArgs, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: options.stdio ?? 'pipe'
    });
    if (result.error) throw result.error;
    return {
        command: `git ${fullArgs.join(' ')}`,
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ok: result.status === 0
    };
}

export const add = (args = [], options = {}) => git('add', args, options);

export function statusPorcelain(pathspecs = []) {
    const r = git('status', ['--porcelain', ...pathspecs]);
    return r.stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => ({
            xy: l.slice(0, 2),
            path: l.slice(3).trim()
        }));
}

export function isTrackedModified(relPath) {
    const rows = statusPorcelain([relPath]);
    if (rows.length === 0) return false;
    return rows[0].xy[0] !== '?' && rows[0].xy[0] !== '!';
}

export function diffForPath(relPath, base = 'HEAD') {
    const r = git('diff', [base, '--', relPath]);
    return r.stdout;
}

export function stagedDiffForPath(relPath) {
    const r = git('diff', ['--cached', '--', relPath]);
    return r.stdout;
}

export default {
    git,
    add,
    statusPorcelain,
    isTrackedModified,
    diffForPath,
    stagedDiffForPath
};
