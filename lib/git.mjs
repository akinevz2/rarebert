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

export default { git, add };