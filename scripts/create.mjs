#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { PROJECT_ROOT, normalizeModuleName } from '../lib/core.mjs';
import { relPath } from '../lib/libs.mjs';
import * as template from '../lib/template.mjs';
import { editFile, writeLastModule } from '../lib/editor.mjs';

const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const PY_LIB_DIR = path.join(PROJECT_ROOT, 'lib', 'py');

function listPythonLibs() {
    if (!fs.existsSync(PY_LIB_DIR)) return [];
    return fs
        .readdirSync(PY_LIB_DIR)
        .filter((f) => f.endsWith('.py') && f !== '__init__.py' && f !== 'core.py')
        .map((f) => f.replace(/\.py$/, ''));
}

async function promptLibraryImports(libs) {
    if (libs.length === 0) return [];
    if (process.stdin.isTTY !== true) return [];

    const choices = libs.map((lib) => ({ name: lib, message: `lib/py/${lib}.py` }));

    const prompt = new Enquirer.MultiSelect({
        name: 'libraries',
        message: 'Select Python libraries from lib/py/ to add to the preamble:',
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

function buildPreamble(selectedLibs) {
    if (selectedLibs.length === 0) return '';
    const lines = selectedLibs.map((lib) => `from lib.py import ${lib}`);
    return lines.join('\n');
}

function generatePythonBoilerplate(moduleName, selectedLibs) {
    return template
        .resolve('.py', {
            MODULE_NAME: moduleName,
            LIB_IMPORTS: buildPreamble(selectedLibs)
        })
        .join('\n');
}

async function main(args = []) {
    console.error('\n=== Rarebert Python Module Creator ===\n');

    const nameArg = args.find((a) => !a.startsWith('-'));
    let name = nameArg;

    if (!name) {
        if (process.stdin.isTTY !== true) {
            console.error('Non-interactive; pass a module name as an argument.');
            process.exit(1);
        }

        const namePrompt = new Enquirer.Input({
            message: 'Enter the module name (.py extension added automatically):',
            validate: (input) => {
                if (!input.trim()) return 'Module name is required';
                try {
                    normalizeModuleName(input.endsWith('.py') ? input : `${input}.py`);
                    return true;
                } catch (e) {
                    return e.message;
                }
            }
        });

        try {
            name = await namePrompt.run();
        } catch {
            console.error('\nAborted.');
            process.exit(130);
        }
    }

    if (!name || !name.trim()) {
        console.error('\nAborted.');
        process.exit(130);
    }

    const normalizedName = normalizeModuleName(name.endsWith('.py') ? name : `${name}.py`);

    console.error('\nScanning lib/py/ for Python libraries...');
    const libs = listPythonLibs();
    if (libs.length > 0) {
        console.error(`Found ${libs.length} Python librar${libs.length === 1 ? 'y' : 'ies'}:`);
        libs.forEach((lib) => console.error(`  - lib/py/${lib}.py`));
    } else {
        console.error('No Python libraries found in lib/py/.');
    }

    const selectedLibs = await promptLibraryImports(libs);

    console.error('\nGenerating Python module skeleton...');
    fs.mkdirSync(SRC_DIR, { recursive: true });
    const modulePath = path.join(SRC_DIR, `${normalizedName}.py`);
    if (fs.existsSync(modulePath)) {
        console.error(`Error: ${normalizedName}.py already exists`);
        process.exit(1);
    }

    fs.writeFileSync(modulePath, generatePythonBoilerplate(normalizedName, selectedLibs));
    const rel = relPath(modulePath);

    console.error(`\n✓ Created module: ${rel}`);
    if (selectedLibs.length > 0) {
        console.error('  Preamble imports:');
        selectedLibs.forEach((lib) => console.error(`    - from lib.py import ${lib}`));
    } else {
        console.error('  No library imports added to preamble.');
    }

    writeLastModule(rel);
    console.log(rel);

    console.error(`\nOpening ${rel} in $EDITOR...`);
    const child = editFile(modulePath);
    child.on('exit', (code) => {
        if (code !== 0) console.error(`Editor exited with code ${code}`);
    });
}

export { main, listPythonLibs, promptLibraryImports, buildPreamble };

export default {
    name: 'create',
    description: 'Scaffold a Python module in src/ with optional lib/ preamble imports',
    main
};
