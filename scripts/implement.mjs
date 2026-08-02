#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../lib/core.mjs';
import { readLastModule } from '../lib/editor.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';
import { runIDE } from '../lib/ide.mjs';

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('implement: Implement the last-created module using an opencode model');
        console.error('  Usage: node index.js implement [model]');
        console.error('  Reads the target path from .last-module and prompts for a model');
        console.error('  listed in opencode.json (or accepts one as an argument).');
        return;
    }

    const file = readLastModule();
    if (!file) {
        console.error('No module to implement. Run `make add` first to scaffold a module.');
        process.exit(1);
    }

    const absFile = path.isAbsolute(file) ? file : path.join(PROJECT_ROOT, file);
    if (!fs.existsSync(absFile)) {
        console.error(`Module file not found: ${file}`);
        process.exit(1);
    }

    let model = args.find(a => !a.startsWith('-') && a);
    if (!model) {
        const config = readOpendeConfig();
        model = await promptModel(listModels(config), config.model);
    }

    const { status, child } = runIDE(model, file, { implement: true });
    process.exit(status ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main };

export default {
    name: 'implement',
    description: 'Implement the last-created module via opencode',
    main
};