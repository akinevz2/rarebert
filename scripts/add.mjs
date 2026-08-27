#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { CLI, tui, AbortError, TUI } from '../lib/module.mjs';
import { libs } from '../lib/libs.mjs';
import { editor } from '../lib/editor.mjs';
import { ide } from '../lib/ide.mjs';
import { git } from '../lib/git.mjs';
import { models } from '../lib/models.mjs';
import { rarebert } from '../lib/projects.mjs';
import { languages } from '../lib/languages.mjs';
import {
    projectChoices,
    ensureLanguage,
    promptModuleName,
    scaffoldSrcModule
} from '../lib/add.mjs';
import { store } from '../lib/core.mjs';

const meta = {
    name: 'add',
    description:
        'Scaffold a new module: pick project, pick language, then git add, edit, and run opencode headlessly to implement',
    usage: 'node index.js add [--model <id>] [--force] [--help]',
    options: [
        { flag: '-m, --model <id>', description: 'opencode model id (overrides the default from opencode.json)' },
        { flag: '--force', description: 'overwrite an installed language template' },
        { flag: '-h, --help', description: 'show exhaustive help listing of all sub-options' }
    ]
};

export { meta };

// REFACTOR: Exhaustive help listing of all sub-options
function showHelp() {
    console.log(`
=== Rarebert Module Creator Help ===

Usage: node index.js add [options]

Options:
  -m, --model <id>    opencode model id (overrides default from opencode.json)
  --force             overwrite an installed language template
  -h, --help          show exhaustive help listing of all sub-options

Sub-options:
  Projects:
    - src/            Create modules in the src/ directory
    - scripts/        Create CLI scripts in scripts/ directory
    - lib/            Create library modules in lib/ directory
    - [project]/      Any discovered project folder

  Languages:
    - mjs             JavaScript modules (default for non-src projects)
    - py              Python modules
    - js              JavaScript modules

  Default Onboarding:
    When run without arguments, shows a wizard to:
    1. Register the project with SQLite
    2. Configure filetype associations
    3. Set up Modelfile interaction

  Project Registration:
    Projects are registered via SQLite store for persistent choices.
    Run with --register to add a project to the registry.

  Modelfile Interaction:
    Reads Modelfile.refactor or Modelfile.server for model suggestions.
    Creates Ollama models from specifications when needed.

Examples:
  node index.js add                    # Interactive module creation
  node index.js add --model qwen3      # Use specific model
  node index.js add --help             # Show this help
  node index.js add --register myproj  # Register project
`);
}

// REFACTOR: Default onboarding when run without arguments
async function defaultOnboarding() {
    console.log('\n=== Rarebert Module Creator Onboarding ===\n');
    
    // Check if project is registered
    const projects = store.listProjects ? store.listProjects() : [];
    
    if (projects.length === 0) {
        console.log('No projects registered. Registering current project...\n');
        
        // Register the rarebert project itself
        const project = rarebert.projectByKey('rarebert');
        if (project) {
            console.log(`Project: ${project.key}`);
            console.log(`Path: ${project.rel}`);
            console.log(`Folders: ${project.folders ? project.folders.join(', ') : 'auto-discovered'}`);
            
            if (store.registerProject) {
                store.registerProject(project.root);
                console.log('\n✓ Project registered successfully');
            }
        }
    }
    
    // Show available filetypes
    console.log('\nAvailable filetypes for exploration:');
    const filetypes = ['mjs', 'js', 'py', 'ts'];
    filetypes.forEach(ft => console.log(`  - .${ft}`));
    
    console.log('\nReady to scaffold modules!');
}

export default new CLI('add.mjs', async (opts, positional) => {
    // REFACTOR: --help check for exhaustive help listing
    if (opts.help) {
        showHelp();
        return exit(0);
    }
    
    // REFACTOR: Default onboarding when run without arguments
    if (positional.length === 0 && Object.keys(opts).length <= 1) {
        await defaultOnboarding();
    }

    return exit(new TUI('add.mjs', async (o = opts, p = positional) => {
    console.log('\n=== Rarebert Module Creator ===\n');

    const proj = await tui.select('Select a project for the new module:', projectChoices(), {
        nonInteractiveBehavior: 'fail',
        initial: 0
    });

    const project = rarebert.projectByKey(proj);

    let lang;
    let directory;
    if (project.key === 'src') {
        lang = await languages.choose();
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
            const line = lang === 'py'
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
    if (!stageResult.ok) console.error('add: git add -A failed; continuing');

    const editorChild = ide.spawnEditor(modulePath);
    if (editorChild) {
        const editorExit = await ide.awaitChild(editorChild);
        if (editorExit !== 0) return exit(editorExit);
    }

    // REFACTOR: Modelfile interaction and Ollama model creation
    let model = opts.model ? await models.resolve(opts.model) : models.resolveDefault();
    
    // If no model found, try to create from Modelfile
    if (!model) {
        console.log('\nNo default model found. Checking Modelfile for model specification...');
        const modelfileModel = await models.fromModelfile();
        if (modelfileModel) {
            console.log(`Found model in Modelfile: ${modelfileModel}`);
            model = modelfileModel;
        }
    }

    const context = editor.loadContent(modulePath) || '';
    const instruction = [
        `Implement the module in ${rel}.`,
        '',
        '--- active files context ---',
        context
    ].filter((s) => s && s.trim()).join('\n');

    const { status: runStatus, stdout: out } = ide.spawnHeadless(instruction, model, { cwd: rarebert.root });
        return exit(runStatus ?? 0, () => {
            if (runStatus !== 0) console.error(`add: opencode run exited with status ${runStatus}`);
            if (out) console.log(out);
            console.log('\nNext: `make commit` if happy with the one-shot, or `make edit` then `make implement` to iterate.');
        });
    }, meta));
}, meta).supportsDirectRunning(import.meta.url);