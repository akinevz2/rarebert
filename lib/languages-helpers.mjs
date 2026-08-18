import { languages } from './languages.mjs';
import { cli, tui } from './module.mjs';

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

async function install(opts, positional) {
    const nameArg = positional[0];
    const force = !!opts.force;

    let lang = nameArg;
    if (!lang) {
        lang = await tui.input('Language to install (e.g. ts, rb, go):', {
            validate: (v) => (v.trim() ? true : 'Language is required')
        });
    }
    lang = lang.replace(/^\.+/, '').toLowerCase();

    if (languages.isSupported(lang) && !force) {
        const overwrite = await tui.confirm(
            `Language "${lang}" is already installed. Overwrite?`,
            false
        );
        if (!overwrite) return cli.ok('Not overwritten.');
    }

    console.log(`languages: installing "${lang}"...`);
    const result = await languages.install(lang, { force });
    console.log(`\n✓ Installed language: ${result.name}`);
    console.log(`  template: ${result.path}`);
    console.log(`  lines: ${Object.keys(result.template.lines).length}`);
    console.log(`  sections: ${result.template.sections.length} line keys`);
    return cli.ok(`Done. New modules can now use .${result.name}`);
}

export { showLanguages, install };
export default { showLanguages, install };