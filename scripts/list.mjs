#!/usr/bin/env node

import { CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import { home } from '../lib/projects.mjs';

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

/**
 * List rarebert modules across all discovered project folders.
 *
 * Primary caller: the Dispatcher (index.js) — its listing path
 * (`isListing(cmd)` → `listModules([cmd, ...rest].filter(Boolean))`)
 * delegates here.
 *
 * @param {string[]} [args=[]] - Positional args / flags forwarded to
 *   `home.listModules` (e.g. `--lib`, `--src`, `--scripts`, `--supports`).
 * @param {object} [opts={}] - Optional options object.
 * @param {Set<string>|string[]|null} [opts.helpCommands=null] - Dispatcher
 *   contract for future use: entries of `args` that are members of this
 *   Set/Array are listing triggers/filter markers (the Dispatcher's bare/help
 *   handling) and are filtered out of the module-filter list before
 *   delegation. When omitted (null), every arg is forwarded as-is and
 *   behavior is unchanged.
 * @returns {Promise<void>} Resolves when listing completes.
 */
const listModules = (args = [], { helpCommands = null } = {}) => {
    const helpSet = helpCommands ? new Set(helpCommands) : null;
    const filtered = helpSet && helpSet.size > 0 ? args.filter((a) => !helpSet.has(a)) : args;
    return home.listModules(filtered);
};
export { meta, listModules };

export default new CLI(
    'list.mjs',
    async (opts, positional) => {
        const args = Array.isArray(positional) ? positional : [];
        await home.listModules(args);
        return exit(0);
    },
    meta
).supportsDirectRunning(import.meta.url);
