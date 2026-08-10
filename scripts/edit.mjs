#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { server } from '../lib/server.mjs';
import { libs } from '../lib/libs.mjs';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'edit',
    description:
        'Edit a module in $EDITOR with opencode full TUI attached; on editor close a background review runs, then commit/diff/discard prompt',
    usage: 'node index.js edit [module] [model]',
    options: []
};

async function main(args = []) {
    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found.');
        return exit(1);
    }

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];

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

    let running = server.getRunning();
    let startedByEdit = false;
    if (!running) {
        console.error('edit: no running opencode server found.');
        console.error('       start one first with `make open` (or `node index.js open`).');
        console.error('       the mini TUI keeps the conversation open so edits stay in context.');
        return exit(1);
    }

    let model = modelArg;
    if (!model) {
        const config = models.readConfig();
        model = await models.prompt(models.list(config), config.model);
    }

    console.log(`edit: attaching to server ${running.url} port=${running.port}`);

    // 1. Open the user's editor on the file (runs independently).
    const editorChild = editor.editFile(target.path);

    // 2. Start the full interactive TUI attached to the running server.
    const { child: tuiChild } = server.startAttachableTUI({
        url: running.url,
        port: running.port
    });

    let finalStatus = 0;

    // 3. Monitor editor exit — when the user closes their editor, submit a
    //    review prompt to the same session the TUI is displaying.
    const editorExit = new Promise((resolve) => {
        editorChild.on('exit', (code) => resolve(code ?? 0));
    });
    const tuiExit = new Promise((resolve) => {
        if (tuiChild) {
            tuiChild.on('exit', (code) => resolve(code ?? 0));
        } else {
            resolve();
        }
    });

    const first = await Promise.race([
        editorExit.then((code) => ({ kind: 'editor', code })),
        tuiExit.then((code) => ({ kind: 'tui', code }))
    ]);

    if (first.kind === 'editor') {
        if (first.code !== 0) finalStatus = first.code;

        // 4. Editor closed: submit a review prompt to the foreground TUI session.
        console.log(`edit: editor closed; submitting review prompt to opencode session ...`);
        const review = server.submitPromptToForegroundTUI({
            url: running.url,
            port: running.port,
            prompt: `User finished editing ${rel}; review the changes and notes, implement any follow-up fixes.`,
            file: rel,
            model
        });
        if (review.status !== 0) finalStatus = review.status;
        console.log(`edit: review prompt delivered.`);

        // 5. Wait for the full TUI to exit (user closes it).
        console.log('edit: waiting for opencode TUI to exit (close it to continue).');
        const tuiCode = await tuiExit;
        if (tuiCode !== 0) finalStatus = tuiCode;
    } else {
        // TUI closed before editor — no review to submit.
        finalStatus = first.code;
        console.log('opencode TUI closed before editor; skipping review.');
    }

    return exit(await git.commitFlow(rel));
}

export { main };

export default {
    name: 'edit',
    description: meta.description,
    main: cli.run(meta, main)
};
