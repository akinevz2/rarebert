import { languages } from './languages.mjs';
import { cli, tui } from './module.mjs';

function describeChoices() {
    const langs = languages.list();
    const choices = langs.map((l) => ({ name: l, message: `.${l}` }));
    choices.push({ name: '__install__', message: 'Install a new language via opencode...' });
    return choices;
}

async function chooseLanguage() {
    if (!cli.isInteractive()) return cli.nonInteractive('cannot choose a language.');
    const langs = languages.list();
    if (langs.length === 0) {
        return await installNewLanguage();
    }

    const choice = await tui.select('Select a language for the new module:', describeChoices(), {
        nonInteractiveBehavior: 'return',
        initial: Math.max(0, langs.indexOf('mjs'))
    });

    if (choice === '__install__') {
        return await installNewLanguage();
    }
    return choice;
}

async function installNewLanguage() {
    const lang = await tui.input('Language to install (e.g. ts, rb, go):', {
        validate: (v) => (v.trim() ? true : 'Language is required')
    });
    const name = lang.replace(/^\.+/, '').toLowerCase();

    if (languages.isSupported(name)) {
        const overwrite = await tui.confirm(
            `Language "${name}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) return cli.ok('Not overwritten.');
    }

    console.log(`project: installing "${name}"...`);
    const result = await languages.install(name, { force: true });
    console.log(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

async function install(opts, positional) {
    const nameArg = positional[0];
    const force = !!opts.force;
    if (!nameArg) return cli.fail('Usage: node index.js project install <lang> [--force]');

    const name = nameArg.replace(/^\.+/, '').toLowerCase();
    const result = await languages.install(name, { force });
    console.log(`\n✓ Installed language: ${result.name}`);
    console.log(`  template: ${result.path}`);
    console.log(`  lines: ${Object.keys(result.template.lines).length}`);
    return cli.ok(`Done. New modules can now use .${result.name}`);
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

export { describeChoices, chooseLanguage, installNewLanguage, install, showList };
export default { chooseLanguage, install, showList };