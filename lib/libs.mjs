import fs from 'fs';
import path from 'path';
import { current } from './projects.mjs';
import { languages } from './languages.mjs';

class Libs {
    constructor() {
        this.project = current;
        this.root = current.root;
        this.scriptsDir = current.scriptsDir;
        this.srcDir = current.srcDir;
        this.libDir = current.libDir;
        this.supportsDir = current.supportsDir;
    }

    getExtension(name) {
        const ext = path.extname(name).toLowerCase();
        return languages.isSupported(ext) ? ext : '.mjs';
    }

    projectLibDir(lang) {
        return path.join(this.libDir, lang);
    }

    findLibraries(libDir = this.libDir, ext = '.mjs') {
        if (!fs.existsSync(libDir)) return [];
        return fs
            .readdirSync(libDir)
            .filter((f) => f.endsWith(ext) && f !== `core${ext}`)
            .map((f) => f.replace(ext, ''));
    }

    findProjectLibs(lang) {
        const dir = this.projectLibDir(lang);
        const ext = `.${lang}`;
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(ext) && f !== `core${ext}` && f !== '__init__.py')
            .map((f) => f.replace(ext, ''));
    }

    findAllProjectLibs() {
        const result = [];
        for (const lang of languages.list()) {
            for (const name of this.findProjectLibs(lang)) {
                result.push({ name, lang, ext: `.${lang}`, dir: this.projectLibDir(lang) });
            }
        }
        return result;
    }

    /**
     * Relative import prefix for a constituent project rel path
     * (e.g. 'scripts', 'lib', '.', 'lib/supports'), pointing at lib/.
     */
    importPrefixFor(rel) {
        if (rel === '.' || rel === '') return './lib/';
        if (rel === 'lib') return './';
        if (rel === 'lib/supports') return '../';
        return '../lib/';
    }

    libImportPath(rel) {
        return `${this.importPrefixFor(rel)}core.mjs`;
    }

    libPeerImports(libDir, rel, ext = '.mjs', excludeName = null) {
        const frameworkPeers = this.findLibraries(libDir, ext).filter((l) => l !== excludeName);
        const prefix = this.importPrefixFor(rel);
        const frameworkImports = frameworkPeers
            .map((lib) => `import * as ${lib} from '${prefix}${lib}${ext}';`)
            .join('\n');

        const projectLang = ext.replace(/^\./, '');
        const projectPeers = this.findProjectLibs(projectLang).filter((l) => l !== excludeName);
        if (projectPeers.length === 0) return frameworkImports;

        const projectPrefix = `${prefix}${projectLang}/`;
        const projectImports = projectPeers
            .map((lib) => `import * as ${lib} from '${projectPrefix}${lib}${ext}';`)
            .join('\n');
        return frameworkImports ? `${frameworkImports}\n${projectImports}` : projectImports;
    }

    ensureCoreLib(libDir = this.libDir, moduleName = 'core') {
        const libPath = path.join(libDir, `${moduleName}.mjs`);
        if (!fs.existsSync(libPath)) {
            const header = `// Shared utilities for ${moduleName}\n// Add shared functions here for use by other modules\n`;
            fs.mkdirSync(libDir, { recursive: true });
            fs.writeFileSync(libPath, header);
        }
        return libPath;
    }

    ensureProjectLibDir(lang) {
        const dir = this.projectLibDir(lang);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            if (lang === 'py') {
                const initPath = path.join(dir, '__init__.py');
                if (!fs.existsSync(initPath)) fs.writeFileSync(initPath, '');
                const libInit = path.join(this.libDir, '__init__.py');
                if (!fs.existsSync(libInit)) fs.writeFileSync(libInit, '');
            }
        }
        return dir;
    }

    async generateBoilerplate(rel, moduleName, ext = '.mjs', libDir = this.libDir) {
        const coreImport = this.libImportPath(rel);
        const cliImport = `${this.importPrefixFor(rel)}module.mjs`;
        const excludeName = rel === 'lib' ? moduleName : null;
        const libImports = this.libPeerImports(libDir, rel, ext, excludeName);
        return (
            await languages.resolveTemplate(ext, {
                MODULE_NAME: moduleName,
                CORE_IMPORT: coreImport,
                CLI_IMPORT: cliImport,
                LIB_IMPORTS: libImports
            })
        ).join('\n');
    }

    /**
     * Create a new module file inside the constituent folder identified by
     * `directory` (a key like 'scripts'/'lib' or a rel path like
     * 'lib/supports'/'.'). Returns the absolute path of the new file.
     */
    async createModule(directory, moduleName, ext = '.mjs') {
        const project =
            current.discover().find((p) => p.key === directory || p.rel === directory) || null;
        const rel = project ? project.rel : 'scripts';
        const modulesDir = project ? project.dir : this.scriptsDir;
        const modulePath = path.join(modulesDir, `${moduleName}${ext}`);
        if (fs.existsSync(modulePath)) {
            throw new Error(`${moduleName}${ext} already exists`);
        }
        if (rel === 'lib') this.ensureCoreLib(this.libDir);
        else if (!fs.existsSync(this.libDir)) {
            this.ensureCoreLib(this.libDir);
            console.log(`✓ Created lib/ directory with core.mjs`);
        }
        fs.mkdirSync(modulesDir, { recursive: true });
        fs.writeFileSync(modulePath, await this.generateBoilerplate(rel, moduleName, ext));
        return modulePath;
    }

    dirForDirectory(directory) {
        const project =
            current.discover().find((p) => p.key === directory || p.rel === directory) || null;
        return project ? project.dir : directory;
    }

    relPath(absPath) {
        return path.relative(this.root, absPath);
    }
}

const libs = new Libs();
export { Libs, libs };
export default libs;
