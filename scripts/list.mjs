#!/usr/bin/env node

import { CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import { listModules } from '../lib/list.mjs';

const meta = {
    name: 'list',
    description: 'List rarebert modules across all discovered project folders',
    usage: 'node index.js list [--lib|--src|--scripts|--supports]',
    options: [
        { flag: '--lib', description: 'list only lib/ modules' },
        { flag: '--src', description: 'list only src/ modules' },
        { flag: '--scripts', description: 'list only scripts/ modules' },
        { flag: '--supports', description: 'list only lib/supports/ modules' }
    ]
};

export { meta, listModules };

export default new CLI('list.mjs', async (opts, positional) => {
    const args = Array.isArray(positional) ? positional : [];
    await listModules(args);
    return exit(0);
}, meta).supportsDirectRunning(import.meta.url);