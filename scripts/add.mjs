#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { normalizeModuleName, SRC_DIR } from '../lib/core.mjs';
import * as template from '../lib/template.mjs';
import {
    findLibraries,
    findProjectLibs,
    createModule,
    projectLibDir,
    relPath
} from '../lib/libs.mjs';
import { writeLastModule, editFile } from '../lib/editor.mjs';
import * as git from '../lib/git.mjs';
import { runIDE } from '../lib/ide.mjs';
import { resolveModel } from '../lib/models.mjs';
import { listLanguages, isSupported, installLanguage } from '../lib/languages.mjs';
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
    name: 'add',
    description:
        'Scaffold a new module: pick project (core/non-core), pick language, then git add, edit, and run opencode to implement',
    usage: 'node index.js add [model]',
    options: [{ flag: 'force', label: '', description: 'overwrite an installed language template' }]
};

function projectChoices() {
    return [
        { name: 'core', message: 'core      (rarebert framework module, lib/ + scripts/, .mjs)' },
        { name: 'src', message: 'src       (project module, src/, any installed language)' }
    ];
}

function languageChoices() {
    const langs = listLanguages();
    const choices = langs.map((l) => ({ name: l, message: `.${l}` }));
    choices.push({ name: '__install__', message: 'Install a new language via opencode...' });
    return choices;
}

async function ensureLanguage(lang, options = {}) {
    if (isSupported(lang)) return lang;
    if (!isInteractive()) nonInteractive(`language "${lang}" is not scaffolded.`);
    console.error(`add: language "${lang}" is not scaffolded yet; running languages toolkit...`);
    const result = await installLanguage(lang, { force: options.force });
    console.error(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

async function pickLanguage(defaultLang = 'mjs') {
    if (!isInteractive()) nonInteractive('cannot pick a language.');
    const langs = listLanguages();
    if (langs.length === 0) return await installNewLanguage();

    const initial = Math.max(0, langs.indexOf(defaultLang));
    const choice = await select('Select a language for the new module:', languageChoices(), {
        nonInteractiveBehavior: 'return',
        initial
    });

    if (choice === '__install__') return await installNewLanguage();
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

    console.error(`add: installing "${name}"...`);
    const result = await installLanguage(name, { force: true });
    console.error(`\n✓ Installed language: ${result.name} (${result.path})`);
    return result.name;
}

async function promptModuleName(lang) {
    const ext = `.${lang}`;
    const namePrompt = new Enquirer.Input({
        message: `Enter the module name (${ext} extension added automatically):`,
        validate: (val) => {
            if (!val.trim()) return 'Module name is required';
            try {
                normalizeModuleName(val, [ext]);
                return true;
            } catch (e) {
                return e.message;
            }
        }
    });
    try {
        return await namePrompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

async function promptProjectLibs(lang) {
    const libs = findProjectLibs(lang);
    if (libs.length === 0 || !isInteractive()) return [];

    const choices = libs.map((lib) => ({
        name: lib,
        message: `lib/${lang}/${lib}.${lang}`
    }));

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
        console.error('\nAborted.');
        process.exit(130);
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

    const modulePath = path.join(SRC_DIR, `${moduleName}${ext}`);
    if (fs.existsSync(modulePath)) {
        fail(`${moduleName}${ext} already exists in src/`);
    }
    fs.mkdirSync(SRC_DIR, { recursive: true });

    const content = template
        .resolve(ext, {
            MODULE_NAME: moduleName,
            LIB_IMPORTS: preamble
        })
        .join('\n');
    fs.writeFileSync(modulePath, content);

    return { modulePath, selectedLibs };
}

async function main(args = []) {
    console.error('\n=== Rarebert Module Creator ===\n');

    const project = await select('Select a project for the new module:', projectChoices(), {
        nonInteractiveBehavior: 'fail',
        initial: 0
    });

    let lang;
    let directory;
    if (project === 'core') {
        lang = 'mjs';
        directory = 'scripts';
        await ensureLanguage(lang);
    } else {
        lang = await pickLanguage();
        directory = 'src';
    }

    const ext = `.${lang}`;
    const name = await promptModuleName(lang);
    if (!name || !name.trim()) {
        console.error('\nAborted.');
        process.exit(130);
    }
    const normalizedName = normalizeModuleName(name, [ext]);

    console.error(`\nGenerating ${lang} module skeleton in ${directory}/...`);
    let modulePath;
    let selectedLibs = [];
    if (directory === 'src') {
        const result = await scaffoldSrcModule(lang, normalizedName);
        modulePath = result.modulePath;
        selectedLibs = result.selectedLibs;
    } else {
        modulePath = createModule('scripts', normalizedName, ext);
    }

    const rel = relPath(modulePath);
    console.error(`\n✓ Created module: ${rel}`);

    if (directory === 'src' && selectedLibs.length > 0) {
        console.error('  Preamble imports:');
        selectedLibs.forEach((lib) => {
            const line =
                lang === 'py'
                    ? `    - from lib.${lang} import ${lib}`
                    : `    - import * as ${lib} from '../lib/${lang}/${lib}.${lang}'`;
            console.error(line);
        });
    }

    if (directory === 'scripts') {
        console.error('\n--- Boilerplate Instructions ---');
        const libraries = findLibraries();
        if (libraries.length > 0) {
            libraries.forEach((lib) => console.error(`- Framework library: lib/${lib}.mjs`));
        } else {
            console.error('- No framework utilities yet (core.mjs created in lib/)');
        }
        console.error('- Project-specific libraries live in lib/{lang}/ (e.g. lib/py/, lib/mjs/)');
        console.error('- Import shared utilities from ../lib/core.mjs as needed');
        console.error('- Implement the main() function with your logic');
        console.error('-------------------------------');
    }

    writeLastModule(rel);
    console.log(rel);

    const stageResult = git.add([], { all: true, stdio: 'inherit' });
    if (!stageResult.ok) {
        console.error('add: git add -A failed; continuing');
    }

    const editor = editFile(modulePath);
    const editorExit = await new Promise((resolve) => {
        editor.on('exit', (code) => resolve(code ?? 0));
    });
    if (editorExit !== 0) process.exit(editorExit);

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const modelArg = nonFlag[0];
    const model = await resolveModel(modelArg);
    const { status } = runIDE(model, rel, { implement: true });
    if (status && status !== 0) process.exit(status);
}

export { main, pickLanguage, ensureLanguage, buildPreamble };

export default {
    name: 'add',
    description: meta.description,
    main: run(meta, main)
};
