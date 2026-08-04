#!/usr/bin/env node

import fs from 'fs';
import { spawnSync } from 'child_process';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';
import { editFile, writeLastModule } from '../lib/editor.mjs';
import { runIDE, exitIDE } from '../lib/ide.mjs';
import { relPath } from '../lib/libs.mjs';
import { PROJECT_ROOT } from '../lib/core.mjs';

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('edit: Select a module, edit it in $EDITOR, then run opencode on it');
        console.error('  Usage: node index.js edit [--lib|--scripts] [module] [model]');
        console.error('  --lib       choose from modules in lib/');
        console.error('  --scripts   choose from modules in scripts/ (default)');
        console.error('  Lists modules with arrow-key navigation and search.');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        console.error('  After opencode exits, runs `make commit` (stages all + summarises + commits).');
        return;
    }

    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found.');
        process.exit(1);
    }

    const nonFlag = args.filter(a => !a.startsWith('-') && a);
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

    console.error(`Opening $EDITOR ${rel}`);
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
        editorExit.then(code => ({ kind: 'editor', code })),
        ideExit.then(code => ({ kind: 'ide', code }))
    ]);

    if (first.kind === 'editor') {
        if (first.code !== 0) finalStatus = first.code;
        await exitIDE(ideChild);
        const ideCode = await ideExit;
        if (ideCode !== 0) finalStatus = ideCode;
    } else {
        finalStatus = first.code;
    }

    if (finalStatus === 0) {
        console.error('\n--- running `make commit` after opencode exit ---');
        const result = spawnSync('make', ['commit'], {
            cwd: PROJECT_ROOT,
            stdio: 'inherit'
        });
        if (result.error) {
            console.error(`make commit failed: ${result.error.message}`);
        } else if (result.status !== 0) {
            console.error(`make commit exited with status ${result.status}`);
            if (finalStatus === 0) finalStatus = result.status;
        }
    }

    process.exit(finalStatus);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main };

export default {
    name: 'edit',
    description: 'Select an existing module, edit it in $EDITOR, then run opencode on it',
    main
};