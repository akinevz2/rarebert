#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { cli, CLI, TUI } from '../lib/module.mjs';
import { updateSelf, updateLanguage } from '../lib/update.mjs';

const meta = {
    name: 'update',
    description:
        'Update rarebert: `update self` fetches and merges origin into the local install branch; `update language <lang>` scaffolds a new lib/supports/lang{ext}.js support module for an additional language.',
    usage: 'node index.js update <self|language> [lang] [--force] [--model <id>]',
    options: [
        { flag: '--force', description: 'overwrite an existing language support module' },
        { flag: '--model <id>', description: 'opencode model for generating the support module' }
    ]
};

export { meta, updateSelf, updateLanguage };

export default new CLI('update.mjs', async (opts = {}, positional = []) => {
    const args = Array.isArray(positional) ? positional : [];
    const sub = args[0];

    if (sub === 'self') return updateSelf();

    if (sub === 'language') {
        const langArg = args[1];
        if (!langArg) {
            console.error('Usage: node index.js update language <lang> [--force] [--model <id>]');
            return exit(1);
        }
        return updateLanguage(langArg, { force: !!opts.force, model: opts.model });
    }

    if (!cli.isInteractive()) {
        console.error('Usage: node index.js update <self|language> [lang] [--force] [--model <id>]');
        return exit(1);
    }

    return exit(new TUI('update.mjs', async (opts, positional) => {
        const choice = await cli.select('What would you like to update?', [
            { name: 'self', message: 'rarebert itself — fetch + merge origin' },
            { name: 'language', message: 'a language — scaffold support for a new language' }
        ]);

        if (choice === 'self') return updateSelf();

        const langInput = await cli.input('Language to add (e.g. ts, rb, go):', {
            validate: (v) => (v.trim() ? true : 'Language is required')
        });
        return updateLanguage(langInput, { force: !!opts.force, model: opts.model });
    }, meta));
}, meta).supportsDirectRunning(import.meta.url);