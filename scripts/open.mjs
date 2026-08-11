#!/usr/bin/env node

import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { server } from '../lib/server.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { backend } from '../lib/backend.mjs';
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

        const editorType = backend.getEditorType();

        if (editorType === 'terminal') {
            // Terminal editors (nano, vim, ...) need the TTY exclusively,
            // so we can't render the prompt after spawning them. Ask up
            // front whether to launch opencode afterwards; then spawn the
            // editor, await its exit, and launch the TUI (or skip) per the
            // answer. A second confirmation after exit would be clobbered
            // by the editor redrawing the TTY on close.
            const launchAfter = await cli.confirm(
                'Launch opencode after you close the editor?',
                true
            );
            const editorChild = editor.editFile(target.path);
            if (editorChild) {
                await new Promise((resolve) => {
                    editorChild.on('exit', () => resolve());
                    editorChild.on('error', () => resolve());
                });
            }
            if (!launchAfter) {
                console.log('open: skipped TUI launch per user choice.');
                return exit(0);
            }
        } else {
            // Graphical editor (code, subl, ...) or unset preference: launch
            // both in parallel. The editor runs in the background; the TUI
            // takes the TTY immediately. The editor exiting is a non-event.
            const editorChild = editor.editFile(target.path);
            if (editorChild) {
                editorChild.on('exit', () => {});
                editorChild.on('error', () => {});
            }
        }
    }

    console.log('open: launching full TUI at project root');
    const status = await server.startFullTUI({
        cwd: rarebert.root,
        model,
        port: null,
        prompt: null
    });
    return exit(status);
}

export { main };

const module = new Module('open.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
