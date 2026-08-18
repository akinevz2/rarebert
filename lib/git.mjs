import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { rarebert } from './projects.mjs';
import { exit } from './core.mjs';
import { cli, tui, AbortError, listAllModules, CLI } from './module.mjs';
import { models } from './models.mjs';
import { memo } from './memo.mjs';
import { editor } from './editor.mjs';
import { ide } from './ide.mjs';
import { opencode } from './opencode.mjs';

// REQUEST: commitFlow(rel) should be converted to a CLI/TUI submodule that returns
// its exit code. On ctrl-c during commit prompts, cleanup should:
// - Preserve any staged files
// - Print "Aborted; staged files preserved" to console
// Meta suggestion: { retryOnFailure: false, cleanup: 'preserveStaged' }

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

        const action = await tui.select(`changes to ${rel}; how do you want to proceed?`, [
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
            const ok = await tui.confirm(`Discard changes to ${rel}? This is destructive.`, false);
            if (!ok) return 0;
            this.git('restore', ['--', rel], { stdio: 'inherit' });
            console.log(`restored ${rel} to HEAD.`);
            return 0;
        }
        return 0;
    }
}

const git = new Git();

// ---------------------------------------------------------------------------
// Commit command helpers (merged from lib/commit.mjs)
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_FIRST_LINE = 'Write a git commit message for the staged changelist below.';
export { DEFAULT_PROMPT_FIRST_LINE };

export function stripCommitMessage(raw) {
    return raw
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .replace(/\n+$/, '');
}

/**
 * Clean raw opencode output into a valid git commit message.
 *
 * opencode sometimes wraps its output in markdown fences, prepends
 * labels like "Commit message:" or "Here is...", or attaches trailing
 * commentary. Without cleaning, git either rejects the message as
 * empty (after fence stripping) or commits a malformed message that
 * looks like a chat transcript. This function:
 *
 *  1. Strips a leading/trailing markdown code fence (``` or ```text).
 *  2. Removes any preamble line(s) ending with ":" before the first
 *     blank line if they contain label-like text (e.g. "Commit message:").
 *  3. Removes trailing commentary after a closing fence or the last
 *     blank-line-delimited paragraph.
 *  4. Trims trailing blank lines.
 *
 * Returns the cleaned message, or '' if nothing usable remains.
 */
export function cleanSummary(raw) {
    let text = (raw ?? '').trim();
    if (!text) return '';

    // Strip a wrapping markdown code fence. opencode frequently emits
    // ```text\n<message>\n``` or ```\n<message>\n```.
    const fenceOpen = text.match(/^```[^\n]*\n/);
    if (fenceOpen) {
        text = text.slice(fenceOpen[0].length);
        const fenceClose = text.match(/\n```\s*$/);
        if (fenceClose) text = text.slice(0, fenceClose.index);
    }
    text = text.trim();
    if (!text) return '';

    // Drop leading preamble lines that end with ":" and precede the
    // actual message (e.g. "Here is the commit message:" or "Sure:").
    // Stop at the first line that doesn't look like a label.
    const lines = text.split('\n');
    while (lines.length > 1) {
        const first = lines[0].trim();
        if (!first) {
            lines.shift();
            continue;
        }
        if (
            first.endsWith(':') &&
            first.length < 72 &&
            !/^(feat|fix|refactor|docs|test|chore|style|perf|build|ci)/i.test(first)
        ) {
            lines.shift();
            continue;
        }
        break;
    }
    text = lines.join('\n').trim();
    if (!text) return '';

    // Strip trailing commentary: if a closing fence appears mid-text,
    // drop everything from that fence onward (opencode often appends
    // "Let me know if..." after the fenced block).
    const trailingFence = text.search(/\n```\s*\n/);
    if (trailingFence >= 0) {
        text = text.slice(0, trailingFence).trim();
    }

    return text.replace(/\n+$/, '');
}

export async function promptCommitChoice() {
    if (process.stdin.isTTY !== true) {
        return 'raw';
    }

    const prompt = new Enquirer.Select({
        name: 'choice',
        message: 'How would you like to commit?',
        choices: [
            { name: 'proceed', message: 'Proceed with opencode summary' },
            { name: 'later', message: 'Just return me to the shell' },
            { name: 'raw', message: 'Write a regular commit message' }
        ],
        initial: 0
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

export async function promptPreview() {
    if (process.stdin.isTTY !== true) {
        return false;
    }

    const prompt = new Enquirer.Confirm({
        name: 'preview',
        message: 'Preview staged changes?',
        initial: true
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

export async function promptBail(message) {
    if (process.stdin.isTTY !== true) {
        return false;
    }

    const prompt = new Enquirer.Confirm({
        name: 'bail',
        message,
        initial: false
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

export function bailCommit(reason) {
    // Do NOT unstage here. The only time we unstage is when the user
    // erases the entire commit message in the editor (editSummaryInEditor
    // returns null). Bailing at a prompt means the user chose not to
    // proceed — their staged files should remain staged so they can
    // rerun make commit or manually git commit.
    console.error(`Bailed: ${reason}.`);
    exit(0);
}

export function previewDiff() {
    // Use the shared pipeToPager helper so colour and fallback handling are
    // consistent across all diff viewers.  Force --color=always since the
    // output is captured (not a TTY); the pager renders the ANSI codes.
    const staged = git.git('diff', ['--cached', '--name-only']);
    const diffArgs = staged.stdout.trim() ? ['--cached'] : ['HEAD'];
    const diff = git.git('diff', ['--color=always', ...diffArgs]);
    git.pipeToPager(diff.stdout);
}

export async function promptModifyPrompt() {
    if (process.stdin.isTTY !== true) {
        return false;
    }

    const prompt = new Enquirer.Confirm({
        name: 'modify',
        message: 'Modify the instruction line sent to opencode? (Yes = yeet the default)',
        initial: false
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

export async function promptPromptFirstLine() {
    if (process.stdin.isTTY !== true) {
        console.log('Non-interactive; using the default prompt instruction line.');
        return DEFAULT_PROMPT_FIRST_LINE;
    }

    const prompt = new Enquirer.Input({
        name: 'firstLine',
        message: 'Edit the instruction line sent to opencode:',
        initial: DEFAULT_PROMPT_FIRST_LINE,
        result: (v) => v.trim()
    });

    try {
        const edited = await prompt.run();
        return edited || DEFAULT_PROMPT_FIRST_LINE;
    } catch {
        throw new AbortError();
    }
}

export function summariseChangelist(model, changelist, firstLine, verbose = false) {
    const prompt = [
        firstLine,
        'Strict rules (do not violate any):',
        '1. First line: imperative mood, STRICTLY 72 characters or fewer. Count them.',
        '2. One blank line after the first line.',
        '3. A body of 2-4 lines wrapped at 72 columns explaining why the change was made.',
        '4. Output ONLY the commit message — no preamble, no commentary, no markdown fences.',
        '5. Keep every line under 72 characters wide.',
        '',
        '--- staged changelist ---',
        changelist
    ].join('\n');

    const args = ['run', prompt, '-m', model, '--auto', '--format', 'json'];
    const promptFirstLine = prompt.split('\n')[0];
    console.log(
        `$ opencode run "<prompt: ${prompt.length} bytes, ${prompt.split('\n').length} lines, first: "${promptFirstLine}">" -m ${model} --auto --format json`
    );

    if (verbose) {
        console.log('\n--- opencode prompt ---');
        console.log(prompt);
        console.log('--- end prompt ---\n');
    }

    const result = spawnSync(opencode.resolve(), args, {
        cwd: rarebert.root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit']
    });

    if (result.error) {
        console.error(`Failed to launch opencode: ${result.error.message}`);
        return '';
    }
    if (result.status !== 0) {
        console.error(`opencode exited with status ${result.status}; continuing without summary.`);
        return '';
    }

    // Parse JSON event stream and extract text parts. The default format
    // can duplicate the model's output (the model sometimes emits its
    // response twice); JSON gives structured events with exactly one
    // text part per message.
    const text = (result.stdout ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            try {
                const evt = JSON.parse(line);
                if (evt.type === 'text' && evt.part?.text) return evt.part.text;
            } catch {
                /* non-JSON line — skip */
            }
            return '';
        })
        .filter(Boolean)
        .join('');

    return cleanSummary(text.trim());
}

export function summariseAndShow(model, changelist, firstLine, verbose = false) {
    console.log('\n--- opencode summary ---');
    const summary = summariseChangelist(model, changelist, firstLine, verbose);
    if (summary) {
        console.log(summary);
    } else {
        console.log('(no summary produced)');
    }
    console.log('--- end summary ---\n');
    return summary;
}

export async function editSummaryInEditor(summary) {
    const templateFile = path.join(os.tmpdir(), `rarebert-commit-${process.pid}.txt`);
    fs.writeFileSync(templateFile, summary + '\n');

    const editorChild = ide.spawnEditor(templateFile);
    const exitCode = editorChild ? await ide.awaitChild(editorChild) : 0;

    // Editor exited with a nonzero status — treat as abort. Unstage
    // all changes so the user can cherry-pick files or rerun.
    if (exitCode !== 0) {
        console.error(`Editor exited with status ${exitCode}; unstaging all changes.`);
        try {
            fs.unlinkSync(templateFile);
        } catch {
            /* gone */
        }
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        return null;
    }

    const stripped = stripCommitMessage(fs.readFileSync(templateFile, 'utf-8'));
    try {
        fs.unlinkSync(templateFile);
    } catch {
        /* gone */
    }

    if (!stripped) {
        // The user erased the entire commit message in the editor. This is
        // the ONLY case where we unstage (alongside nonzero editor exit):
        // it signals the user wants to completely bail on writing a commit
        // message for this changelist. They can rerun make commit for a
        // bulk commit, or manually git add and commit specific files.
        console.error('Commit message erased; unstaging all changes so you can cherry-pick files.');
        git.git('restore', ['--staged', '.'], { stdio: 'inherit' });
        return null;
    }

    return ['-m', stripped];
}

export function stageAndCommit(commitArgs) {
    // Register an abort handler that fires only on Ctrl-C during the
    // commit. Capture the unsubscribe so we can deregister it on success
    // — otherwise process.on('exit') would fire runAbortCallbacks() after
    // a successful commit. On interrupt we do NOT unstage — the user can
    // rerun make commit or manually commit. Unstaging only happens when
    // the user erases the commit message in the editor.
    const offAbort = cli.onAbort(() => {
        console.error('\nInterrupted; staged files preserved.');
    });

    // Only mutate the index if nothing is staged yet. If the user already
    // staged files manually, leave the index exactly as they set it.
    const staged = git.git('diff', ['--cached', '--name-only']);
    if (!staged.stdout.trim()) {
        const addResult = git.add([], { all: true, stdio: 'inherit' });
        if (!addResult.ok) {
            console.error(`git add failed (status ${addResult.status})`);
            offAbort();
            exit(addResult.status ?? 1);
        }
    }

    try {
        const result = git.git('commit', commitArgs, { stdio: 'inherit' });
        if (result.status !== 0) {
            const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
            if (/empty commit message|Aborting commit/i.test(output)) {
                // Git rejected the commit (e.g. empty message from a failed
                // editor invocation). Do NOT unstage — the user can rerun
                // make commit or manually adjust.
                console.error('Empty commit message; staged files preserved.');
            } else {
                console.error(`git commit exited with status ${result.status}`);
            }
            offAbort();
            exit(result.status ?? 1);
        }
    } catch (err) {
        console.error(`Commit failed: ${err.message}`);
        offAbort();
        exit(1);
    }

    // Success — deregister the abort handler so it doesn't fire on exit.
    offAbort();
}

export { Git, git, Enquirer, models, memo, cli, tui, listAllModules };
export default git;
