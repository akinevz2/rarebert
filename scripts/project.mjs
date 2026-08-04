#!/usr/bin/env node

import Enquirer from 'enquirer';
import {
    listLanguages,
    supportedExtensions,
    installLanguage,
    isSupported
} from '../lib/languages.mjs';
import {
    run,
    select,
    input,
    confirm,
    isInteractive,
    nonInteractive,
    ok,
    fail
} from '../lib/cli.mjs';

const meta = {
    name: 'project',
    description: 'Choose or install a module language before scaffolding a destination file',
    usage: 'node index.js project [list | install <lang> | choose]',
    options: [{ flag: 'force', label: '', description: 'overwrite an installed template' }]
};

function describeChoices() {
    const langs = listLanguages();
    const choices = langs.map((l) => ({ name: l, message: `.${l}` }));
    choices.push({ name: '__install__', message: 'Install a new language via opencode...' });
    return choices;
}

export async function chooseLanguage() {
    if (!isInteractive()) nonInteractive('cannot choose a language.');
    const langs = listLanguages();
    if (langs.length === 0) {
        return await installNewLanguage();
    }

    const choice = await select('Select a language for the new module:', describeChoices(), {
        nonInteractiveBehavior: 'return',
        initial: Math.max(0, langs.indexOf('mjs'))
    });

    if (choice === '__install__') {
        return await installNewLanguage();
    }
    return choice;
}

async function installNewLanguage() {
    const lang = await input('Language to install (e.g. ts, rb, go):', {
        validate: (v) => (v.trim() ? true : 'Language is required')
    });
    const name = lang.replace(/^\.+/, '').toLowerCase();

    if (isSupported(name)) {
        const overwrite = await confirm(
            `Language "${name}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) ok('Not overwritten.');
    }

    console.error(`project: installing "${name}"...`);
    const result = await installLanguage(name, { force: true });
    console.error(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

async function install(args = []) {
    const nameArg = args.find((a) => !a.startsWith('-') && a);
    const force = args.includes('--force');
    if (!nameArg) fail('Usage: node index.js project install <lang> [--force]');

    const name = nameArg.replace(/^\.+/, '').toLowerCase();
    const result = await installLanguage(name, { force });
    console.error(`\n✓ Installed language: ${result.name}`);
    console.error(`  template: ${result.path}`);
    console.error(`  lines: ${Object.keys(result.template.lines).length}`);
    ok(`Done. New modules can now use .${result.name}`);
}

function showList() {
    const langs = listLanguages();
    if (langs.length === 0) {
        console.error('project: no languages installed (lib/supports/ is empty)');
        return;
    }
    console.error(`project: ${langs.length} installed`);
    for (const l of langs) console.error(`  - ${l}  (.${l})`);
}

async function main(args = []) {
    const sub = args[0];
    if (!sub || sub === 'list' || sub === '--list') return showList();
    if (sub === 'install') return await install(args.slice(1));
    if (sub === 'choose') {
        const lang = await chooseLanguage();
        console.log(lang);
        return;
    }
    fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
}

export { main };

export default {
    name: 'project',
    description: meta.description,
    main: run(meta, main)
};
