#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { exit } from '../lib/core.mjs';
import { CLI, AbortError, Interface, TUI, cli } from '../lib/module.mjs';
import { libs } from '../lib/libs.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { git } from '../lib/git.mjs';
import { models } from '../lib/models.mjs';
import { rarebert } from '../lib/projects.mjs';
import { languages } from '../lib/languages.mjs';
import { chooseLanguage } from './languages.mjs';

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
        return exit('Aborted');
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
        return exit('Aborted');
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

const meta = {
    name: 'add',
    description:
        'Scaffold a new module: pick project, pick language, then git add, edit, and run opencode headlessly to implement',
    usage: 'node index.js add [--model <id>] [--force]',
    options: [
        {
            flag: '-m, --model <id>',
            description: 'opencode model id (overrides the default from opencode.json)'
        },
        { flag: '--force', description: 'overwrite an installed language template' }
    ]
};

export { meta };

export default new CLI(
    'add.mjs',
    async (opts, positional) => {
        return exit(
            new TUI(
                'add.mjs',
                async (opts, positional) => {
                    console.log('\n=== Rarebert Module Creator ===\n');

                    const iface = Interface.createInterface('add');
                    const proj = await iface.select(
                        'Select a project for the new module:',
                        projectChoices(),
                        {
                            nonInteractiveBehavior: 'fail',
                            initial: 0
                        }
                    );

                    const project = rarebert.projectByKey(proj);

                    let lang;
                    let directory;
                    if (project.key === 'src') {
                        lang = await chooseLanguage();
                        directory = project.rel;
                    } else {
                        lang = 'mjs';
                        directory = project.rel;
                        await ensureLanguage(lang);
                    }

                    const ext = `.${lang}`;
                    const name = await promptModuleName(lang);
                    if (!name || !name.trim()) throw new AbortError();
                    const normalizedName = rarebert.normalizeModuleName(name, [ext]);

                    console.log(`\nGenerating ${lang} module skeleton in ${directory}/...`);
                    let modulePath;
                    let selectedLibs = [];
                    if (project.key === 'src') {
                        const result = await scaffoldSrcModule(lang, normalizedName);
                        modulePath = result.modulePath;
                        selectedLibs = result.selectedLibs;
                    } else {
                        modulePath = await libs.createModule(project.rel, normalizedName, ext);
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
                            libraries.forEach((lib) =>
                                console.log(`- Framework library: lib/${lib}.mjs`)
                            );
                        } else {
                            console.log('- No framework utilities yet (core.mjs created in lib/)');
                        }
                        console.log(
                            '- Project-specific libraries live in lib/{lang}/ (e.g. lib/py/, lib/mjs/)'
                        );
                        console.log('- Import shared utilities from ../lib/core.mjs as needed');
                        console.log('- Implement the main() function with your logic');
                        console.log('-------------------------------');
                    }

                    editor.writeLastModule(rel);
                    console.log(rel);

                    const stageResult = git.add([], { all: true, stdio: 'inherit' });
                    if (!stageResult.ok) console.error('add: git add -A failed; continuing');

                    const editorChild = ide.spawnEditor(modulePath);
                    if (editorChild) {
                        const editorExit = await ide.awaitChild(editorChild);
                        if (editorExit !== 0) return exit(editorExit);
                    }

                    const model = opts.model
                        ? await models.resolve(opts.model)
                        : models.resolveDefault();

                    const context = editor.loadContent(modulePath) || '';
                    const instruction = [
                        `Implement the module in ${rel}.`,
                        '',
                        '--- active files context ---',
                        context
                    ]
                        .filter((s) => s && s.trim())
                        .join('\n');

                    const { status: runStatus, stdout: out } = ide.spawnHeadless(
                        instruction,
                        model,
                        { cwd: rarebert.root }
                    );
                    return exit(runStatus ?? 0, () => {
                        if (runStatus !== 0)
                            console.error(`add: opencode run exited with status ${runStatus}`);
                        if (out) console.log(out);
                        console.log(
                            '\nNext: `make commit` if happy with the one-shot, or `make edit` then `make implement` to iterate.'
                        );
                    });
                },
                meta
            )
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
