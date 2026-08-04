import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, SCRIPTS_DIR, SRC_DIR, LIB_DIR } from './core.mjs';
import * as template from './template.mjs';

const EXTENSIONS = ['.js', '.mjs', '.py'];

export function getExtension(name) {
    const ext = path.extname(name).toLowerCase();
    return EXTENSIONS.includes(ext) ? ext : '.mjs';
}

export function findLibraries(libDir = LIB_DIR, ext = '.mjs') {
    if (!fs.existsSync(libDir)) return [];
    return fs.readdirSync(libDir)
        .filter(f => f.endsWith(ext) && f !== `core${ext}`)
        .map(f => f.replace(ext, ''));
}

function libImportPath(directory) {
    return directory === 'lib' ? './core.mjs' : '../lib/core.mjs';
}

function libPeerImports(libDir, directory, ext = '.mjs', excludeName = null) {
    let peers = findLibraries(libDir, ext).filter(l => l !== excludeName);
    const prefix = directory === 'lib' ? './' : '../lib/';
    return peers.map(lib => `import * as ${lib} from '${prefix}${lib}${ext}';`).join('\n');
}

function ensureCoreLib(libDir = LIB_DIR, moduleName = 'core') {
    const libPath = path.join(libDir, `${moduleName}.mjs`);
    if (!fs.existsSync(libPath)) {
        const header = `// Shared utilities for ${moduleName}\n// Add shared functions here for use by other modules\n`;
        fs.mkdirSync(libDir, { recursive: true });
        fs.writeFileSync(libPath, header);
    }
    return libPath;
}

function generateBoilerplate(directory, moduleName, ext = '.mjs', libDir = LIB_DIR) {
    const coreImport = libImportPath(directory);
    const excludeName = directory === 'lib' ? moduleName : null;
    const libImports = libPeerImports(libDir, directory, ext, excludeName);
    return template.resolve(ext, {
        MODULE_NAME: moduleName,
        CORE_IMPORT: coreImport,
        LIB_IMPORTS: libImports
    }).join('\n');
}

export function createModule(directory, moduleName, ext = '.mjs') {
    const modulesDir = directory === 'lib' ? LIB_DIR : SCRIPTS_DIR;
    const modulePath = path.join(modulesDir, `${moduleName}${ext}`);
    if (fs.existsSync(modulePath)) {
        throw new Error(`${moduleName}${ext} already exists`);
    }
    if (directory === 'lib') ensureCoreLib(LIB_DIR);
    else if (!fs.existsSync(LIB_DIR)) {
        ensureCoreLib(LIB_DIR);
        console.error(`✓ Created lib/ directory with core.mjs`);
    }
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.writeFileSync(modulePath, generateBoilerplate(directory, moduleName, ext));
    return modulePath;
}

export function dirForDirectory(directory) {
    if (directory === 'lib') return LIB_DIR;
    if (directory === 'src') return SRC_DIR;
    return SCRIPTS_DIR;
}

export function relPath(absPath) {
    return path.relative(PROJECT_ROOT, absPath);
}

export default { getExtension, findLibraries, createModule, dirForDirectory, relPath };