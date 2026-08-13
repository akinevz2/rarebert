#!/usr/bin/env node

import { backend } from '../lib/backend.mjs';
import { exit } from '../lib/core.mjs';
import { CLI } from '../lib/module.mjs';

const meta = {
    name: 'onboard',
    description:
        'Interactively configure opencode.json (endpoint + model) and register the current project with rarebert (mark module-containing folders)',
    usage: 'node index.js onboard [--force]',
    options: [{ flag: '--force', description: 'reconfigure even if a config/project registration exists' }]
};

export { meta };

export default new CLI('onboard.mjs', async (opts, positional) => {
    const force = !!opts.force || positional.includes('--force') || positional.includes('-f');

    const configOk = await backend.runOnboard({ force });
    if (!configOk && !backend.isConfigured()) {
        return exit(1);
    }

    const projectOk = await backend.projectOnboard({ force });
    if (!projectOk) {
        return exit(1);
    }

    return exit(0);
}, meta).supportsDirectRunning(import.meta.url);