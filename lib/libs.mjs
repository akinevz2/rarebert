import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, SCRIPTS_DIR, SRC_DIR, LIB_DIR } from './core.mjs';
import * as template from './template.mjs';
import { supportedExtensions, isSupported, listLanguages } from './languages.mjs';

export function getExtension(name) {
    const ext = path.extname(name).toLowerCase();
    return isSupported(ext) ? ext : '.mjs';
}

export function projectLibDir(lang) {
    return path.join(LIB_DIR, lang);
}

export function findLibraries(libDir = LIB_DIR, ext = '.mjs') {
    if (!fs.existsSync(libDir)) return [];
    return fs
        .readdirSync(libDir)
        .filter((f) => f.endsWith(ext) && f !== `core${ext}`)
        .map((f) => f.replace(ext, ''));
}

export function findProjectLibs(lang) {
    const dir = projectLibDir(lang);
    const ext = `.${lang}`;
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(ext) && f !== `core${ext}` && f !== '__init__.py')
        .map((f) => f.replace(ext, ''));
}

export function findAllProjectLibs() {
    const result = [];
    for (const lang of listLanguages()) {
        for (const name of findProjectLibs(lang)) {
            result.push({ name, lang, ext: `.${lang}`, dir: projectLibDir(lang) });
        }
    }
    return result;
}

function libImportPath(directory) {
    return directory === 'lib' ? './core.mjs' : '../lib/core.mjs';
}

function libPeerImports(libDir, directory, ext = '.mjs', excludeName = null) {
    const frameworkPeers = findLibraries(libDir, ext).filter((l) => l !== excludeName);
    const prefix = directory === 'lib' ? './' : '../lib/';
    const frameworkImports = frameworkPeers
        .map((lib) => `import * as ${lib} from '${prefix}${lib}${ext}';`)
        .join('\n');

    const projectLang = ext.replace(/^\./, '');
    const projectPeers = findProjectLibs(projectLang).filter((l) => l !== excludeName);
    if (projectPeers.length === 0) return frameworkImports;

    const projectPrefix = directory === 'lib' ? `./${projectLang}/` : `../lib/${projectLang}/`;
    const projectImports = projectPeers
        .map((lib) => `import * as ${lib} from '${projectPrefix}${lib}${ext}';`)
        .join('\n');
    return frameworkImports ? `${frameworkImports}\n${projectImports}` : projectImports;
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

function ensureProjectLibDir(lang) {
    const dir = projectLibDir(lang);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        if (lang === 'py') {
            const initPath = path.join(dir, '__init__.py');
            if (!fs.existsSync(initPath)) fs.writeFileSync(initPath, '');
            const libInit = path.join(LIB_DIR, '__init__.py');
            if (!fs.existsSync(libInit)) fs.writeFileSync(libInit, '');
        }
    }
    return dir;
}

function generateBoilerplate(directory, moduleName, ext = '.mjs', libDir = LIB_DIR) {
    const coreImport = libImportPath(directory);
    const excludeName = directory === 'lib' ? moduleName : null;
    const libImports = libPeerImports(libDir, directory, ext, excludeName);
    return template
        .resolve(ext, {
            MODULE_NAME: moduleName,
            CORE_IMPORT: coreImport,
            LIB_IMPORTS: libImports
        })
        .join('\n');
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

export default {
    getExtension,
    findLibraries,
    findProjectLibs,
    findAllProjectLibs,
    projectLibDir,
    createModule,
    dirForDirectory,
    relPath
};
