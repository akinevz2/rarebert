#!/usr/bin/env node

import fs from 'fs';
import { listAllModules, promptModule, resolveModule, TUI } from '../lib/module.mjs';
import { tui } from '../lib/tui.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { exit } from '../lib/core.mjs';
import { git } from '../lib/git.mjs';
import { rarebert } from '../lib/projects.mjs';

const meta = {
    name: 'edit',
    description:
        'Edit a module in $EDITOR; optionally review with opencode (which re-launches the editor on exit), then commit/diff/discard prompt',
    usage: 'node index.js edit [module] [--model <id>]',
    options: [
        {
            flag: '-m, --model <id>',
            description: 'opencode model id (overrides the default from opencode.json)'
        }
    ]
};

export { meta };

export default new TUI(
    'edit.mjs',
    async (opts, positional) => {
        const modules = listAllModules();
        if (modules.length === 0) {
            return exit(1, () => console.error('No modules found.'));
        }

        const moduleArg = positional[0];

        let target;
        if (moduleArg) {
            const resolved = resolveModule(moduleArg, modules);
            if (!resolved) {
                return exit(1, () => console.error(`Module not found: ${moduleArg}`));
            }
            target = resolved.module;
        } else {
            target = await promptModule(modules, moduleArg, 'Select a module to edit');
        }
        const rel = target.path;

        if (!fs.existsSync(target.abs)) {
            return exit(1, () => console.error(`Module file not found: ${rel}`));
        }

        editor.writeLastModule(rel);

        const editorChild = ide.spawnEditor([rel]);
        if (ide.isTerminalEditor() && editorChild) {
            const editorCode = await ide.awaitChild(editorChild);
            if (editorCode !== 0) return exit(editorCode);
        }

        const before = new Set(git.statusPorcelain().map((row) => row.path));

        const model = opts.model ? await models.resolve(opts.model) : models.resolveDefault();
        const tui = ide.spawnTui(model, {
            cwd: rarebert.root,
            prompt: `We're reviewing ${rel}. Load the open-in-editor skill and open ${rel} in the editor so you can see the current state of the file as you review.`
        });
        const status = tui.done ? await tui.done : tui.status;
        if (status !== 0) return exit(status);

        const after = git.statusPorcelain();
        const touched = after.filter((row) => !before.has(row.path)).map((row) => row.path);

        let reviewFiles = [];
        if (touched.length === 1) {
            const review = await tui.confirm(`Review ${touched[0]}?`, false);
            if (review) reviewFiles = touched;
        } else if (touched.length > 1) {
            const review = await tui.confirm(
                `Review ${touched.length} changed files in $EDITOR?`,
                false
            );
            if (review) reviewFiles = touched;
        }

        if (reviewFiles.length > 0) {
            const reviewChild = ide.spawnEditor(reviewFiles);
            if (reviewChild) await ide.awaitChild(reviewChild);
        }

        return exit(await git.commitFlow(rel));
    },
    meta
).supportsDirectRunning(import.meta.url);
