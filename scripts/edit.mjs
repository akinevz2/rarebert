#!/usr/bin/env node

import fs from 'fs';
import { Interface, listAllModules, promptModule, resolveModule, TUI } from '../lib/module.mjs';
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
        const iface = Interface.createInterface('edit');
        const modules = listAllModules();
        if (modules.length === 0) {
            return exit('No modules found.');
        }

        const moduleArg = positional[0];

        let target;
        if (moduleArg) {
            const resolved = resolveModule(moduleArg, modules);
            if (!resolved) {
                return exit(`Module not found: ${moduleArg}`);
            }
            target = resolved.module;
        } else {
            target = await promptModule(modules, moduleArg, 'Select a module to edit');
        }
        const rel = target.path;

        if (!fs.existsSync(target.abs)) {
            return exit(`Module file not found: ${rel}`);
        }

        editor.writeLastModule(rel);

        const editorChild = ide.spawnEditor([rel]);
        if (ide.isTerminalEditor() && editorChild) {
            const editorCode = await ide.awaitChild(editorChild);
            if (editorCode !== 0) return exit(editorCode);
        }

        const before = new Set(git.statusPorcelain().map((row) => row.path));

        const model = opts.model ? await models.resolve(opts.model) : models.resolveDefault();
        const opencodeTui = ide.spawnTui(model, {
            cwd: rarebert.root,
            prompt: `We're reviewing ${rel}. Load the open-in-editor skill and open ${rel} in the editor so you can see the current state of the file as you review.`
        });
        const status = opencodeTui.done ? await opencodeTui.done : opencodeTui.status;
        if (status !== 0) return exit(status);

        const after = git.statusPorcelain();
        const touched = after.filter((row) => !before.has(row.path)).map((row) => row.path);

        let reviewFiles = [];
        if (touched.length === 1) {
            const review = await iface.confirm(`Review ${touched[0]}?`, false);
            if (review) reviewFiles = touched;
        } else if (touched.length > 1) {
            const review = await iface.confirm(
                `Review ${touched.length} changed files in $EDITOR?`,
                false
            );
            if (review) reviewFiles = touched;
        }

        if (reviewFiles.length > 0) {
            const reviewChild = ide.spawnEditor(reviewFiles);
            if (reviewChild) await ide.awaitChild(reviewChild);
        }

        // Interactive post-edit commit flow (moved from lib/git.mjs —
        // Interface construction lives in scripts/; lib/git.mjs keeps only
        // the data methods: statusPorcelain, previewDiffFor, git).
        async function commitFlow(rel) {
            if (git.statusPorcelain([rel]).length === 0) {
                console.log(`no changes to ${rel}.`);
                return 0;
            }

            const action = await iface.select(`changes to ${rel}; how do you want to proceed?`, [
                { name: 'diff', message: 'Show the diff and commit' },
                { name: 'commit', message: 'Commit changes' },
                { name: 'discard', message: 'Discard opencode changes (git restore)' },
                { name: 'shell', message: 'Return to the shell' }
            ]);

            if (action === 'diff') {
                git.previewDiffFor(rel);
                return 0;
            }
            if (action === 'commit') {
                const commit = git.git('commit');
                return commit.status ?? 0;
            }
            if (action === 'discard') {
                const ok = await iface.confirm(
                    `Discard changes to ${rel}? This is destructive.`,
                    false
                );
                if (!ok) return 0;
                git.git('restore', ['--', rel], { stdio: 'inherit' });
                console.log(`restored ${rel} to HEAD.`);
                return 0;
            }
            return 0;
        }

        return exit(await commitFlow(rel));
    },
    meta
).supportsDirectRunning(import.meta.url);
