#!/usr/bin/env node

import { cli, CLI, AbortError } from '../lib/module.mjs';
import { editor } from '../lib/editor.mjs';
import { models } from '../lib/models.mjs';
import { exit } from '../lib/core.mjs';
import { runHeadless, runInteractive } from '../lib/implement.mjs';
import { libs } from '../lib/libs.mjs';
import { ide } from '../lib/ide.mjs';
import { git } from '../lib/git.mjs';
import { current } from '../lib/projects.mjs';
import {
    projectChoices,
    pickLanguage,
    ensureLanguage,
    promptModuleName,
    scaffoldSrcModule
} from '../lib/add.mjs';

const meta = {
    name: 'implement',
    description:
        'Implement module file(s): scaffold a new module or implement an existing one. Non-interactive reads args as a file list and runs opencode headlessly; interactive runs a REPL that prompts for an instruction, runs opencode, then launches $EDITOR and a testing bash in parallel',
    usage: 'node index.js implement [file/dir ...] [model] [--new]',
    options: [{ flag: '--new', description: 'scaffold a new module before implementing' }]
};

export { meta };

async function scaffoldFlow() {
    console.log('\n=== Rarebert Module Creator ===\n');

    const proj = await cli.select('Select a project for the new module:', projectChoices(), {
        nonInteractiveBehavior: 'fail',
        initial: 0
    });

    const project = current.projectByKey(proj);

    let lang;
    let directory;
    if (project.key === 'src') {
        lang = await pickLanguage();
        directory = project.rel;
    } else {
        lang = 'mjs';
        directory = project.rel;
        await ensureLanguage(lang);
    }

    const ext = `.${lang}`;
    const name = await promptModuleName(lang);
    if (!name || !name.trim()) throw new AbortError();
    const normalizedName = current.normalizeModuleName(name, [ext]);

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

    const stageResult = git.add([], { all: true, stdio: 'inherit' });
    if (!stageResult.ok) console.error('implement: git add -A failed; continuing');

    const editorChild = ide.spawnEditor(modulePath);
    if (editorChild) {
        const editorExit = await ide.awaitChild(editorChild);
        if (editorExit !== 0) return exit(editorExit);
    }

    return { rel, modulePath };
}

export default new CLI('implement.mjs', async (opts, positional) => {
    const wantNew = opts.new || positional.includes('--new');

    if (!cli.isInteractive()) {
        const fileArgs = positional.filter((a) => !a.startsWith('-'));
        if (fileArgs.length === 0 && !wantNew) {
            console.error('Non-interactive: pass file or directory arguments to implement.');
            return exit(1);
        }
        if (wantNew) {
            console.error('Non-interactive: --new requires an interactive shell.');
            return exit(1);
        }
        const { entries, context } = await editor.resolveActiveFiles(fileArgs, {
            message: 'implement'
        });
        if (entries.length === 0) return exit(1);

        const model = await models.resolve(null);
        const fileLabel =
            entries.length === 1
                ? entries[0].rel
                : `${entries.length} files (${entries.map((e) => e.rel).join(', ')})`;
        const instruction = `Implement the module in ${fileLabel}.\n\n--- active files context ---\n${context}`;
        return runHeadless({ entries, context, model, instruction });
    }

    if (wantNew) {
        const scaffolded = await scaffoldFlow();
        if (scaffolded.exit !== undefined) return scaffolded;
        return runInteractive([scaffolded.rel]);
    }

    await runInteractive(positional);
}, meta).supportsDirectRunning(import.meta.url);