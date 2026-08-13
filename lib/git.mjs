import { spawnSync } from 'child_process';
import { rarebert } from './projects.mjs';
import { cli } from './module.mjs';

const ALLOWED = new Set([
    'add',
    'commit',
    'fetch',
    'merge',
    'restore',
    'stash',
    'status',
    'diff',
    'log',
    'branch',
    'notes',
    'rev-parse',
    'rev-list',
    'remote',
    'show',
    'cat-file'
]);

class Git {
    constructor(root = rarebert.root) {
        this.root = root;
    }

    git(subcommand, args = [], options = {}) {
        if (!ALLOWED.has(subcommand)) {
            throw new Error(`Disallowed git command: ${subcommand ?? '(none)'}`);
        }
        const flagArgs = [];
        if (options.all && subcommand === 'add') flagArgs.push('-A');
        if (options.message && subcommand === 'commit') flagArgs.push('-m', options.message);
        if (options.keepIndex && subcommand === 'stash') flagArgs.push('keep-index');
        const fullArgs = [subcommand, ...flagArgs, ...args];
        const result = spawnSync('git', fullArgs, {
            cwd: this.root,
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

    add(args = [], options = {}) {
        return this.git('add', args, options);
    }

    statusPorcelain(pathspecs = []) {
        const r = this.git('status', ['--porcelain', ...pathspecs]);
        return r.stdout
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => ({
                xy: l.slice(0, 2),
                path: l.slice(3).trim()
            }));
    }

    isTrackedModified(relPath) {
        const rows = this.statusPorcelain([relPath]);
        if (rows.length === 0) return false;
        return rows[0].xy[0] !== '?' && rows[0].xy[0] !== '!';
    }

    diffForPath(relPath, base = 'HEAD') {
        const r = this.git('diff', [base, '--', relPath]);
        return r.stdout;
    }

    stagedDiffForPath(relPath) {
        const r = this.git('diff', ['--cached', '--', relPath]);
        return r.stdout;
    }

    notesAdd(content, ref = 'HEAD', notesRef = 'refs/notes/memos') {
        const r = this.git('notes', ['--ref', notesRef, 'add', '-f', '-m', content, ref]);
        return r.ok;
    }

    notesShow(ref = 'HEAD', notesRef = 'refs/notes/memos') {
        const r = this.git('notes', ['--ref', notesRef, 'show', ref]);
        return r.ok ? r.stdout.trim() : null;
    }

    notesLog(notesRef = 'refs/notes/memos', limit = 20) {
        const list = this.git('notes', ['--ref', notesRef, 'list']);
        if (!list.ok) return [];
        const allPairs = list.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => l.split(' '))
            .map(([noteHash, targetHash]) => targetHash);
        // limit = -1 (or any negative) means "all entries"
        const pairs = limit >= 0 ? allPairs.slice(0, limit) : allPairs;

        return pairs
            .map((targetHash) => {
                const r = this.git('log', ['--pretty=format:%ai', '--max-count=1', targetHash]);
                if (!r.ok) return null;
                const date = r.stdout.trim();
                const note = this.notesShow(targetHash, notesRef) || '';
                const subject = note.split('\n')[0] || '(no subject)';
                return { hash: targetHash, date, subject };
            })
            .filter(Boolean)
            .reverse();
    }

    headRef() {
        const r = this.git('rev-parse', ['HEAD']);
        return r.ok ? r.stdout.trim() : null;
    }

    /** Full `git status --porcelain=v1 -b` output (branch line + file entries). */
    statusSummary() {
        return this.git('status', ['--porcelain=v1', '-b']).stdout.trim();
    }

    /** Raw `git diff HEAD` output (uncoloured by default; git controls colour). */
    diffSummary() {
        return this.git('diff', ['HEAD']).stdout.trim();
    }

    /** `git diff --stat` one-line-per-file summary. */
    diffStat() {
        return this.git('diff', ['--stat']).stdout.trim();
    }

    /**
     * Branch and upstream info.
     *
     * @returns {{ branch: string, upstream: string, aheadBehind: string }}
     */
    branchInfo() {
        const branch = this.git('branch', ['--show-current']).stdout.trim() || '(detached)';
        const upstream = this.git('rev-parse', ['--abbrev-ref', '@{upstream}'])
            .stdout.trim()
            .replace(/^fatal:.*/, '(no upstream)');
        let aheadBehind = '(n/a)';
        if (upstream !== '(no upstream)') {
            aheadBehind = this.git('rev-list', [
                '--left-right',
                '--count',
                `HEAD...${upstream}`
            ]).stdout.trim();
        }
        return { branch, upstream, aheadBehind };
    }

    /** `git remote -v` output. */
    remoteInfo() {
        const r = this.git('remote', ['-v']).stdout.trim();
        return r || '(no remotes)';
    }

    /**
     * Pipe text through a pager (`less -R` by default) so ANSI colour
     * codes are rendered.  Falls back to writing directly to stdout if the
     * pager binary is missing or fails to spawn — the coloured text is
     * always preserved, never lost.
     *
     * Respects $PAGER when set (assumed to already handle raw control
     * codes, e.g. `less -RFX`, `most`).
     *
     * @param {string} text - pre-coloured text to display
     * @returns {number} pager exit status, or 0 on fallback
     */
    pipeToPager(text) {
        if (!text) return 0;
        const pager = process.env.PAGER || 'less -R';
        const parts = pager.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const args = parts.slice(1);
        try {
            const child = spawnSync(cmd, args, {
                input: text,
                stdio: ['pipe', 'inherit', 'inherit']
            });
            if (child.error) {
                console.error(`Failed to launch pager (${pager}): ${child.error.message}`);
                process.stdout.write(text);
                return 0;
            }
            return child.status ?? 0;
        } catch (err) {
            console.error(`Failed to launch pager (${pager}): ${err.message}`);
            process.stdout.write(text);
            return 0;
        }
    }

    /**
     * Show a coloured diff for `rel` in the pager.
     *
     * Uses `git diff --color=always` so ANSI escape sequences are emitted
     * even though the output is captured (not a TTY); `pipeToPager` then
     * renders them via `less -R` (or $PAGER), degrading to raw stdout if
     * the pager is unavailable.
     *
     * @param {string} rel - repo-relative path
     * @param {string} [base='HEAD'] - diff base ref
     * @returns {number} exit status
     */
    previewDiffFor(rel, base = 'HEAD') {
        const r = this.git('diff', ['--color=always', base, '--', rel]);
        return this.pipeToPager(r.stdout);
    }

    /**
     * Interactive post-edit commit flow.
     *
     * Checks for changes to `rel`; if none, prints a message and returns 0.
     * Otherwise prompts the user to diff, commit, discard, or return to shell.
     *
     * @param {string} rel - repo-relative path to the edited file
     * @returns {Promise<number>} exit code
     */
    async commitFlow(rel) {
        if (this.statusPorcelain([rel]).length === 0) {
            console.log(`no changes to ${rel}.`);
            return 0;
        }

        const action = await cli.select(`changes to ${rel}; how do you want to proceed?`, [
            { name: 'diff', message: 'Show the diff and commit' },
            { name: 'commit', message: 'Commit changes' },
            { name: 'discard', message: 'Discard opencode changes (git restore)' },
            { name: 'shell', message: 'Return to the shell' }
        ]);

        if (action === 'diff') {
            this.previewDiffFor(rel);
            return 0;
        }
        if (action === 'commit') {
            const commit = this.git('commit');
            return commit.status ?? 0;
        }
        if (action === 'discard') {
            const ok = await cli.confirm(`Discard changes to ${rel}? This is destructive.`, false);
            if (!ok) return 0;
            this.git('restore', ['--', rel], { stdio: 'inherit' });
            console.log(`restored ${rel} to HEAD.`);
            return 0;
        }
        return 0;
    }
}

const git = new Git();

export { Git, git };
export default git;
