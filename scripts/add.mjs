#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { project, normalizeModuleName, exit } from '../lib/core.mjs';
import { template } from '../lib/template.mjs';
import { libs } from '../lib/libs.mjs';
import { editor } from '../lib/editor.mjs';
import { git } from '../lib/git.mjs';
import { models } from '../lib/models.mjs';
import { opencode } from '../lib/opencode.mjs';
import { languages } from '../lib/languages.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

const meta = {
    name: 'add',
    description:
        'Scaffold a new module: pick project (core/non-core), pick language, then git add, edit, and run opencode headlessly to implement',
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

    console.log(`add: installing "${name}"...`);
    const result = await languages.install(name, { force: true });
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
        throw new AbortError();
    }
}

async function promptProjectLibs(lang) {
    const foundLibs = libs.findProjectLibs(lang);
    if (foundLibs.length === 0 || !cli.isInteractive()) return [];

    const choices = foundLibs.map((lib) => ({
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

    const modulePath = path.join(project.srcDir, `${moduleName}${ext}`);
    if (fs.existsSync(modulePath)) {
        cli.fail(`${moduleName}${ext} already exists in src/`);
    }
    fs.mkdirSync(project.srcDir, { recursive: true });

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
    console.log('\n=== Rarebert Module Creator ===\n');

    const proj = await cli.select('Select a project for the new module:', projectChoices(), {
        nonInteractiveBehavior: 'fail',
        initial: 0
    });

    let lang;
    let directory;
    if (proj === 'core') {
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
        throw new AbortError();
    }
    const normalizedName = normalizeModuleName(name, [ext]);

    console.log(`\nGenerating ${lang} module skeleton in ${directory}/...`);
    let modulePath;
    let selectedLibs = [];
    if (directory === 'src') {
        const result = await scaffoldSrcModule(lang, normalizedName);
        modulePath = result.modulePath;
        selectedLibs = result.selectedLibs;
    } else {
        modulePath = libs.createModule('scripts', normalizedName, ext);
    }

    const rel = libs.relPath(modulePath);
    console.log(`\n✓ Created module: ${rel}`);

    if (directory === 'src' && selectedLibs.length > 0) {
        console.log('  Preamble imports:');
        selectedLibs.forEach((lib) => {
            const line =
                lang === 'py'
                    ? `    - from lib.${lang} import ${lib}`
                    : `    - import * as ${lib} from '../lib/${lang}/${lib}.${lang}'`;
            console.log(line);
        });
    }

    if (directory === 'scripts') {
        console.log('\n--- Boilerplate Instructions ---');
        const libraries = libs.findLibraries();
        if (libraries.length > 0) {
            libraries.forEach((lib) => console.log(`- Framework library: lib/${lib}.mjs`));
        } else {
            console.log('- No framework utilities yet (core.mjs created in lib/)');
        }
        console.log('- Project-specific libraries live in lib/{lang}/ (e.g. lib/py/, lib/mjs/)');
        console.log('- Import shared utilities from ../lib/core.mjs as needed');
        console.log('- Implement the main() function with your logic');
        console.log('-------------------------------');
    }

    editor.writeLastModule(rel);
    console.log(rel);

    const stageResult = git.add([], { all: true, stdio: 'inherit' });
    if (!stageResult.ok) {
        console.error('add: git add -A failed; continuing');
    }

    const editorChild = editor.editFile(modulePath);
    const editorExit = await new Promise((resolve) => {
        editorChild.on('exit', (code) => resolve(code ?? 0));
    });
    if (editorExit !== 0) return exit(editorExit);

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const modelArg = nonFlag[0];
    const model = await models.resolve(modelArg);

    const context = editor.loadContent(modulePath) || '';
    const instruction = [
        `Implement the module in ${rel}.`,
        '',
        '--- active files context ---',
        context
    ]
        .filter((s) => s && s.trim())
        .join('\n');

    const ocArgs = ['run', instruction, '-m', model, '--auto'];
    console.log(
        `$ opencode run "<prompt: ${instruction.length} bytes, 1 file>" -m ${model} --auto`
    );
    const result = spawnSync(opencode.resolve(), ocArgs, {
        cwd: project.root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit']
    });
    if (result.status !== 0) {
        console.error(`add: opencode run exited with status ${result.status ?? 0}`);
    }
    const out = (result.stdout ?? '').trim();
    if (out) console.log(out);

    console.log(
        '\nNext: `make commit` if happy with the one-shot, or `make edit` then `make implement` to iterate.'
    );
    return exit(result.status ?? 0);
}

export { main, pickLanguage, ensureLanguage, buildPreamble };

export default {
    name: 'add',
    description:
        'Scaffold a new module: pick project (core/non-core), pick language, then git add, edit, and run opencode headlessly to implement',
    main: cli.run(meta, main)
};
