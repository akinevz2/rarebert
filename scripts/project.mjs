#!/usr/bin/env node

import { CLI, cli } from '../lib/module.mjs';
import { chooseLanguage, install, showList } from '../lib/project-helpers.mjs';

const meta = {
    name: 'project',
    description: 'Choose or install a module language before scaffolding a destination file',
    usage: 'node index.js project [list | install <lang> | choose]',
    options: [{ flag: '--force', description: 'overwrite an installed template' }]
};

export { meta };

export default new CLI('project.mjs', async (opts, positional) => {
    const sub = positional[0];
    if (!sub || sub === 'list' || sub === '--list') return showList();
    if (sub === 'install') return await install(opts, positional.slice(1));
    if (sub === 'choose') {
        const lang = await chooseLanguage();
        console.log(lang);
        return;
    }
    cli.fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
}, meta).supportsDirectRunning(import.meta.url);