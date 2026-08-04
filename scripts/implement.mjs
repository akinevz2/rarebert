#!/usr/bin/env node

import { readLastModule } from '../lib/editor.mjs';
import { runIDE } from '../lib/ide.mjs';
import { resolveModel } from '../lib/models.mjs';

async function main(args = []) {
    const file = readLastModule();
    if (!file) {
        console.error('Run `node index.js add` first');
        process.exit(1);
    }

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const model = await resolveModel(nonFlag[0]);

    const { status } = runIDE(model, file, { implement: true });
    if (status && status !== 0) process.exit(status);
}

export { main };

export default {
    name: 'implement',
    description: 'Run opencode to implement the module named in .last-module',
    main
};
