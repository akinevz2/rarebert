#!/usr/bin/env node

import { project, normalizeModuleName, exit } from '../lib/core.mjs';
import { editor } from '../lib/editor.mjs';
import { cli } from '../lib/cli.mjs';
import fs from 'fs';
import path from 'path';

async function main(args = []) {
    const rel = editor.readLastModule();
    if (!rel) {
        console.error('Nothing to undo. No .last-module marker found.');
        return exit(1);
    }

    const absPath = path.isAbsolute(rel) ? rel : path.join(project.root, rel);

    if (fs.existsSync(absPath)) {
        const confirmed = await cli.confirm(
            `Remove module '${rel}' and clear .last-module marker?`,
            false
        );
        if (!confirmed) {
            console.error('Aborted.');
            return exit(0);
        }
        fs.unlinkSync(absPath);
        console.log(`✓ Removed module: ${rel}`);
    } else {
        console.error(`Module file not found (already removed?): ${rel}`);
    }

    editor.clearLastModule();
    console.log('✓ Cleared .last-module marker');
}

export { main };

export default {
    name: 'undo',
    description: 'Remove the last-added module and clear .last-module',
    main
};
