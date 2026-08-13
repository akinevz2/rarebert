import { git } from './git.mjs';

/**
 * Run `git diff --color=always` with the given args and optionally
 * pipe through the pager. Returns the exit status.
 */
function showDiff(diffArgs, usePager) {
    const result = git.git('diff', ['--color=always', ...diffArgs]);
    if (result.status !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        return result.status ?? 1;
    }
    if (!result.stdout.trim()) {
        console.log('(no changes)');
        return 0;
    }
    if (!usePager) {
        process.stdout.write(result.stdout);
        return 0;
    }
    return git.pipeToPager(result.stdout);
}

export { showDiff };
export default { showDiff };