#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../lib/core.mjs';
import { readLastModule, clearLastModule } from '../lib/editor.mjs';

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('undo: Remove the last-added module and clear .last-module');
        console.error('  Usage: node index.js undo');
        console.error('  Reads the target path from .last-module and deletes the module file.');
        return;
    }

    const rel = readLastModule();
    if (!rel) {
        console.error('Nothing to undo. No .last-module marker found.');
        process.exit(1);
    }

    const absPath = path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);

    if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        console.error(`✓ Removed module: ${rel}`);
    } else {
        console.error(`Module file not found (already removed?): ${rel}`);
    }

    clearLastModule();
    console.error('✓ Cleared .last-module marker');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main };

export default {
    name: 'undo',
    description: 'Remove the last-added module and clear .last-module',
    main
};