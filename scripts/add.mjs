#!/usr/bin/env node

import Enquirer from 'enquirer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT, LIB_DIR, normalizeModuleName, writeFile, fileExists } from '../lib/core.mjs';
import * as template from '../lib/template.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
const JS_MODULES_DIR = SCRIPTS_DIR;
const EXTENSIONS = ['.js', '.mjs', '.py'];

function getExtension(name) {
    const ext = path.extname(name).toLowerCase();
    return EXTENSIONS.includes(ext) ? ext : '.mjs';
}

function findLibraries(libDir, ext = '.mjs') {
    if (!fs.existsSync(libDir)) return [];
    return fs.readdirSync(libDir).filter(f => f.endsWith(ext)).map(f => f.replace(ext, ''));
}

function createJsSkeletonTemplate(moduleName, libraries, ext = '.mjs') {
    const libImports = libraries.length > 0
        ? libraries.map(lib => `import * as ${lib} from '../lib/${lib}${ext}';`).join('\n')
        : '';
    const lines = template.resolve(ext, {
        MODULE_NAME: moduleName,
        LIB_IMPORTS: libImports
    });
    return lines.join('\n');
}

function createJsCoreLib(libDir, moduleName = 'core') {
    const libPath = path.join(libDir, `${moduleName}.mjs`);
    if (!fileExists(libPath)) {
        writeFile(libPath, `// Shared utilities for ${moduleName}\n// Add shared functions here for use by other modules\n`);
    }
    return libPath;
}

function createJsModule(modulesDir, libDir, moduleName, ext) {
    const modulePath = path.join(modulesDir, `${moduleName}${ext}`);

    if (fileExists(modulePath)) {
        throw new Error(`${moduleName}${ext} already exists`);
    }

    fs.mkdirSync(modulesDir, { recursive: true });
    createJsCoreLib(libDir);

    const libraries = findLibraries(libDir, '.mjs').filter(l => l !== 'core');
    const skeleton = createJsSkeletonTemplate(moduleName, libraries, ext);
    writeFile(modulePath, skeleton);

    return modulePath;
}

function manageLibraries(libDir) {
    if (!fs.existsSync(libDir)) {
        createJsCoreLib(libDir);
        console.error(`✓ Created lib/ directory with core.mjs`);
    }
}

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
    const modulesDir = JS_MODULES_DIR;

    if (ext === '.py') {
        console.error('Python modules not yet supported in this refactor. Use .js or .mjs extension.');
        process.exit(1);
    }

    try {
        manageLibraries(LIB_DIR);

        console.error('\nGenerating module skeleton...');
        const modulePath = createJsModule(modulesDir, LIB_DIR, normalizedName, ext);
        const relPath = path.relative(PROJECT_ROOT, modulePath);

        console.error(`\n✓ Created module: ${relPath}`);
        console.error('\n--- Boilerplate Instructions ---');
        const libraries = findLibraries(LIB_DIR, '.mjs');
        if (libraries.length > 0) {
            libraries.forEach(lib => {
                console.error(`- Shared library: lib/${lib}.mjs`);
            });
        } else {
            console.error('- No shared utilities yet (core.mjs created in lib/)');
        }
        console.error('- Import shared utilities from ../lib/core.mjs as needed');
        console.error('- Implement the main() function with your logic');
        console.error('-------------------------------');

        fs.writeFileSync(path.join(PROJECT_ROOT, '.last-module'), relPath);
        console.log(relPath);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export {
    createJsSkeletonTemplate,
    createJsModule,
    createJsCoreLib,
    findLibraries,
    getExtension,
    main
};

export default {
    name: 'add',
    description: 'Scaffold a new rarebert module (.js/.mjs) and print its path',
    main
};