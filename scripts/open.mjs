#!/usr/bin/env node

import fs from 'fs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';
import { editFile } from '../lib/editor.mjs';
import { runIDE } from '../lib/ide.mjs';
import { relPath } from '../lib/libs.mjs';
import * as git from '../lib/git.mjs';

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('open: Select a module, edit it in $EDITOR, run opencode on it, then stage changes');
        console.error('  Usage: node index.js open [--lib|--scripts] [module] [model]');
        console.error('  --lib       choose from modules in lib/');
        console.error('  --scripts   choose from modules in scripts/ (default)');
        console.error('  Lists modules with arrow-key navigation and search.');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        console.error('  Before exiting, runs `git add -A` to stage changes.');
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

    const target = await promptModule(modules, moduleArg, 'Select a module to open');
    const rel = relPath(target.path);

    if (!fs.existsSync(target.path)) {
        console.error(`Module file not found: ${rel}`);
        process.exit(1);
    }

    let model = modelArg;
    if (!model) {
        const config = readOpendeConfig();
        model = await promptModel(listModels(config), config.model);
    }

    const status = runIDE(model, rel);

    console.error(`Opening $EDITOR ${rel}`);
    const editStatus = editFile(target.path);
    if (editStatus !== 0) {
        console.error(`Editor exited with status ${editStatus}`);
        process.exit(editStatus);
    }

    try {
        const r = git.add([], { all: true, stdio: 'inherit' });
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
    } catch (err) {
        console.error(`git: ${err.message}`);
    }

    process.exit(status ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main };

export default {
    name: 'open',
    description: 'Select an existing module, edit it in $EDITOR, then run opencode on it',
    main
};