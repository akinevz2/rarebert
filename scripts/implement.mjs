#!/usr/bin/env node

import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { models } from '../lib/models.mjs';
import { cli, AbortError } from '../lib/cli.mjs';
import { server, DEFAULT_PORT } from '../lib/server.mjs';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { editor } from '../lib/editor.mjs';
import { opencode } from '../lib/opencode.mjs';

const meta = {
    name: 'implement',
    description:
        'Implement module file(s): non-interactive reads args as a file list and runs opencode headlessly; interactive runs a REPL that prompts for an instruction, runs opencode --auto (on a running server or a fresh full TUI), then launches $EDITOR and a testing bash in parallel — exits when both close, or loops back to the prompt when the bash is closed alone',
    usage: 'node index.js implement [file/dir ...] [model]',
    options: [
        { label: 'file', description: 'one or more module files or directories to implement' },
        { label: 'model', description: 'opencode model id (otherwise resolved from opencode.json)' }
    ]
};

function relCwdFor(absCwd) {
    if (absCwd === rarebert.root) return './';
    if (path.isAbsolute(absCwd) && !absCwd.startsWith(rarebert.root)) return `${absCwd}/`;
    return `${path.relative(rarebert.root, absCwd)}/`;
}

function runHeadless({ entries, context, model, instruction }) {
    const prompt = [instruction, '', '--- active files context ---', context]
        .filter((s) => s && s.trim())
        .join('\n');

    const args = ['run', prompt, '-m', model, '--auto'];
    console.log(
        `$ opencode run "<prompt: ${prompt.length} bytes, ${entries.length} file(s)>" -m ${model} --auto`
    );
    const result = spawnSync(opencode.resolve(), args, {
        cwd: rarebert.root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit']
    });
    if (result.status !== 0) {
        console.error(`opencode run exited with status ${result.status ?? 0}`);
    }
    const out = (result.stdout ?? '').trim();
    if (out) console.log(out);
    return exit(result.status ?? 0);
}

async function runInteractive(args) {
    const { entries, context } = await editor.resolveActiveFiles(args, {
        message: 'Select a module to implement'
    });
    if (entries.length === 0) return exit(1);

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const model = await models.resolve(nonFlag[0]);

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
            const { status } = server.runOnServer({
                url: running.url,
                port: running.port,
                prompt: instruction.trim(),
                model,
                auto: true
            });
            if (status !== 0) {
                console.error(`implement: opencode run exited with status ${status}`);
                if (!(await cli.confirm('Retry prompt?', true))) return exit(status);
                continue;
            }
        } else {
            const cwd = server.cwdForModule(entries[0].rel);
            const relCwd = relCwdFor(cwd);
            const port = DEFAULT_PORT;
            console.log(
                `implement: no running server; starting full TUI on port ${port} (password=${port})`
            );
            console.log(`  cwd: ${relCwd}`);
            console.log(`  subsequent \`make implement\` invocations will attach with --mini`);
            const status = server.startFullTUI({
                cwd,
                model,
                port,
                prompt: instruction.trim() || null
            });
            if (status !== 0) {
                console.error(`implement: opencode TUI exited with status ${status}`);
                if (!(await cli.confirm('Retry prompt?', true))) return exit(status);
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
        const envEditor = process.env.EDITOR || 'nano';
        const [editor, ...maybeArgs] = envEditor.split(/\s+/).filter(Boolean);
        const editorFlags = process.env.EDITOR_FLAGS
            ? process.env.EDITOR_FLAGS.split(/\s+/).filter(Boolean)
            : [];
        const editorArgs = [...maybeArgs, ...editorFlags, ...entries.map((e) => e.abs)];

        console.log(
            `implement: please close the last edited file (${entries.map((e) => e.rel).join(', ')}) to continue`
        );
        const editorChild = spawn(editor, editorArgs, { stdio: 'inherit' });
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

async function main(args = []) {
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);

    if (!cli.isInteractive()) {
        const fileArgs = nonFlag;
        if (fileArgs.length === 0) {
            console.error('Non-interactive: pass file or directory arguments to implement.');
            return exit(1);
        }
        const { entries, context } = await editor.resolveActiveFiles(fileArgs, {
            message: 'implement'
        });
        if (entries.length === 0) return exit(1);

        const model = await models.resolve(null);
        const fileLabel =
            entries.length === 1
                ? entries[0].rel
                : `${entries.length} files (${entries.map((e) => e.rel).join(', ')})`;
        const instruction = `Implement the module in ${fileLabel}.\n\n--- active files context ---\n${context}`;
        runHeadless({ entries, context, model, instruction });
        return;
    }

    await runInteractive(nonFlag);
}

export { main };

export default {
    name: 'implement',
    description: meta.description,
    main: cli.run(meta, main)
};
