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
import { rarebert, home } from '../lib/projects.mjs';
import { languages } from '../lib/languages.mjs';
import { backend } from '../lib/backend.mjs';
import { chooseLanguage } from './languages.mjs';
import { loadSupportTemplate } from './update.mjs';

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
        { flag: '--force', description: 'overwrite an installed language template' },
        {
            flag: '-l, --language <lang>',
            description:
                'create a language support module (lib/supports/lang<ext>.js): scaffold → editor → one-shot opencode implement → interactive opencode amend'
        }
    ]
};

export { meta };

// ---------------------------------------------------------------------------
// add --language "<lang>" — the language-support workflow:
//   1. create lib/supports/lang<ext>.js from lib/supports/template.json
//   2. open it in the editor for review
//   3. one-shot opencode implement of the parser stubs
//   4. validate (loadLanguage + parser smoke — the "tests")
//   5. interactive opencode session to correct/amend until validation passes
// ---------------------------------------------------------------------------

async function validateLanguageSupport(name, rel) {
    languages.instanceCache.delete(name);
    const checks = [];
    let ok = true;
    try {
        const lang = await languages.loadLanguage(name);
        checks.push(`✓ loads as a Language instance (.${name})`);
        const sample = `// sample\nimport x from 'y';\n\nfunction main() {\n    return 1;\n}\n`;
        const imports = lang.parseImports(sample);
        checks.push(
            `✓ parseImports → ${Array.isArray(imports) ? `${imports.length} result(s)` : 'non-array'}`
        );
        lang.extractMainFunction(sample);
        checks.push('✓ extractMainFunction ran');
        lang.extractPublicMembers(sample);
        checks.push('✓ extractPublicMembers ran');
        lang.extractBindings(sample);
        checks.push('✓ extractBindings ran');
    } catch (err) {
        ok = false;
        checks.push(`✗ ${err.message}`);
    }
    return { ok, summary: `Validation report for ${rel}:\n  ${checks.join('\n  ')}` };
}

async function languageSupportWorkflow(langArg, opts) {
    const name = languages.parseExt(langArg).toLowerCase();

    // Preconditions: onboard (opencode.jsonc) first, then add (folders).
    if (!backend.isConfigured()) {
        return exit('add --language: onboard first (make onboard) to create opencode.jsonc.');
    }
    if (languages.isSupported(name) && !opts.force) {
        return exit(
            `add --language: "${name}" already has a support module (use --force to overwrite).`
        );
    }

    const iface = Interface.createInterface('add');
    const model = opts.model ? await models.resolve(opts.model) : models.resolveDefault();

    // Step 1 — create the supports/ file from lib/supports/template.json.
    const langIdent = name.charAt(0).toUpperCase() + name.slice(1);
    const jsPath = languages.jsSupportPathFor(name);
    const content = loadSupportTemplate({ LANG: langIdent, EXT: name, LANG_LABEL: langIdent });
    fs.mkdirSync(path.dirname(jsPath), { recursive: true });
    fs.writeFileSync(jsPath, content);
    const rel = home.relPath(jsPath);
    console.log(`✓ scaffolded language support: ${rel}`);

    // Step 2 — open it in the editor for review.
    console.log('\nOpening the scaffold in your editor — review the TODO stubs...');
    const child = ide.spawnEditor(jsPath);
    if (child) await ide.awaitChild(child);

    // Step 3 — one-shot opencode implement of the parser stubs.
    const instruction = `You are implementing a language-support module for rarebert.

The file ${rel} was scaffolded with TODO stubs for four analysis functions.
Implement each one for ${langIdent} (.${name}):

1. ${langIdent}ParseImports(content) — parse ${langIdent} import statements and
   return notated strings using the notation documented in the file header
   (a::mod named, a<-mod aliased/default, mod bare).
2. ${langIdent}ExtractMainFunction(content) — locate the main entry function
   body; return { startLine, endLine, bodyLines } (1-indexed) or null.
3. ${langIdent}ExtractPublicMembers(content) — exported top-level members as
   { name, kind, startLine, endLine, lines }[].
4. ${langIdent}ExtractBindings(content) — { exports, imports } binding map.

Reference implementations: lib/supports/langmjs.js, langjs.js, langpy.js.
The Language contract lives in lib/languages.mjs.

Edit only ${rel}. Keep the Template lines/sections and the Language export
intact. The module must import { Language } from '../languages.mjs' and
{ Template } from '../template.mjs' and default-export a Language instance.`;

    console.log(`\nOne-shot opencode implement (model: ${model || 'default'})...`);
    const { status, stdout } = ide.spawnHeadless(instruction, model, { cwd: rarebert.root });
    if (stdout) console.log(stdout);
    if (status !== 0) console.error(`opencode run exited with status ${status}`);

    // Step 4 — validate (the "tests").
    let report = await validateLanguageSupport(name, rel);
    console.log(`\n${report.summary}`);

    // Step 5 — interactive opencode session to correct/amend until it passes.
    if (!report.ok) {
        console.log(
            `\nOpening an interactive opencode session — amend ${rel} until the validation passes.`
        );
        const amend = ide.spawnTui(model, { cwd: rarebert.root });
        if (amend.child) await ide.awaitChild(amend.child);
        report = await validateLanguageSupport(name, rel);
        console.log(`\n${report.summary}`);
    }

    console.log(
        report.ok
            ? `\n✓ language support "${name}" passes validation.`
            : `\n✗ language support "${name}" still fails validation — see ${rel}.`
    );
    return exit(report.ok ? 0 : 1);
}

export default new CLI(
    'add.mjs',
    async (opts, positional) => {
        return exit(
            new TUI(
                'add.mjs',
                async (opts, positional) => {
                    // add --language "<lang>" → the language-support workflow
                    // (scaffold → editor → one-shot implement → interactive amend).
                    if (opts.language) return languageSupportWorkflow(opts.language, opts);

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
