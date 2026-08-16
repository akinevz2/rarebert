#!/usr/bin/env node

import { git } from '../lib/git.mjs';
import { CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import {
    collectChanges,
    categorize,
    inventoryAddedModules,
    printSummary
} from '../lib/upgrades.mjs';

const meta = {
    name: 'upgrades',
    description:
        'Compare local tree against origin/main: report added/modified/deleted files, identify added modules, and itemise newly-added methods per module',
    usage: 'node index.js upgrades [--base <ref>]',
    options: [
        { flag: '--base <ref>', description: 'base ref to diff against (default: origin/main)' }
    ]
};

export { meta, collectChanges, categorize, inventoryAddedModules };

export default new CLI('upgrades.mjs', async (opts, positional) => {
    const base = (opts && opts.base) || 'origin/main';

    let rows;
    try {
        rows = collectChanges(base);
    } catch (err) {
        console.error(`upgrades: ${err.message}`);
        return exit(1);
    }

    const buckets = categorize(rows);
    const inventory = inventoryAddedModules(buckets.added, git.root);
    printSummary(buckets, inventory, base);
    return exit(0);
}, meta).supportsDirectRunning(import.meta.url);