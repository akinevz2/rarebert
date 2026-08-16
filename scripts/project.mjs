#!/usr/bin/env node

import { CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
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
    if (!sub || sub === 'list' || sub === '--list') {
        showList();
        return exit(0);
    }
    if (sub === 'install') {
        await install(opts, positional.slice(1));
        return exit(0);
    }
    if (sub === 'choose') {
        const lang = await chooseLanguage();
        console.log(lang);
        return exit(0);
    }
    return exit(1, () => console.error(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`));
}, meta).supportsDirectRunning(import.meta.url);