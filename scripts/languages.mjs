#!/usr/bin/env node

import { CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import { languages } from '../lib/languages.mjs';

const meta = {
    name: 'languages',
    description: 'Install or list supported module languages (templates under lib/supports/)',
    usage: 'node index.js languages [install <lang> [--force]]',
    options: [{ flag: '--force', description: 'overwrite an existing template' }]
};

export { meta };

export default new CLI(
    'languages.mjs',
    async (opts, positional) => {
        const sub = positional[0];
        if (!sub || sub === 'list' || sub === '--list') {
            languages.show();
            return exit(0);
        }
        if (sub === 'install') {
            await languages.installFromArgs(opts, positional.slice(1));
            return exit(0);
        }
        return exit(1, () => console.error(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`));
    },
    meta
).supportsDirectRunning(import.meta.url);
