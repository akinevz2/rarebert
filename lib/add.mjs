import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { rarebert } from './projects.mjs';
import { libs } from './libs.mjs';
import { languages } from './languages.mjs';
import { cli, AbortError } from './module.mjs';

// REQUEST: projectChoices, ensureLanguage, promptModuleName, scaffoldSrcModule are used by scripts/add.mjs.
// On ctrl-c during interactive selection:
// - Throw AbortError to signal cancellation (exit 0)
// - No file system cleanup needed (scaffolding only happens after all prompts)
// Meta suggestion: { retryOnFailure: false, cleanup: 'none' }

function projectChoices() {
    return rarebert.discover().map((p) => ({ name: p.key, message: p.label }));
}

async function ensureLanguage(lang, options = {}) {
    if (languages.isSupported(lang)) return lang;
    if (!cli.isInteractive()) return cli.nonInteractive(`language "${lang}" is not scaffolded.`);
    console.log(`add: language "${lang}" is not scaffolded yet; running languages toolkit...`);
    const result = await languages.install(lang, { force: options.force });
    console.log(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
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
        result(names) {
            return Array.isArray(names) ? names : [names];
        }
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
    return selectedLibs
        .map((lib) => `import * as ${lib} from '${prefix}${lib}.${lang}';`)
        .join('\n');
}

async function scaffoldSrcModule(lang, moduleName) {
    const ext = `.${lang}`;
    const selectedLibs = await promptProjectLibs(lang);
    const preamble = buildPreamble(lang, selectedLibs);
    const modulePath = path.join(rarebert.srcDir, `${moduleName}${ext}`);
    if (fs.existsSync(modulePath)) return cli.fail(`${moduleName}${ext} already exists in src/`);
    fs.mkdirSync(rarebert.srcDir, { recursive: true });
    const content = (
        await languages.resolveTemplate(ext, { MODULE_NAME: moduleName, LIB_IMPORTS: preamble })
    ).join('\n');
    fs.writeFileSync(modulePath, content);
    return { modulePath, selectedLibs };
}

export {
    projectChoices,
    ensureLanguage,
    promptModuleName,
    promptProjectLibs,
    buildPreamble,
    scaffoldSrcModule
};
export default { ensureLanguage, buildPreamble, scaffoldSrcModule };
