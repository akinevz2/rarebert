#!/usr/bin/env node

import { backend } from '../lib/backend.mjs';
import { exit } from '../lib/core.mjs';
import { Module } from '../lib/modules.mjs';

const meta = {
    name: 'onboard',
    description:
        'Interactively configure opencode.json (endpoint + model) and register the current project with rarebert (mark module-containing folders)',
    usage: 'node index.js onboard [--force]',
    options: [{ flag: '--force', description: 'reconfigure even if a config/project registration exists' }]
};

async function main(opts = {}, positional = []) {
    const force = !!opts.force || positional.includes('--force') || positional.includes('-f');

    // 1. opencode config (endpoint + model)
    const configOk = await backend.runOnboard({ force });
    if (!configOk && !backend.isConfigured()) {
        return exit(1);
    }

    // 2. per-project registration (mark module folders)
    const projectOk = await backend.projectOnboard({ force });
    if (!projectOk) {
        return exit(1);
    }

    return exit(0);
}

export { main };

const module = new Module('onboard.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);