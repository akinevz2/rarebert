#!/usr/bin/env node

import path from 'path';
import Enquirer from 'enquirer';
import { normalizeModuleName } from '../lib/core.mjs';
import { getExtension, findLibraries, createModule, relPath } from '../lib/libs.mjs';
import { writeLastModule } from '../lib/editor.mjs';

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('add: Scaffold a new rarebert module (.js/.mjs)');
        console.error('  Usage: node index.js add');
        console.error('  Prints the created module path to stdout (last line)');
        return;
    }

    console.error('\n=== Rarebert Module Creator ===\n');

    const namePrompt = new Enquirer.Input({
        message: 'Enter the module name (supports .js, .mjs, .py extensions; defaults to .mjs):',
        validate: (input) => {
            if (!input.trim()) return 'Module name is required';
            try {
                normalizeModuleName(input);
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

    const ext = getExtension(name);
    const normalizedName = normalizeModuleName(name);

    if (ext === '.py') {
        console.error('Python modules not yet supported in this refactor. Use .js or .mjs extension.');
        process.exit(1);
    }

    try {
        console.error('\nGenerating module skeleton...');
        const modulePath = createModule('scripts', normalizedName, ext);
        const rel = relPath(modulePath);

        console.error(`\n✓ Created module: ${rel}`);
        console.error('\n--- Boilerplate Instructions ---');
        const libraries = findLibraries();
        if (libraries.length > 0) {
            libraries.forEach(lib => console.error(`- Shared library: lib/${lib}.mjs`));
        } else {
            console.error('- No shared utilities yet (core.mjs created in lib/)');
        }
        console.error('- Import shared utilities from ../lib/core.mjs as needed');
        console.error('- Implement the main() function with your logic');
        console.error('-------------------------------');

        writeLastModule(rel);
        console.log(rel);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { main };

export default {
    name: 'add',
    description: 'Scaffold a new rarebert module (.js/.mjs) and print its path',
    main
};