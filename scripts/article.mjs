#!/usr/bin/env node

import { CLI } from '../lib/module.mjs';
import { runMenu } from '../lib/article.mjs';

const meta = {
    name: 'article',
    description: 'Manage the academic report: clone, build, edit a section, commit',
    usage: 'node index.js article [--preview] [section] [model]',
    options: [{ flag: '-p, --preview', description: 'Preview mode' }]
};

export { meta };

export default new CLI('article.mjs', async (opts, positional) => {
    await runMenu(opts, positional);
}, meta).supportsDirectRunning(import.meta.url);