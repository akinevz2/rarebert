#!/usr/bin/env node

import fs from 'fs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';
import { editFile, writeLastModule } from '../lib/editor.mjs';
import { runIDE, exitIDE } from '../lib/ide.mjs';
import { relPath } from '../lib/libs.mjs';
import * as git from '../lib/git.mjs';

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('edit: Select a module, edit it in $EDITOR, then run opencode on it');
        console.error('  Usage: node index.js edit [--lib|--scripts] [module] [model]');
        console.error('  --lib       choose from modules in lib/');
        console.error('  --scripts   choose from modules in scripts/ (default)');
        console.error('  Lists modules with arrow-key navigation and search.');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        console.error('  Before exiting, runs `git add` on the selected module only.');
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

    try {
        const r = git.add([target.path], { stdio: 'inherit' });
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
    } catch (err) {
        console.error(`git: ${err.message}`);
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