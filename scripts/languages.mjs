#!/usr/bin/env node

import { CLI, cli } from '../lib/module.mjs';
import { showLanguages, install } from '../lib/languages-helpers.mjs';

const meta = {
    name: 'languages',
    description: 'Install or list supported module languages (templates under lib/supports/)',
    usage: 'node index.js languages [install <lang> [--force]]',
    options: [{ flag: '--force', description: 'overwrite an existing template' }]
};

export { meta };

export default new CLI('languages.mjs', async (opts, positional) => {
    const sub = positional[0];
    if (!sub || sub === 'list' || sub === '--list') {
        showLanguages();
        return;
    }
    if (sub === 'install') {
        await install(opts, positional.slice(1));
        return;
    }
    cli.fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
}, meta).supportsDirectRunning(import.meta.url);