#!/usr/bin/env node

import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { cli, listAllModules, promptModule, CLI } from '../lib/module.mjs';

const meta = {
    name: 'open',
    description: 'Open a module in $EDITOR then launch the opencode full TUI at the project root',
    usage: 'node index.js open [module] [--model <id>]',
    options: [{ flag: '--model <id>', description: 'opencode model id' }]
};

export { meta };

export default new CLI('open.mjs', async (opts, positional) => {
    const modelArg = opts.model || positional[1];
    const model = modelArg ? await models.resolve(modelArg) : await models.resolve();

    const modules = listAllModules();
    const moduleArg = positional[0];
    if (modules.length > 0) {
        const target = await promptModule(modules, moduleArg, 'Select a module to open');
        editor.writeLastModule(target.path);

        const editorChild = ide.spawnEditor(target.path);

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
}, meta).supportsDirectRunning(import.meta.url);