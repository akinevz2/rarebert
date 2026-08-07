import { spawnSync } from 'child_process';
import { rarebert } from './projects.mjs';

const ALLOWED = new Set([
    'add',
    'commit',
    'restore',
    'stash',
    'status',
    'diff',
    'log',
    'branch',
    'notes',
    'rev-parse',
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
}

const git = new Git();

export { Git, git };
export default git;
