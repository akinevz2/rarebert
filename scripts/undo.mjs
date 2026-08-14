#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { current } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { CLI, cli } from '../lib/module.mjs';
import { editor } from '../lib/editor.mjs';

const meta = {
    name: 'undo',
    description: 'Remove the last-added module and clear .last-module',
    usage: 'node index.js undo',
    options: []
};

export { meta };

export default new CLI('undo.mjs', async (opts, positional) => {
    const rel = editor.readLastModule();
    if (!rel) {
        console.error('Nothing to undo. No .last-module marker found.');
        return exit(1);
    }

    const absPath = path.isAbsolute(rel) ? rel : path.join(current.root, rel);

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
}, meta).supportsDirectRunning(import.meta.url);