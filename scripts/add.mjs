#!/usr/bin/env node

import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { normalizeModuleName } from '../lib/core.mjs';
import { findLibraries, createModule, relPath } from '../lib/libs.mjs';
import { writeLastModule, editFile } from '../lib/editor.mjs';
import * as git from '../lib/git.mjs';
import { runIDE } from '../lib/ide.mjs';
import { resolveModel } from '../lib/models.mjs';
import { chooseLanguage } from './project.mjs';

async function main(args = []) {
    console.error('\n=== Rarebert Module Creator ===\n');

    const lang = await chooseLanguage();
    const ext = `.${lang}`;

    const namePrompt = new Enquirer.Input({
        message: `Enter the module name (.${lang} extension added automatically):`,
        validate: (input) => {
            if (!input.trim()) return 'Module name is required';
            try {
                normalizeModuleName(input, [ext]);
                return true;
            } catch (e) {
                return e.message;
            }
        }
    });

    let name;
    try {
        name = await namePrompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
    if (!name || !name.trim()) {
        console.error('\nAborted.');
        process.exit(130);
    }

    const normalizedName = normalizeModuleName(name, [ext]);

    if (ext === '.py') {
        console.error(
            'Python modules use `make create` (scripts/create.mjs) for proper preamble handling.'
        );
        process.exit(1);
    }

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const modelArg = nonFlag[0];

    console.error(`\nGenerating ${lang} module skeleton...`);
    const modulePath = createModule('scripts', normalizedName, ext);
    const rel = relPath(modulePath);

    console.error(`\n✓ Created module: ${rel}`);
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

    const model = await resolveModel(modelArg);
    const { status } = runIDE(model, rel, { implement: true });
    if (status && status !== 0) process.exit(status);
}

export { main };

export default {
    name: 'add',
    description:
        'Scaffold a new module, git add, edit in $EDITOR, then run opencode to implement it',
    main
};
