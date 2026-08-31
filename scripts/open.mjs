#!/usr/bin/env node

import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { listAllModules, promptModule, TUI } from '../lib/module.mjs';
import { tui } from '../lib/tui.mjs';

const meta = {
    name: 'open',
    description: 'Open a module in $EDITOR then launch the opencode full TUI at the project root',
    usage: 'node index.js open [module] [--model <id>]',
    options: [
        {
            flag: '-m, --model <id>',
            description: 'opencode model id (overrides the default from opencode.json)'
        }
    ]
};

export { meta };

export default new TUI(
    'open.mjs',
    async (opts, positional) => {
        const modelArg = opts.model;
        const model = modelArg ? await models.resolve(modelArg) : models.resolveDefault();

        const modules = listAllModules();
        const moduleArg = positional[0];
        if (modules.length > 0) {
            const target = await promptModule(modules, moduleArg, 'Select a module to open');
            editor.writeLastModule(target.path);

            const editorChild = ide.spawnEditor(target.path);

            if (ide.isTerminalEditor() && editorChild) {
                const launchAfter = await tui.confirm(
                    'Launch opencode after you close the editor?',
                    true
                );
                await ide.awaitChild(editorChild);
                if (!launchAfter) {
                    return exit(0, () => console.log('open: skipped TUI launch per user choice.'));
                }
            }
        }

        console.log('open: launching full TUI at project root');
        const tui = ide.spawnTui(model, { cwd: rarebert.root });
        const status = tui.done ? await tui.done : tui.status;
        return exit(status);
    },
    meta
).supportsDirectRunning(import.meta.url);
