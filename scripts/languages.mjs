#!/usr/bin/env node

import Enquirer from 'enquirer';
import { languages } from '../lib/languages.mjs';
import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'languages',
    description: 'Install or list supported module languages (templates under lib/supports/)',
    usage: 'node index.js languages [install <lang> [--force]]',
    options: [{ flag: 'force', label: '', description: 'overwrite an existing template' }]
};

function showLanguages() {
    const langs = languages.list();
    if (langs.length === 0) {
        console.log('languages: no templates installed (lib/supports/ is empty)');
        return;
    }
    console.log(`languages: ${langs.length} installed`);
    for (const lang of langs) {
        console.log(`  - ${lang}  (extension: .${lang})`);
    }
}

async function install(args = []) {
    const nameArg = args.find((a) => !a.startsWith('-') && a);
    const force = args.includes('--force');

    let lang = nameArg;
    if (!lang) {
        lang = await cli.input('Language to install (e.g. ts, rb, go):', {
            validate: (v) => (v.trim() ? true : 'Language is required')
        });
    }
    lang = lang.replace(/^\.+/, '').toLowerCase();

    if (languages.isSupported(lang) && !force) {
        const overwrite = await cli.confirm(
            `Language "${lang}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) cli.ok('Not overwritten.');
    }

    console.log(`languages: installing "${lang}"...`);
    const result = await languages.install(lang, { force });
    console.log(`\n✓ Installed language: ${result.name}`);
    console.log(`  template: ${result.path}`);
    console.log(`  lines: ${Object.keys(result.template.lines).length}`);
    console.log(`  sections: ${result.template.sections.length} line keys`);
    cli.ok(`Done. New modules can now use .${result.name}`);
}

async function main(args = []) {
    const sub = args[0];
    if (!sub || sub === 'list' || sub === '--list') {
        showLanguages();
        return;
    }
    if (sub === 'install') {
        await install(args.slice(1));
        return;
    }
    cli.fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
}

export { main, showLanguages };

export default {
    name: 'languages',
    description: meta.description,
    main: cli.run(meta, main)
};
