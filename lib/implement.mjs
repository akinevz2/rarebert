import path from 'path';
import { spawn } from 'child_process';
import { cli, AbortError } from './module.mjs';
import { models } from './models.mjs';
import { server } from './server.mjs';
import { rarebert } from './projects.mjs';
import { exit } from './core.mjs';
import { editor } from './editor.mjs';
import { ide } from './ide.mjs';

// REQUEST: runHeadless() and runInteractive() should be converted to TUI submodules.
// runHeadless returns ExitSignal - needs to become CLI/TUI that awaits opencode output.
// runInteractive has retry loop - should be a CLI with retryOnFailure: true meta.
// On ctrl-c in TUI mode, cleanup should:
// - Kill any running opencode processes
// - Close editor gracefully
// - Return exit 0 on first ctrl-c (cancel), exit 130 on double ctrl-c
// Meta suggestion: { retryOnFailure: true, cleanup: 'killProcesses' }

function relCwdFor(absCwd) {
    if (absCwd === rarebert.root) return './';
    if (path.isAbsolute(absCwd) && !absCwd.startsWith(rarebert.root)) return `${absCwd}/`;
    return `${path.relative(rarebert.root, absCwd)}/`;
}

function runHeadless({ entries, context, model, instruction }) {
    const prompt = [instruction, '', '--- active files context ---', context]
        .filter((s) => s && s.trim())
        .join('\n');

    const { status, stdout: out } = ide.spawnHeadless(prompt, model, { cwd: rarebert.root });
    return exit(status, () => {
        if (status !== 0) {
            console.error(`opencode run exited with status ${status}`);
        }
        if (out) console.log(out);
    });
}

async function runInteractive(fileArgs) {
    const { entries, context } = await editor.resolveActiveFiles(fileArgs, {
        message: 'Select a module to implement'
    });
    if (entries.length === 0) return exit(1);

    const model = await models.resolve(fileArgs[0]);

    const fileLabel =
        entries.length === 1
            ? entries[0].rel
            : `${entries.length} files (${entries.map((e) => e.rel).join(', ')})`;

    const moduleLabel = entries.length === 1 ? entries[0].rel : fileLabel;

    while (true) {
        const defaultInstruction =
            entries.length === 1 ? `Implement the module in ${entries[0].rel}` : '';
        const instruction = await cli.input(`Instruction for opencode (file: ${fileLabel}):`, {
            initial: defaultInstruction
        });
        if (!instruction.trim() && entries.length === 1) {
            if (!(await cli.confirm('No instruction entered. Exit implement?', true))) continue;
            throw new AbortError();
        }

        const running = server.getRunning();
        if (running) {
            console.log(
                `implement: running on existing server ${running.url} (--auto, non-interactive)`
            );
            const { status } = await server.runOnServer({
                url: running.url,
                port: running.port,
                prompt: instruction.trim(),
                model,
                auto: true
            });
            if (status !== 0) {
                if (!(await cli.confirm('Retry prompt?', true)))
                    return exit(status, () =>
                        console.error(`implement: opencode run exited with status ${status}`)
                    );
                continue;
            }
        } else {
            const cwd = server.cwdForModule(entries[0].rel);
            const relCwd = relCwdFor(cwd);
            console.log(
                `implement: no running server; starting full TUI (free port, password=port)`
            );
            console.log(`  cwd: ${relCwd}`);
            console.log(`  subsequent \`make implement\` invocations will attach with --mini`);
            const status = await server.startFullTUI({
                cwd,
                model,
                port: null,
                prompt: instruction.trim() || null
            });
            if (status !== 0) {
                if (!(await cli.confirm('Retry prompt?', true)))
                    return exit(status, () =>
                        console.error(`implement: opencode TUI exited with status ${status}`)
                    );
                continue;
            }
            return;
        }

        await runEditorThenBash(entries, moduleLabel);
        return;
    }
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