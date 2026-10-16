#!/usr/bin/env node

import { CLI } from '../lib/runtime/module.ts';
import { exit } from '../lib/core.ts';
import { languages } from '../lib/languages.ts';
import { chooseLanguage, installFromArgs } from './languages.ts';

const meta = {
    name: 'project',
    description: 'Choose or install a module language before scaffolding a destination file',
    usage: 'node index.js project [list | install <lang> | choose]',
    options: [{ flag: '--force', description: 'overwrite an installed template' }]
};

export { meta };

export default new CLI(
    'project.ts',
    async (opts, positional) => {
        const sub = positional[0];
        if (!sub || sub === 'list' || sub === '--list') {
            languages.show({ label: 'project' });
            return exit(0);
        }
        if (sub === 'install') {
            await installFromArgs(opts, positional.slice(1));
            return exit(0);
        }
        if (sub === 'choose') {
            const lang = await chooseLanguage();
            console.log(lang);
            return exit(0);
        }
        return exit(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
    },
    meta
).supportsDirectRunning(import.meta.url);
