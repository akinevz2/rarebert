#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { listAllModules, promptModule, resolveModule, Module } from '../lib/modules.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { server } from '../lib/server.mjs';
import { libs } from '../lib/libs.mjs';
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

    const launchEditor = (files) => {
        const targets = files || [rel];
        const child = editor.editFile(targets);
        if (child && child.error) {
            console.error(`edit: failed to launch $EDITOR: ${child.error.message}`);
            return { error: true, code: 1 };
        }
        if (!child) return { error: false, code: 0 };
        return new Promise((resolve) => {
            child.on('exit', (code) => resolve({ error: false, code: code ?? 0 }));
        });
    };

    // First pass: let the developer edit the module.
    {
        const result = launchEditor();
        if (result.error || result.code !== 0) return exit(result.code);
    }

    // Snapshot git status before the opencode TUI so we can detect any
    // files it modifies while the developer is in the review session.
    const before = new Set(
        git.statusPorcelain().map((row) => row.path)
    );

    // Start a full opencode TUI for the review session.
    const model = modelArg ? await models.resolve(modelArg) : await models.resolve();

    const status = await server.startFullTUI({
        cwd: rarebert.root,
        model,
        port: null,
        prompt: null
    });
    if (status !== 0) return exit(status);

    // After opencode exits, compute which files changed during the TUI
    // session and offer to re-launch the editor on them for review.
    const after = git.statusPorcelain();
    const touched = after
        .filter((row) => !before.has(row.path))
        .map((row) => row.path);

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
        const result = launchEditor(reviewFiles);
        if (result.error || result.code !== 0) return exit(result.code);
    }

    return exit(await git.commitFlow(rel));
}

export { main };

const module = new Module('edit.mjs', main, meta);
export default module;
module.supportsDirectRunning(import.meta.url);
