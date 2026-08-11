import { spawn, spawnSync } from 'child_process';
import { current } from './projects.mjs';
import { opencode } from './opencode.mjs';
import { server } from './server.mjs';
import { backend } from './backend.mjs';

/**
 * Low-level process primitives for spawning the user's $EDITOR and the
 * opencode TUI/headless runner. Each primitive applies the right
 * stdio/await strategy based on the persisted `rarebert.editorType`
 * preference (graphical vs terminal), so callers don't branch on editor
 * type and don't touch spawn/stdio directly.
 *
 * Primitives:
 *   spawnEditor(file, opts)        -> ChildProcess | null
 *   spawnTui(model, opts)          -> { status: number|null, child: ChildProcess|null }
 *   spawnHeadless(prompt, model, opts) -> { status: number, stdout: string }
 *   awaitChild(child)              -> Promise<number>  (exit code)
 *   raceChildren(children)        -> Promise<{ child, code, index }>
 *   stopChild(child, timeoutMs)    -> Promise<number>  (graceful → SIGTERM → SIGKILL)
 *   isTerminalEditor()             -> boolean
 */

class Ide {
    constructor() {
        this.root = current.root;
    }

    /**
     * True when the persisted `rarebert.editorType` preference is
     * 'terminal' (nano, vim, vi, micro, ...). False for 'graphical'
     * (code, subl, cursor, ...) and for an unset preference — the
     * unset case defaults to graphical because graphical editors can
     * run alongside the opencode TUI without TTY contention.
     */
    isTerminalEditor() {
        return backend.getEditorType() === 'terminal';
    }

    /**
     * Spawn the user's $EDITOR on `file` (a path or array of paths).
     *
     * stdio is chosen from the editor-type preference:
     *   - terminal:  stdio 'inherit'  — the editor takes the TTY
     *   - graphical: stdio 'ignore'   — the editor opens its own
     *     window; its exit won't clobber a parallel opencode TUI
     *     that's rendering to the same TTY.
     *
     * Returns the ChildProcess, or null if $EDITOR is unset/empty.
     * The caller decides whether to await the child (awaitChild) or
     * let it race another process (raceChildren).
     */
    spawnEditor(file, options = {}) {
        const envEditor = process.env.EDITOR || 'nano';
        const [editor, ...maybeArgs] = envEditor.split(/\s+/).filter(Boolean);
        if (!editor) return null;
        const editorFlags = process.env.EDITOR_FLAGS
            ? process.env.EDITOR_FLAGS.split(/\s+/).filter(Boolean)
            : [];
        const paths = Array.isArray(file) ? file : [file];
        const args = [...maybeArgs, ...editorFlags, ...paths];
        const stdio = this.isTerminalEditor() ? 'inherit' : 'ignore';
        const child = spawn(editor, args, { stdio, cwd: options.cwd || this.root });
        if (child.error) {
            console.error(`Failed to launch $EDITOR: ${child.error.message}`);
            return null;
        }
        return child;
    }

    /**
     * Spawn a foreground opencode TUI (stdio inherited). Resolves with
     * { status: null, child } on launch; the caller awaits the child
     * separately (awaitChild) to get the final exit code. Returns
     * { status: 1, child: null } on launch failure.
     *
     * `opts.cwd` defaults to current.root; `opts.prompt` is forwarded
     * as `--prompt`; `opts.port` defaults to a free port.
     */
    spawnTui(model, options = {}) {
        const cwd = options.cwd || this.root;
        const port = options.port ?? null;
        const result = server.startFullTUI({
            cwd,
            model,
            port,
            prompt: options.prompt ?? null
        });
        // startFullTUI returns a Promise that resolves to the exit code
        // once the child exits. Wrap it so callers can either await the
        // promise (blocking) or race the underlying child. We expose a
        // consistent { status, child } shape; for the non-blocking case
        // callers use awaitChild on the child handle.
        if (result && typeof result.then === 'function') {
            // startFullTUI resolves only on exit; expose a thenable that
            // yields the status, plus a null child (no race support).
            return { status: null, child: null, done: result };
        }
        return { status: typeof result === 'number' ? result : 1, child: null, done: null };
    }

    /**
     * Run opencode headlessly (opencode run --auto) and block until it
     * exits. Returns { status, stdout }. stdio is captured (no TTY);
     * stderr is inherited for error visibility.
     */
    spawnHeadless(prompt, model, options = {}) {
        const args = ['run', prompt, '-m', model, '--auto'];
        if (options.format) args.push('--format', options.format);
        console.log(`$ opencode run "<prompt: ${prompt.length} bytes>" -m ${model} --auto`);
        const result = spawnSync(opencode.resolve(), args, {
            cwd: options.cwd || this.root,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'inherit']
        });
        if (result.error) {
            console.error(`Failed to launch opencode: ${result.error.message}`);
            return { status: 1, stdout: '' };
        }
        return { status: result.status ?? 0, stdout: (result.stdout ?? '').trim() };
    }

    /**
     * Await a child's exit. Resolves with the exit code (0 if killed
     * cleanly via signal). Resolves immediately if the child is null
     * or already exited. Never rejects.
     */
    awaitChild(child) {
        if (!child) return Promise.resolve(0);
        if (child.exitCode !== null) return Promise.resolve(child.exitCode);
        if (child.signalCode !== null) return Promise.resolve(0);
        return new Promise((resolve) => {
            child.once('exit', (code) => resolve(code ?? 0));
            child.once('error', () => resolve(1));
        });
    }

    /**
     * Race multiple children; resolve with { child, code, index } for
     * the first to exit. Losers are left running — the caller decides
     * whether to stopChild them. Never rejects.
     */
    raceChildren(children) {
        const valid = children.filter(Boolean);
        if (valid.length === 0) return Promise.resolve({ child: null, code: 0, index: -1 });
        return new Promise((resolve) => {
            valid.forEach((child, index) => {
                child.once('exit', (code) => resolve({ child, code: code ?? 0, index }));
                child.once('error', () => resolve({ child, code: 1, index }));
            });
        });
    }

    /**
     * Gracefully stop a child: try 'q' on stdin (TUI quit), then SIGINT,
     * then SIGTERM after timeoutMs, then SIGKILL after 2*timeoutMs.
     * Resolves with the exit code. Never rejects. No-op if already
     * exited.
     */
    stopChild(child, timeoutMs = 5000) {
        if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
            return Promise.resolve(child?.exitCode ?? 0);
        }

        let settleExit;
        const exited = new Promise((resolve) => {
            settleExit = resolve;
        });
        const settle = () => settleExit(child.exitCode ?? 0);
        child.once('exit', settle);
        child.once('close', settle);
        if (child.exitCode !== null || child.signalCode !== null) {
            settle();
            return exited;
        }

        try {
            if (child.stdin && !child.stdin.destroyed) {
                child.stdin.write('\x18q');
                child.stdin.end();
            }
        } catch {
            /* ignore */
        }
        try {
            child.kill('SIGHUP');
        } catch {
            /* ignore */
        }
        const soft = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            } catch {
                /* ignore */
            }
        }, timeoutMs);
        const hard = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                /* ignore */
            }
            settle();
        }, timeoutMs * 2);
        exited.then(() => {
            clearTimeout(soft);
            clearTimeout(hard);
        });
        return exited;
    }
}

const ide = new Ide();
export { Ide, ide };
export default ide;
