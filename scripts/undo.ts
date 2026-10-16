#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { rarebert } from '../lib/projects.ts';
import { exit } from '../lib/core.ts';
import { CLI, cli, TUI, Interface } from '../lib/runtime/module.ts';
import { editor } from '../lib/editor.ts';

const meta = {
    name: 'undo',
    description: 'Remove the last-added module and clear .last-module',
    usage: 'node index.js undo [--yes]',
    options: [{ flag: '--yes', description: 'Skip confirmation prompt' }]
};

export { meta };

async function performUndo(rel, absPath) {
    if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        console.log(`✓ Removed module: ${rel}`);
    } else {
        console.error(`Module file not found (already removed?): ${rel}`);
    }

    editor.clearLastModule();
    console.log('✓ Cleared .last-module marker');
    return exit(0);
}

export default new CLI(
    'undo.ts',
    async (opts, positional) => {
        const rel = editor.readLastModule();
        if (!rel) {
            console.error('Nothing to undo. No .last-module marker found.');
            return exit(1);
        }

        const absPath = path.isAbsolute(rel) ? rel : path.join(rarebert.root, rel);

        if (opts.yes) {
            return performUndo(rel, absPath);
        }

        if (!cli.isInteractive()) {
            return exit(
                'Non-interactive mode: the undo command requires confirmation. Use --yes to skip.'
            );
        }

        return exit(
            new TUI(
                'undo.ts',
                async () => {
                    const iface = Interface.createInterface('undo');
                    const confirmed = await iface.confirm(
                        `Remove module '${rel}' and clear .last-module marker?`,
                        false
                    );
                    if (!confirmed) {
                        console.error('Aborted.');
                        return exit(0);
                    }
                    return performUndo(rel, absPath);
                },
                meta
            )
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
