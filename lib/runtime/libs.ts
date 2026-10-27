import fs from 'fs';
import path from 'path';
import { rarebert } from './Project.ts';
import type { Project } from './Project.ts';
import { languages } from './Language.ts';

/** A project library discovered under `lib/<lang>/`. */
export interface ProjectLib {
    name: string;
    lang: string;
    ext: string;
    dir: string;
}

class Libs {
    /** The current project (cwd-scoped). */
    project: Project;
    /** Absolute path of the project root. */
    root: string;
    /** Absolute path of the project's scripts folder. */
    scriptsDir: string;
    /** Absolute path of the project's src folder. */
    srcDir: string;
    /** Absolute path of the project's lib folder. */
    libDir: string;
    /** Absolute path of the project's supports folder. */
    supportsDir: string;

    constructor() {
        this.project = rarebert;
        this.root = rarebert.root;
        this.scriptsDir = rarebert.scriptsDir;
        this.srcDir = rarebert.srcDir;
        this.libDir = rarebert.libDir;
        this.supportsDir = rarebert.supportsDir;
    }

    getExtension(name: string): string {
        const ext = path.extname(name).toLowerCase();
        return languages.isSupported(ext) ? ext : '.ts';
    }

    projectLibDir(lang: string): string {
        return path.join(this.libDir, lang);
    }

    findLibraries(libDir: string = this.libDir, ext = '.ts'): string[] {
        if (!fs.existsSync(libDir)) return [];
        return fs
            .readdirSync(libDir)
            .filter((f) => f.endsWith(ext) && f !== `core${ext}`)
            .map((f) => f.replace(ext, ''));
    }

    findProjectLibs(lang: string): string[] {
        const dir = this.projectLibDir(lang);
        const ext = `.${lang}`;
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(ext) && f !== `core${ext}` && f !== '__init__.py')
            .map((f) => f.replace(ext, ''));
    }

    findAllProjectLibs(): ProjectLib[] {
        const result: ProjectLib[] = [];
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
    importPrefixFor(rel: string): string {
        if (rel === '.' || rel === '') return './lib/';
        if (rel === 'lib') return './';
        if (rel === 'lib/supports') return '../';
        return '../lib/';
    }

    libImportPath(rel: string): string {
        return `${this.importPrefixFor(rel)}core.ts`;
    }

    libPeerImports(
        libDir: string,
        rel: string,
        ext = '.ts',
        excludeName: string | null = null
    ): string {
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

    ensureCoreLib(libDir: string = this.libDir, moduleName = 'core'): string {
        const libPath = path.join(libDir, `${moduleName}.ts`);
        if (!fs.existsSync(libPath)) {
            const header = `// Shared utilities for ${moduleName}\n// Add shared functions here for use by other modules\n`;
            fs.mkdirSync(libDir, { recursive: true });
            fs.writeFileSync(libPath, header);
        }
        return libPath;
    }

    ensureProjectLibDir(lang: string): string {
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

    async generateBoilerplate(
        rel: string,
        moduleName: string,
        ext = '.ts',
        libDir: string = this.libDir
    ): Promise<string> {
        const coreImport = this.libImportPath(rel);
        const cliImport = `${this.importPrefixFor(rel)}runtime/Module.ts`;
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
    async createModule(directory: string, moduleName: string, ext = '.ts'): Promise<string> {
        const project =
            rarebert.discover().find((p) => p.key === directory || p.rel === directory) || null;
        const rel = project ? project.rel : 'scripts';
        const modulesDir = project ? project.dir : this.scriptsDir;
        const modulePath = path.join(modulesDir, `${moduleName}${ext}`);
        if (fs.existsSync(modulePath)) {
            throw new Error(`${moduleName}${ext} already exists`);
        }
        if (rel === 'lib') this.ensureCoreLib(this.libDir);
        else if (!fs.existsSync(this.libDir)) {
            this.ensureCoreLib(this.libDir);
            console.log(`✓ Created lib/ directory with core.ts`);
        }
        fs.mkdirSync(modulesDir, { recursive: true });
        fs.writeFileSync(modulePath, await this.generateBoilerplate(rel, moduleName, ext));
        return modulePath;
    }

    dirForDirectory(directory: string): string {
        const project =
            rarebert.discover().find((p) => p.key === directory || p.rel === directory) || null;
        return project ? project.dir : directory;
    }

    relPath(absPath: string): string {
        return path.relative(this.root, absPath);
    }
}

const libs = new Libs();
export { Libs, libs };
export default libs;
