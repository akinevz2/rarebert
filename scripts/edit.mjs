#!/usr/bin/env node

import fs from 'fs';
import { listAllModules, promptModule, resolveModule, Module } from '../lib/modules.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { exit } from '../lib/core.mjs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';
import { rarebert } from '../lib/projects.mjs';

const meta = {
    name: 'edit',
    description:
        'Edit a module in $EDITOR; optionally review with opencode (which re-launches the editor on exit), then commit/diff/discard prompt',
    usage: 'node index.js edit [module] [model]',
    options: []
};

async function main(opts, positional) {
    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found.');
        return exit(1);
    }

    const moduleArg = positional[0];
    const modelArg = positional[1];

    let target;
    if (moduleArg) {
        const resolved = resolveModule(moduleArg, modules);
        if (!resolved) {
            console.error(`Module not found: ${moduleArg}`);
            return exit(1);
        }
        target = resolved.module;
    } else {
        target = await promptModule(modules, moduleArg, 'Select a module to edit');
    }
    const rel = target.path;

    if (!fs.existsSync(target.abs)) {
        console.error(`Module file not found: ${rel}`);
        return exit(1);
    }

    editor.writeLastModule(rel);

    // First pass: let the developer edit the module. spawnEditor picks
    // the stdio strategy from the editor-type preference — graphical
    // editors get stdio 'ignore' so they run alongside the opencode TUI
    // below without TTY contention (their exit can't clobber the TUI's
    // render). Terminal editors get stdio 'inherit' and must finish
    // before the TUI takes the TTY, so we await them first.
    const editorChild = ide.spawnEditor([rel]);
    if (ide.isTerminalEditor() && editorChild) {
        const editorCode = await ide.awaitChild(editorChild);
        if (editorCode !== 0) return exit(editorCode);
    }

    // Snapshot git status before the opencode TUI so we can detect any
    // files it modifies while the developer is in the review session.
    const before = new Set(git.statusPorcelain().map((row) => row.path));

    // Start a full opencode TUI for the review session. For graphical
    // editors the editor is still open in the background; for terminal
    // editors it has already exited.
    const model = modelArg ? await models.resolve(modelArg) : await models.resolve();
    const tui = ide.spawnTui(model, {
        cwd: rarebert.root,
        prompt: `We're reviewing ${rel}`
    });
    const status = tui.done ? await tui.done : tui.status;
    if (status !== 0) return exit(status);

    // After opencode exits, compute which files changed during the TUI
    // session and offer to re-launch the editor on them for review.
    const after = git.statusPorcelain();
    const touched = after.filter((row) => !before.has(row.path)).map((row) => row.path);

    let reviewFiles = [];
    if (touched.length === 1) {
        const review = await cli.confirm(`Review ${touched[0]}?`, false);
        if (review) reviewFiles = touched;
    } else if (touched.length > 1) {
        const review = await cli.confirm(
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
}

export { main };

const module = new Module('edit.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
