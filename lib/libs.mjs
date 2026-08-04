import fs from 'fs';
import path from 'path';
import { rarebert } from './projects.mjs';
import { template } from './template.mjs';
import { languages } from './languages.mjs';

class Libs {
    constructor() {
        this.project = rarebert;
        this.root = rarebert.root;
        this.scriptsDir = rarebert.scriptsDir;
        this.srcDir = rarebert.srcDir;
        this.libDir = rarebert.libDir;
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

    libImportPath(directory) {
        return directory === 'lib' ? './core.mjs' : '../lib/core.mjs';
    }

    libPeerImports(libDir, directory, ext = '.mjs', excludeName = null) {
        const frameworkPeers = this.findLibraries(libDir, ext).filter((l) => l !== excludeName);
        const prefix = directory === 'lib' ? './' : '../lib/';
        const frameworkImports = frameworkPeers
            .map((lib) => `import * as ${lib} from '${prefix}${lib}${ext}';`)
            .join('\n');

        const projectLang = ext.replace(/^\./, '');
        const projectPeers = this.findProjectLibs(projectLang).filter((l) => l !== excludeName);
        if (projectPeers.length === 0) return frameworkImports;

        const projectPrefix = directory === 'lib' ? `./${projectLang}/` : `../lib/${projectLang}/`;
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

    generateBoilerplate(directory, moduleName, ext = '.mjs', libDir = this.libDir) {
        const coreImport = this.libImportPath(directory);
        const excludeName = directory === 'lib' ? moduleName : null;
        const libImports = this.libPeerImports(libDir, directory, ext, excludeName);
        return template
            .resolve(ext, {
                MODULE_NAME: moduleName,
                CORE_IMPORT: coreImport,
                LIB_IMPORTS: libImports
            })
            .join('\n');
    }

    createModule(directory, moduleName, ext = '.mjs') {
        const modulesDir = directory === 'lib' ? this.libDir : this.scriptsDir;
        const modulePath = path.join(modulesDir, `${moduleName}${ext}`);
        if (fs.existsSync(modulePath)) {
            throw new Error(`${moduleName}${ext} already exists`);
        }
        if (directory === 'lib') this.ensureCoreLib(this.libDir);
        else if (!fs.existsSync(this.libDir)) {
            this.ensureCoreLib(this.libDir);
            console.log(`✓ Created lib/ directory with core.mjs`);
        }
        fs.mkdirSync(modulesDir, { recursive: true });
        fs.writeFileSync(modulePath, this.generateBoilerplate(directory, moduleName, ext));
        return modulePath;
    }

    dirForDirectory(directory) {
        if (directory === 'lib') return this.libDir;
        if (directory === 'src') return this.srcDir;
        return this.scriptsDir;
    }

    relPath(absPath) {
        return path.relative(this.root, absPath);
    }
}

const libs = new Libs();
export { Libs, libs };
export default libs;
