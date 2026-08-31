#!/usr/bin/env node

import { CLI, Interface, cli } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import { languages } from '../lib/languages.mjs';

const meta = {
    name: 'languages',
    description: 'Install or list supported module languages (templates under lib/supports/)',
    usage: 'node index.js languages [install <lang> [--force]]',
    options: [{ flag: '--force', description: 'overwrite an existing template' }]
};

export { meta };

/**
 * Interactive language install (input + overwrite confirm + install).
 * Moved from lib/languages.mjs#installNew — Interface construction lives
 * in scripts/ per the lib-purity directive.
 */
async function installNewLanguage() {
    const iface = Interface.createInterface('languages');
    const lang = await iface.input('Language to install (e.g. ts, rb, go):', {
        validate: (v) => (v.trim() ? true : 'Language is required')
    });
    const name = lang.replace(/^\.+/, '').toLowerCase();
    if (languages.isSupported(name)) {
        const overwrite = await iface.confirm(
            `Language "${name}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) return cli.ok('Not overwritten.');
    }
    console.log(`languages: installing "${name}"...`);
    const result = await languages.install(name, { force: true });
    console.log(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

/**
 * Interactive language chooser. Moved from lib/languages.mjs#choose.
 * Guards interactivity BEFORE constructing the Interface.
 */
async function chooseLanguage({ default: defaultLang = 'mjs' } = {}) {
    if (!cli.isInteractive()) return cli.nonInteractive('cannot choose a language.');
    const iface = Interface.createInterface('languages');
    const langs = languages.list();
    if (langs.length === 0) return await installNewLanguage();
    const initial = Math.max(0, langs.indexOf(defaultLang));
    const choice = await iface.select(
        'Select a language for the new module:',
        languages.choices(),
        {
            nonInteractiveBehavior: 'return',
            initial
        }
    );
    if (choice === '__install__') return await installNewLanguage();
    return choice;
}

/**
 * CLI install path driven by opts/positionals. Moved from
 * lib/languages.mjs#installFromArgs. The Interface is constructed
 * lazily, only after an interactive guard has passed.
 */
async function installFromArgs(opts = {}, positional = []) {
    const nameArg = positional[0];
    let force = !!opts.force;
    let lang = nameArg;
    let iface = null;
    const prompt = () => (iface ??= Interface.createInterface('languages'));
    if (!lang) {
        if (!cli.isInteractive())
            return cli.fail('Usage: node index.js languages install <lang> [--force]');
        lang = await prompt().input('Language to install (e.g. ts, rb, go):', {
            validate: (v) => (v.trim() ? true : 'Language is required')
        });
    }
    lang = lang.replace(/^\.+/, '').toLowerCase();
    if (languages.isSupported(lang) && !force) {
        // Non-interactive parity with the old confirm-prompt fallback
        // (initial = false → decline the overwrite).
        if (!cli.isInteractive()) return cli.ok('Not overwritten.');
        const overwrite = await prompt().confirm(
            `Language "${lang}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) return cli.ok('Not overwritten.');
        force = true;
    }
    console.log(`languages: installing "${lang}"...`);
    const result = await languages.install(lang, { force });
    console.log(`\n✓ Installed language: ${result.name}`);
    console.log(`  template: ${result.path}`);
    console.log(`  lines: ${Object.keys(result.template.lines).length}`);
    console.log(`  sections: ${result.template.sections.length} line keys`);
    return cli.ok(`Done. New modules can now use .${result.name}`);
}

export { chooseLanguage, installNewLanguage, installFromArgs };

export default new CLI(
    'languages.mjs',
    async (opts, positional) => {
        const sub = positional[0];
        if (!sub || sub === 'list' || sub === '--list') {
            languages.show();
            return exit(0);
        }
        if (sub === 'install') {
            await installFromArgs(opts, positional.slice(1));
            return exit(0);
        }
        return exit(`Unknown subcommand: ${sub}\nUsage: ${meta.usage}`);
    },
    meta
).supportsDirectRunning(import.meta.url);
