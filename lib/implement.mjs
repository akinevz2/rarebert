import path from 'path';
import { spawn } from 'child_process';
import { TUI } from './module.mjs';
import { server } from './server.mjs';
import { rarebert } from './projects.mjs';
import { exit } from './core.mjs';
import { editor } from './editor.mjs';
import { ide } from './ide.mjs';

// Prompt helpers ride on a TUI class instance created at runtime — there is
// no shared tui singleton (see the TUI class in lib/module.mjs).
const tui = new TUI('implement.mjs');

function relCwdFor(absCwd) {
    if (absCwd === rarebert.root) return './';
    if (path.isAbsolute(absCwd) && !absCwd.startsWith(rarebert.root)) return `${absCwd}/`;
    return `${path.relative(rarebert.root, absCwd)}/`;
}

/**
 * Non-interactive implementation: run `opencode run --auto` headlessly
 * with the local default model. The instruction is passed directly to
 * opencode — opencode reads the files itself via its own tools. The
 * module paths are resolved to confirm they exist, but their contents
 * are NOT injected into the prompt (per the design decision to let
 * opencode read files itself).
 */
async function runHeadless({ fileArgs, model, instruction }) {
    const { entries } = await editor.resolveActiveFiles(fileArgs, { message: 'implement' });
    if (entries.length === 0) {
        return exit(1, () => console.error('implement: no files resolved from arguments.'));
    }

    const prompt = `${instruction}\n\nTarget modules: ${entries.map((e) => e.rel).join(', ')}`;

    const { status, stdout: out } = ide.spawnHeadless(prompt, model, { cwd: rarebert.root });
    return exit(status, () => {
        if (status !== 0) {
            console.error(`opencode run exited with status ${status}`);
        }
        if (out) console.log(out);
    });
}

/**
 * Interactive implementation: launch `opencode <project>` as a full TUI
 * with the local default model. The instruction is passed via --prompt.
 * If a running opencode server exists, attach to it with --auto instead
 * of starting a new TUI. After opencode finishes, optionally launches
 * $EDITOR and a testing bash for the user to verify the changes.
 */
async function runInteractive({ fileArgs, model, instruction }) {
    const { entries, context } = await editor.resolveActiveFiles(fileArgs, {
        message: 'Select a module to implement'
    });
    if (entries.length === 0) return exit(1);

    const fileLabel =
        entries.length === 1
            ? entries[0].rel
            : `${entries.length} files (${entries.map((e) => e.rel).join(', ')})`;

    const moduleLabel = entries.length === 1 ? entries[0].rel : fileLabel;

    const running = server.getRunning();
    if (running) {
        console.log(
            `implement: running on existing server ${running.url} (--auto, non-interactive)`
        );
        const { status } = await server.runOnServer({
            url: running.url,
            port: running.port,
            prompt: instruction,
            model,
            auto: true
        });
        if (status !== 0) {
            if (!(await tui.confirm('Retry prompt?', true)))
                return exit(status, () =>
                    console.error(`implement: opencode run exited with status ${status}`)
                );
        }
    } else {
        const cwd = server.cwdForModule(entries[0].rel);
        const relCwd = relCwdFor(cwd);
        console.log(
            `implement: no running server; starting full TUI (free port, password=port)`
        );
        console.log(`  cwd: ${relCwd}`);
        console.log(`  model: ${model}`);
        const status = await server.startFullTUI({
            cwd,
            model,
            port: null,
            prompt: instruction
        });
        if (status !== 0) {
            if (!(await tui.confirm('Retry prompt?', true)))
                return exit(status, () =>
                    console.error(`implement: opencode TUI exited with status ${status}`)
                );
        }
        return;
    }

    await runEditorThenBash(entries, moduleLabel);
}

function runEditorThenBash(entries, moduleLabel) {
    return new Promise((resolve) => {
        console.log(
            `implement: please close the last edited file (${entries.map((e) => e.rel).join(', ')}) to continue`
        );
        const editorChild = ide.spawnEditor(entries.map((e) => e.abs));
        if (!editorChild) {
            resolve();
            return;
        }
        editorChild.on('exit', () => {
            const bashChild = spawn(
                process.env.SHELL || 'bash',
                [
                    '-c',
                    `echo testing newly implemented module ${moduleLabel}; exec ${process.env.SHELL || 'bash'} -i`
                ],
                { stdio: 'inherit' }
            );
            bashChild.on('exit', () => resolve());
            bashChild.on('error', () => resolve());
        });
        editorChild.on('error', () => resolve());
    });
}

export { relCwdFor, runHeadless, runInteractive, runEditorThenBash };
export default { runHeadless, runInteractive, runEditorThenBash };