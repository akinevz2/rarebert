#!/usr/bin/env node

import { onboard } from '../lib/backend.mjs';
import { run } from '../lib/cli.mjs';

const meta = {
    name: 'backend',
    description: 'Interactively configure opencode.json (endpoint + model)',
    usage: 'node index.js backend [--force]',
    options: [{ flag: 'force', label: '', description: 'reconfigure even if a config exists' }]
};

async function main(args = []) {
    await onboard(args);
}

export { main };

export default {
    name: 'backend',
    description: meta.description,
    main: run(meta, main)
};
