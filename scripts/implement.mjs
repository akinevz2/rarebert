#!/usr/bin/env node

import { cli } from '../lib/module.mjs';
import { editor } from '../lib/editor.mjs';
import { models } from '../lib/models.mjs';
import { exit } from '../lib/core.mjs';
import { CLI } from '../lib/module.mjs';
import { runHeadless, runInteractive } from '../lib/implement.mjs';

const meta = {
    name: 'implement',
    description:
        'Implement module file(s): non-interactive reads args as a file list and runs opencode headlessly; interactive runs a REPL that prompts for an instruction, runs opencode --auto (on a running server or a fresh full TUI), then launches $EDITOR and a testing bash in parallel — exits when both close, or loops back to the prompt when the bash is closed alone',
    usage: 'node index.js implement [file/dir ...] [model]',
    options: []
};

export { meta };

export default new CLI('implement.mjs', async (opts, positional) => {
    if (!cli.isInteractive()) {
        const fileArgs = positional;
        if (fileArgs.length === 0) {
            return exit(1, () =>
                console.error('Non-interactive: pass file or directory arguments to implement.')
            );
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
        return runHeadless({ entries, context, model, instruction });
    }

    await runInteractive(positional);
}, meta).supportsDirectRunning(import.meta.url);