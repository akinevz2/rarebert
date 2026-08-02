import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, SCRIPTS_DIR, LIB_DIR, writeFile, fileExists } from './core.mjs';
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

function libImportPath(placement) {
    return placement === 'lib' ? './core.mjs' : '../lib/core.mjs';
}

function libPeerImports(libDir, placement, ext = '.mjs', excludeName = null, includeLibs = null) {
    let peers = findLibraries(libDir, ext).filter(l => l !== excludeName);
    if (includeLibs !== null) {
        peers = peers.filter(l => includeLibs.includes(l));
    }
    const prefix = placement === 'lib' ? './' : '../lib/';
    return peers.map(lib => `import * as ${lib} from '${prefix}${lib}${ext}';`).join('\n');
}

export function createJsCoreLib(libDir = LIB_DIR, moduleName = 'core') {
    const libPath = path.join(libDir, `${moduleName}.mjs`);
    if (!fileExists(libPath)) {
        writeFile(libPath, `// Shared utilities for ${moduleName}\n// Add shared functions here for use by other modules\n`);
    }
    return libPath;
}

export function generateBoilerplate(placement, moduleName, ext = '.mjs', libDir = LIB_DIR, includeLibs = null) {
    const coreImport = libImportPath(placement);
    const excludeName = placement === 'lib' ? moduleName : null;
    const libImports = libPeerImports(libDir, placement, ext, excludeName, includeLibs);
    const lines = template.resolve(ext, {
        MODULE_NAME: moduleName,
        CORE_IMPORT: coreImport,

        LIB_IMPORTS: libImports
    });
    return lines.join('\n');
}

export function createJsModule(modulesDir, libDir, moduleName, ext, placement, includeLibs = null, overwrite = false) {
    const modulePath = path.join(modulesDir, `${moduleName}${ext}`);

    if (fileExists(modulePath) && !overwrite) {
        throw new Error(`${moduleName}${ext} already exists`);
    }

    fs.mkdirSync(modulesDir, { recursive: true });
    createJsCoreLib(libDir);

    const skeleton = generateBoilerplate(placement, moduleName, ext, libDir, includeLibs);
    writeFile(modulePath, skeleton);

    return modulePath;
}

export function manageLibraries(libDir = LIB_DIR) {
    if (!fs.existsSync(libDir)) {
        createJsCoreLib(libDir);
        console.error(`✓ Created lib/ directory with core.mjs`);
    }
}

export function dirForPlacement(placement) {
    return placement === 'lib' ? LIB_DIR : SCRIPTS_DIR;
}

export function relPath(absPath) {
    return path.relative(PROJECT_ROOT, absPath);
}

export default {
    getExtension,
    findLibraries,
    createJsCoreLib,
    generateBoilerplate,
    createJsModule,
    manageLibraries,
    dirForPlacement,
    relPath
};