#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';
import { editFile, writeLastModule } from '../lib/editor.mjs';
import { runIDE, exitIDE } from '../lib/ide.mjs';
import { relPath } from '../lib/libs.mjs';
import { PROJECT_ROOT } from '../lib/core.mjs';
import * as git from '../lib/git.mjs';
import { select, confirm, isInteractive } from '../lib/cli.mjs';

async function main(args = []) {
    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found.');
        process.exit(1);
    }

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];
    const modelArg = nonFlag[1];

    const target = await promptModule(modules, moduleArg, 'Select a module to edit');
    const rel = relPath(target.path);

    if (!fs.existsSync(target.path)) {
        console.error(`Module file not found: ${rel}`);
        process.exit(1);
    }

    writeLastModule(rel);

    let model = modelArg;
    if (!model) {
        const config = readOpendeConfig();
        model = await promptModel(listModels(config), config.model);
    }

    const { status, child: ideChild } = runIDE(model, rel);

    console.log(`Opening $EDITOR ${rel}`);
    const editorChild = editFile(target.path);

    let finalStatus = 0;

    const editorExit = new Promise((resolve) => {
        editorChild.on('exit', (code) => resolve(code ?? 0));
    });
    const ideExit = new Promise((resolve) => {
        if (ideChild) {
            ideChild.on('exit', (code) => resolve(code ?? 0));
        } else {
            resolve(status ?? 0);
        }
    });

    const first = await Promise.race([
        editorExit.then((code) => ({ kind: 'editor', code })),
        ideExit.then((code) => ({ kind: 'ide', code }))
    ]);

    if (first.kind === 'editor') {
        if (first.code !== 0) finalStatus = first.code;
        await exitIDE(ideChild);
        const ideCode = await ideExit;
        if (ideCode !== 0) finalStatus = ideCode;
    } else {
        finalStatus = first.code;
    }

    if (finalStatus !== 0) {
        process.exit(finalStatus);
    }

    console.log('\n--- running `node index.js commit` after opencode exit ---');
    const result = spawnSync('node', ['index.js', 'commit'], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit'
    });
    if (result.error) {
        console.error(`commit failed: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`commit exited with status ${result.status}`);
        process.exit(result.status);
    }

    if (!isInteractive()) {
        process.exit(0);
    }

    finalStatus = await postCommitMenu(rel, model);
    process.exit(finalStatus);
}

async function postCommitMenu(rel, model) {
    while (true) {
        if (git.statusPorcelain([rel]).length === 0) {
            return 0;
        }

        const action = await select(`opencode transformed ${rel}; how do you want to proceed?`, [
            { name: 'diff', message: 'Show the diff in a pager' },
            { name: 'implement', message: 'Run another opencode round (implement)' },
            { name: 'edit', message: 'Re-edit the file in $EDITOR' },
            { name: 'discard', message: 'Discard opencode changes (git restore)' },
            { name: 'shell', message: 'Return to the shell' }
        ]);

        if (action === 'diff') {
            previewDiffFor(rel);
            continue;
        }
        if (action === 'implement') {
            const { status } = runIDE(model, rel, { implement: true });
            if (status !== 0) console.error(`opencode implement exited with status ${status}`);
            continue;
        }
        if (action === 'edit') {
            await runEditorOnce(targetPathFor(rel));
            continue;
        }
        if (action === 'discard') {
            const ok = await confirm(`Discard changes to ${rel}? This is destructive.`, false);
            if (!ok) continue;
            git.git('restore', ['--', rel], { stdio: 'inherit' });
            console.log(`restored ${rel} to HEAD.`);
            return 0;
        }
        return 0;
    }
}

function previewDiffFor(rel) {
    const pager = process.env.PAGER || 'less';
    const diff = git.diffForPath(rel);
    const child = spawnSync(pager, [], {
        input: diff,
        stdio: ['pipe', 'inherit', 'inherit']
    });
    if (child.error) {
        console.error(`Failed to launch pager (${pager}): ${child.error.message}`);
    }
}

function targetPathFor(rel) {
    return path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);
}

function runEditorOnce(absPath) {
    return new Promise((resolve) => {
        const child = editFile(absPath);
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', () => resolve(1));
    });
}

export { main };

export default {
    name: 'edit',
    description: 'Select an existing module, edit it in $EDITOR, then run opencode on it',
    main
};
