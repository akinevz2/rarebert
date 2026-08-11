#!/usr/bin/env node

import { Module } from '../lib/modules.mjs';
import { languages } from '../lib/languages.mjs';
import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'project',
    description: 'Choose or install a module language before scaffolding a destination file',
    usage: 'node index.js project [list | install <lang> | choose]',
    options: [{ flag: '--force', description: 'overwrite an installed template' }]
};

function describeChoices() {
    const langs = languages.list();
    const choices = langs.map((l) => ({ name: l, message: `.${l}` }));
    choices.push({ name: '__install__', message: 'Install a new language via opencode...' });
    return choices;
}

export async function chooseLanguage() {
    if (!cli.isInteractive()) cli.nonInteractive('cannot choose a language.');
    const langs = languages.list();
    if (langs.length === 0) {
        return await installNewLanguage();
    }

    const choice = await cli.select('Select a language for the new module:', describeChoices(), {
        nonInteractiveBehavior: 'return',
        initial: Math.max(0, langs.indexOf('mjs'))
    });

    if (choice === '__install__') {
        return await installNewLanguage();
    }
    return choice;
}

async function installNewLanguage() {
    const lang = await cli.input('Language to install (e.g. ts, rb, go):', {
        validate: (v) => (v.trim() ? true : 'Language is required')
    });
    const name = lang.replace(/^\.+/, '').toLowerCase();

    if (languages.isSupported(name)) {
        const overwrite = await cli.confirm(
            `Language "${name}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) cli.ok('Not overwritten.');
    }

    console.log(`project: installing "${name}"...`);
    const result = await languages.install(name, { force: true });
    console.log(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

async function install(opts, positional) {
    const nameArg = positional[0];
    const force = !!opts.force;
    if (!nameArg) cli.fail('Usage: node index.js project install <lang> [--force]');

    const name = nameArg.replace(/^\.+/, '').toLowerCase();
    const result = await languages.install(name, { force });
    console.log(`\n✓ Installed language: ${result.name}`);
    console.log(`  template: ${result.path}`);
    console.log(`  lines: ${Object.keys(result.template.lines).length}`);
    cli.ok(`Done. New modules can now use .${result.name}`);
}

function showList() {
    const langs = languages.list();
    if (langs.length === 0) {
        console.log('project: no languages installed (lib/supports/ is empty)');
        return;
    }
    console.log(`project: ${langs.length} installed`);
    for (const l of langs) console.log(`  - ${l}  (.${l})`);
}

async function main(opts, positional) {
    const sub = positional[0];
    if (!sub || sub === 'list' || sub === '--list') return showList();
    if (sub === 'install') return await install(opts, positional.slice(1));
    if (sub === 'choose') {
        const lang = await chooseLanguage();
        console.log(lang);
        return;
    }
    cli.fail(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
}

export { main };

const module = new Module('project.mjs', main, meta);
export default module;
module.supportsDirectRunning(import.meta.url);
