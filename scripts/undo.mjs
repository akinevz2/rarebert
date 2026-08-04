#!/usr/bin/env node

import { PROJECT_ROOT, normalizeModuleName } from '../lib/core.mjs';
import { readLastModule, clearLastModule } from '../lib/editor.mjs';
import { confirm } from '../lib/cli.mjs';
import fs from 'fs';
import path from 'path';

async function main(args = []) {
    const rel = readLastModule();
    if (!rel) {
        console.error('Nothing to undo. No .last-module marker found.');
        process.exit(1);
    }

    const absPath = path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);

    if (fs.existsSync(absPath)) {
        const confirmed = await confirm(`Remove module '${rel}' and clear .last-module marker?`, false);
        if (!confirmed) {
            console.error('Aborted.');
            process.exit(0);
        }
        fs.unlinkSync(absPath);
        console.error(`✓ Removed module: ${rel}`);
    } else {
        console.error(`Module file not found (already removed?): ${rel}`);
    }

    clearLastModule();
    console.error('✓ Cleared .last-module marker');
}

export { main };

export default {
    name: 'undo',
    description: 'Remove the last-added module and clear .last-module',
    main
};