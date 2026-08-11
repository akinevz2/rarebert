#!/usr/bin/env node

import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { cli } from '../lib/cli.mjs';
import { listAllModules, promptModule, Module } from '../lib/modules.mjs';

const meta = {
    name: 'open',
    description: 'Open a module in $EDITOR then launch the opencode full TUI at the project root',
    usage: 'node index.js open [module] [--model <id>]',
    options: [{ flag: '--model <id>', description: 'opencode model id' }]
};

async function main(opts, positional) {
    const modelArg = opts.model || positional[1];
    const model = modelArg ? await models.resolve(modelArg) : await models.resolve();

    const modules = listAllModules();
    const moduleArg = positional[0];
    if (modules.length > 0) {
        const target = await promptModule(modules, moduleArg, 'Select a module to open');
        editor.writeLastModule(target.path);

        const editorChild = ide.spawnEditor(target.path);

        // Terminal editors need the TTY exclusively; we can't render the
        // confirm after spawning them (they'd clobber it). Ask up front,
        // await the editor's exit, then launch the TUI per the answer.
        // Graphical editors run in parallel — their stdio is ignored by
        // spawnEditor, so the TUI takes the TTY immediately.
        if (ide.isTerminalEditor() && editorChild) {
            const launchAfter = await cli.confirm(
                'Launch opencode after you close the editor?',
                true
            );
            await ide.awaitChild(editorChild);
            if (!launchAfter) {
                console.log('open: skipped TUI launch per user choice.');
                return exit(0);
            }
        }
    }

    console.log('open: launching full TUI at project root');
    const tui = ide.spawnTui(model, { cwd: rarebert.root });
    const status = tui.done ? await tui.done : tui.status;
    return exit(status);
}

export { main };

const module = new Module('open.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
