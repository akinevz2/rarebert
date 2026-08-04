#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { PROJECT_ROOT, normalizeModuleName } from '../lib/core.mjs';
import { relPath } from '../lib/libs.mjs';
import * as template from '../lib/template.mjs';
import { editFile, writeLastModule } from '../lib/editor.mjs';

const SRC_DIR = path.join(PROJECT_ROOT, 'src');

function listPythonLibs() {
    const libDir = path.join(PROJECT_ROOT, 'lib');
    if (!fs.existsSync(libDir)) return [];
    return fs.readdirSync(libDir)
        .filter(f => f.endsWith('.py') && f !== 'core.py')
        .map(f => f.replace(/\.py$/, ''));
}

async function promptLibraryImports(libs) {
    if (libs.length === 0) return [];
    if (process.stdin.isTTY !== true) return [];

    const choices = libs.map(lib => ({ name: lib, message: `lib/${lib}.py` }));

    const prompt = new Enquirer.MultiSelect({
        name: 'libraries',
        message: 'Select Python libraries from lib/ to add to the preamble:',
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
    const lines = selectedLibs.map(lib => `from lib import ${lib}`);
    return lines.join('\n');
}

function generatePythonBoilerplate(moduleName, selectedLibs) {
    return template.resolve('.py', {
        MODULE_NAME: moduleName,
        LIB_IMPORTS: buildPreamble(selectedLibs)
    }).join('\n');
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('create: Scaffold a new Python module in src/ and open it in $EDITOR');
        console.error('  Usage: node index.js create [module_name]');
        console.error('  Prompts for any lib/*.py libraries to add to the import preamble.');
        console.error('  Prints the created module path to stdout (last line).');
        return;
    }

    console.error('\n=== Rarebert Python Module Creator ===\n');

    const nameArg = args.find(a => !a.startsWith('-'));
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

    console.error('\nScanning lib/ for Python libraries...');
    const libs = listPythonLibs();
    if (libs.length > 0) {
        console.error(`Found ${libs.length} Python librar${libs.length === 1 ? 'y' : 'ies'}:`);
        libs.forEach(lib => console.error(`  - lib/${lib}.py`));
    } else {
        console.error('No Python libraries found in lib/.');
    }

    const selectedLibs = await promptLibraryImports(libs);

    try {
        console.error('\nGenerating Python module skeleton...');
        fs.mkdirSync(SRC_DIR, { recursive: true });
        const modulePath = path.join(SRC_DIR, `${normalizedName}.py`);
        if (fs.existsSync(modulePath)) {
            throw new Error(`${normalizedName}.py already exists`);
        }

        fs.writeFileSync(modulePath, generatePythonBoilerplate(normalizedName, selectedLibs));
        const rel = relPath(modulePath);

        console.error(`\n✓ Created module: ${rel}`);
        if (selectedLibs.length > 0) {
            console.error('  Preamble imports:');
            selectedLibs.forEach(lib => console.error(`    - from lib import ${lib}`));
        } else {
            console.error('  No library imports added to preamble.');
        }

        writeLastModule(rel);
        console.log(rel);

        console.error(`\nOpening ${rel} in $EDITOR...`);
        const child = editFile(modulePath);
        child.on('exit', code => {
            if (code !== 0) console.error(`Editor exited with code ${code}`);
        });
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main, listPythonLibs, promptLibraryImports, buildPreamble };

export default {
    name: 'create',
    description: 'Scaffold a Python module in src/ with optional lib/ preamble imports',
    main
};