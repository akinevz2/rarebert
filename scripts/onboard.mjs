#!/usr/bin/env node

import { backend } from '../lib/backend.mjs';
import { Module } from '../lib/modules.mjs';

const meta = {
    name: 'onboard',
    description: 'Interactively configure opencode.json (endpoint + model)',
    usage: 'node index.js onboard [--force]',
    options: [{ flag: '--force', description: 'reconfigure even if a config exists' }]
};

async function main(opts, positional) {
    await backend.onboard(positional);
}

export { main };

const module = new Module('onboard.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
