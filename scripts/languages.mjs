#!/usr/bin/env node

import Enquirer from 'enquirer';
import {
    listLanguages,
    supportedExtensions,
    installLanguage,
    isSupported
} from '../lib/languages.mjs';
import { run, input, confirm, ok, fail } from '../lib/cli.mjs';

const meta = {
    name: 'languages',
    description: 'Install or list supported module languages (templates under lib/supports/)',
    usage: 'node index.js languages [install <lang> [--force]]',
    options: [{ flag: 'force', label: '', description: 'overwrite an existing template' }]
};

function showLanguages() {
    const langs = listLanguages();
    if (langs.length === 0) {
        console.error('languages: no templates installed (lib/supports/ is empty)');
        return;
    }
    console.error(`languages: ${langs.length} installed`);
    for (const lang of langs) {
        console.error(`  - ${lang}  (extension: .${lang})`);
    }
}

async function install(args = []) {
    const nameArg = args.find((a) => !a.startsWith('-') && a);
    const force = args.includes('--force');

    let lang = nameArg;
    if (!lang) {
        lang = await input('Language to install (e.g. ts, rb, go):', {
            validate: (v) => (v.trim() ? true : 'Language is required')
        });
    }
    lang = lang.replace(/^\.+/, '').toLowerCase();

    if (isSupported(lang) && !force) {
        const overwrite = await confirm(
            `Language "${lang}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) ok('Not overwritten.');
    }

    console.error(`languages: installing "${lang}"...`);
    const result = await installLanguage(lang, { force });
    console.error(`\n✓ Installed language: ${result.name}`);
    console.error(`  template: ${result.path}`);
    console.error(`  lines: ${Object.keys(result.template.lines).length}`);
    console.error(`  sections: ${Object.keys(result.template.sections).join(', ')}`);
    ok(`Done. New modules can now use .${result.name}`);
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
    fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
}

export { main, showLanguages };

export default {
    name: 'languages',
    description: meta.description,
    main: run(meta, main)
};
