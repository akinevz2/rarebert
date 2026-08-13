import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { rarebert } from './projects.mjs';
import { libs } from './libs.mjs';
import { languages } from './languages.mjs';
import { cli, AbortError } from './module.mjs';

function projectChoices() {
    return rarebert.discover().map((p) => ({ name: p.key, message: p.label }));
}

function languageChoices() {
    const langs = languages.list();
    const choices = langs.map((l) => ({ name: l, message: `.${l}` }));
    choices.push({ name: '__install__', message: 'Install a new language via opencode...' });
    return choices;
}

async function ensureLanguage(lang, options = {}) {
    if (languages.isSupported(lang)) return lang;
    if (!cli.isInteractive()) cli.nonInteractive(`language "${lang}" is not scaffolded.`);
    console.log(`add: language "${lang}" is not scaffolded yet; running languages toolkit...`);
    const result = await languages.install(lang, { force: options.force });
    console.log(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

async function installNewLanguage() {
    const lang = await cli.input('Language to install (e.g. ts, rb, go):', {
        validate: (v) => (v.trim() ? true : 'Language is required')
    });
    const name = lang.replace(/^\.+/, '').toLowerCase();
    if (languages.isSupported(name)) {
        const overwrite = await cli.confirm(`Language "${name}" is already installed. Overwrite?`, false);
        if (!overwrite) cli.ok('Not overwritten.');
    }
    console.log(`add: installing "${name}"...`);
    const result = await languages.install(name, { force: true });
    console.log(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

async function pickLanguage(defaultLang = 'mjs') {
    if (!cli.isInteractive()) cli.nonInteractive('cannot pick a language.');
    const langs = languages.list();
    if (langs.length === 0) return await installNewLanguage();
    const initial = Math.max(0, langs.indexOf(defaultLang));
    const choice = await cli.select('Select a language for the new module:', languageChoices(), {
        nonInteractiveBehavior: 'return',
        initial
    });
    if (choice === '__install__') return await installNewLanguage();
    return choice;
}

async function promptModuleName(lang) {
    const ext = `.${lang}`;
    const namePrompt = new Enquirer.Input({
        message: `Enter the module name (${ext} extension added automatically):`,
        validate: (val) => {
            if (!val.trim()) return 'Module name is required';
            try {
                rarebert.normalizeModuleName(val, [ext]);
                return true;
            } catch (e) {
                return e.message;
            }
        }
    });
    try {
        return await namePrompt.run();
    } catch {
        throw new AbortError();
    }
}

async function promptProjectLibs(lang) {
    const foundLibs = libs.findProjectLibs(lang);
    if (foundLibs.length === 0 || !cli.isInteractive()) return [];
    const choices = foundLibs.map((lib) => ({ name: lib, message: `lib/${lang}/${lib}.${lang}` }));
    const prompt = new Enquirer.MultiSelect({
        name: 'libraries',
        message: `Select ${lang} libraries from lib/${lang}/ to add to the preamble:`,
        choices,
        result(names) { return Array.isArray(names) ? names : [names]; }
    });
    try {
        const answer = await prompt.run();
        return Array.isArray(answer) ? answer : [answer];
    } catch {
        throw new AbortError();
    }
}

function buildPreamble(lang, selectedLibs) {
    if (selectedLibs.length === 0) return '';
    if (lang === 'py') {
        return selectedLibs.map((lib) => `from lib.${lang} import ${lib}`).join('\n');
    }
    const prefix = `../lib/${lang}/`;
    return selectedLibs.map((lib) => `import * as ${lib} from '${prefix}${lib}.${lang}';`).join('\n');
}

async function scaffoldSrcModule(lang, moduleName) {
    const ext = `.${lang}`;
    const selectedLibs = await promptProjectLibs(lang);
    const preamble = buildPreamble(lang, selectedLibs);
    const modulePath = path.join(rarebert.srcDir, `${moduleName}${ext}`);
    if (fs.existsSync(modulePath)) cli.fail(`${moduleName}${ext} already exists in src/`);
    fs.mkdirSync(rarebert.srcDir, { recursive: true });
    const content = (
        await languages.resolveTemplate(ext, { MODULE_NAME: moduleName, LIB_IMPORTS: preamble })
    ).join('\n');
    fs.writeFileSync(modulePath, content);
    return { modulePath, selectedLibs };
}

export {
    projectChoices,
    languageChoices,
    ensureLanguage,
    pickLanguage,
    installNewLanguage,
    promptModuleName,
    promptProjectLibs,
    buildPreamble,
    scaffoldSrcModule
};
export default { pickLanguage, ensureLanguage, buildPreamble, scaffoldSrcModule };