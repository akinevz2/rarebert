import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbortError } from './core.ts';
import { Script } from './Script.ts';

// ---------------------------------------------------------------------------
// Project — filesystem view of a rarebert project.
//
// Two singletons:
//   home     = rarebert's own install prefix (computed from this file's URL,
//              cached) — used to locate rarebert's own resources.
//   rarebert = the developer's current project (process.cwd(), re-scanned)
//              — used for user-facing module discovery.
//
// Folder discovery is two-tier: the per-project SQLite registry first
// (onboarding; wired via attachStore to avoid a core.ts import cycle),
// filesystem scan fallback (heuristics).
// ---------------------------------------------------------------------------

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(MODULE_DIR, '../..');

const FOLDER_EXT_DEFAULTS: Record<string, string[]> = {
    lib: ['.ts', '.mjs', '.js'],
    scripts: ['.ts', '.mjs', '.js'],
    supports: ['.js'],
    src: ['.py', '.ts', '.mjs', '.js'],
    docs: ['.md']
};

const FOLDER_LABELS: Record<string, string> = {
    lib: 'lib',
    scripts: 'scripts',
    supports: 'supports',
    src: 'src',
    docs: 'docs'
};

const NESTED_FOLDERS: Array<{ parent: string; name: string }> = [
    { parent: 'lib', name: 'supports' }
];

const IGNORED_FOLDERS = new Set([
    'node_modules', 'dist', 'build', '.git', '.opencode',
    'report', 'out', 'coverage', 'tmp', 'temp', 'vendor'
]);

const DEFAULT_EXTS = ['.ts', '.mjs', '.js'];

/** Constructor payload for a ProjectFolder. */
export interface ProjectFolderInit {
    key: string;
    rel: string;
    dir: string;
    label?: string;
    exts?: string[];
}

/** A discovered module file: `{ name, path }` with a root-relative path. */
export interface ModuleDescriptor {
    name: string;
    path: string;
}

/** The subset of the SQLite store this module needs for registry-backed discovery. */
export interface FolderStore {
    getFoldersForPath(absPath: string): Array<{
        key: string;
        rel: string;
        exts?: string[] | string;
        label?: string | null;
    }>;
}

/** Pure data class: one discovered project folder. */
export class ProjectFolder {
    /** Folder key used for lookups (e.g. 'scripts', 'lib'). */
    key: string;
    /** Root-relative folder path (e.g. 'scripts', 'lib/supports'). */
    rel: string;
    /** Absolute path of the folder. */
    dir: string;
    /** Human-readable label rendered in listings. */
    label: string;
    /** File extensions considered when indexing this folder. */
    exts: string[];

    constructor({ key, rel, dir, label, exts }: ProjectFolderInit) {
        this.key = key;
        this.rel = rel;
        this.dir = dir;
        this.label = label ?? `${rel}/  (auto)`;
        this.exts = exts ?? DEFAULT_EXTS;
    }
}

// Optional SQLite-store hook — injected at composition-root time (launch)
// to avoid the projects → core import cycle. Defaults to null, in which
// case discovery falls back to the filesystem scan.
let theStore: FolderStore | null = null;

/** Inject the SQLite store (core.ts `store` singleton) for registry-backed discovery. */
export function attachStore(store: FolderStore | null): void {
    theStore = store;
}

/** Root project — user code (cwd) or install prefix (home). */
export class Project {
    /** Absolute path of the project root. */
    root: string;
    /** Whether the folder list is cached (the `home` singleton). */
    _cached: boolean;
    /** Cached folder list when `_cached` is true. */
    _foldersCache: ProjectFolder[] | null;

    constructor(root: string, { cached = false }: { cached?: boolean } = {}) {
        this.root = root;
        this._cached = cached;
        this._foldersCache = cached ? this._scanFolders() : null;
    }

    _scanFolders(): ProjectFolder[] {
        const rootFolder = new ProjectFolder({
            key: 'root',
            rel: '.',
            dir: this.root,
            label: './  (project root)',
            exts: DEFAULT_EXTS
        });

        // Registry first: the per-project onboarding DB. Missing/unavailable
        // store falls through to the heuristic filesystem scan.
        try {
            const rows = theStore ? theStore.getFoldersForPath(this.root) : [];
            if (rows.length > 0) return this._foldersFromRegistered(rows, rootFolder);
        } catch {
            /* store unavailable — scan */
        }

        // Filesystem scan: root pseudo-folder + top-level non-hidden dirs.
        try {
            if (!fs.statSync(this.root).isDirectory()) return [rootFolder];
        } catch {
            return [rootFolder];
        }

        const folders = [rootFolder];
        for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
            if (
                entry.isDirectory() &&
                !entry.name.startsWith('.') &&
                !IGNORED_FOLDERS.has(entry.name)
            ) {
                folders.push(this._makeFolder(entry.name, entry.name));
            }
        }

        for (const { parent, name } of NESTED_FOLDERS) {
            const parentFolder = folders.find((f) => f.key === parent);
            if (!parentFolder) continue;
            const nestedRel = `${parent}/${name}`;
            const nestedDir = path.join(this.root, nestedRel);
            try {
                if (fs.statSync(nestedDir).isDirectory()) {
                    folders.push(
                        new ProjectFolder({
                            key: name,
                            rel: nestedRel,
                            dir: nestedDir,
                            label: FOLDER_LABELS[name] ?? `${name}/  (auto)`,
                            exts: FOLDER_EXT_DEFAULTS[name] ?? DEFAULT_EXTS
                        })
                    );
                }
            } catch {
                /* nested folder absent */
            }
        }

        return folders;
    }

    _foldersFromRegistered(rows: Array<{ key: string; rel: string; exts?: string[] | string; label?: string | null; }>, rootFolder: ProjectFolder): ProjectFolder[] {
        return [
            rootFolder,
            ...rows.map(
                (r) =>
                    new ProjectFolder({
                        key: r.key,
                        rel: r.rel,
                        dir: path.join(this.root, r.rel),
                        label: r.label ?? `${r.rel}/  (registered)`,
                        exts: Array.isArray(r.exts) ? r.exts : DEFAULT_EXTS
                    })
            )
        ];
    }

    _makeFolder(name: string, rel: string): ProjectFolder {
        return new ProjectFolder({
            key: name,
            rel,
            dir: path.join(this.root, rel),
            label: FOLDER_LABELS[name] ?? `${name}/  (auto)`,
            exts: FOLDER_EXT_DEFAULTS[name] ?? DEFAULT_EXTS
        });
    }

    /**
     * The constituent project folders that modules live in. Each descriptor
     * is `{ key, rel, dir, label, exts }` where `dir` is the absolute folder
     * path and `rel` its root-relative path. These folders are the interface
     * to Module construction.
     *
     * For external projects (`rarebert`), this is lazily evaluated on
     * every call so onboarding changes are visible without a reload.
     * For `home` (rarebert's install), folders are cached at construction.
     */
    discover(): ProjectFolder[] {
        if (this._cached) return this._foldersCache ?? [];
        try {
            const registered = theStore?.getFoldersForPath?.(this.root) ?? [];
            if (registered.length > 0) {
                return this._foldersFromRegistered(registered, this._rootFolder());
            }
        } catch {
            /* store unavailable — scan */
        }
        return this._scanFolders();
    }

    _rootFolder(): ProjectFolder {
        return new ProjectFolder({
            key: 'root',
            rel: '.',
            dir: this.root,
            label: './  (project root)',
            exts: DEFAULT_EXTS
        });
    }

    /**
     * Redirect this Project to a new root path. Used by `--core` to point
     * the `rarebert` singleton at the install prefix (home.root) so the
     * dispatcher operates against rarebert's own modules rather than the
     * current working directory.
     */
    redirect(root: string): this {
        this.root = root;
        if (this._cached) {
            this._cached = false;
            this._foldersCache = null;
        }
        return this;
    }

    /** Convenience getters backed by the discovered folders. */
    get scriptsDir(): string {
        return this.projectByKey('scripts')?.dir ?? path.join(this.root, 'scripts');
    }

    get libDir(): string {
        return this.projectByKey('lib')?.dir ?? path.join(this.root, 'lib');
    }

    get srcDir(): string {
        return this.projectByKey('src')?.dir ?? path.join(this.root, 'src');
    }

    get supportsDir(): string {
        return this.projectByKey('supports')?.dir ?? path.join(this.root, 'lib', 'supports');
    }

    projectByKey(key: string): ProjectFolder | null {
        return this.discover().find((p) => p.key === key) || null;
    }

    /**
     * Enumerate module files in `dir`. When `exts` is provided it overrides
     * the folder's default extension list; otherwise the folder's `exts`
     * are used (falling back to ['.ts', '.mjs', '.js']). Pass `{ all: true }` to
     * index every regular file regardless of extension — used by memo
     * indexing where any file in a tracked folder may receive a sidecar.
     * Returns an array of { name, path } with root-relative `path`.
     */
    discoverModules(
        dir?: string | null,
        exts?: string[],
        options: { all?: boolean } = {}
    ): ModuleDescriptor[] {
        // No dir: default to the scripts folder (runnable modules).
        if (dir === undefined || dir === null) {
            const scriptsFolder = this.projectByKey('scripts');
            if (scriptsFolder) return this.discoverModules(scriptsFolder.dir, scriptsFolder.exts, options);
            return [];
        }
        const folder = this.discover().find((p) => p.dir === dir);
        const effectiveExts = exts ?? folder?.exts ?? DEFAULT_EXTS;
        if (!fs.existsSync(dir)) return [];
        const { all = false } = options;
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile() && (all || effectiveExts.some((ext) => e.name.endsWith(ext))))
            .map((e) => {
                const rel = path.relative(this.root, path.join(dir, e.name));
                return { name: path.basename(rel, path.extname(rel)), path: rel };
            });
    }

    /**
     * Resolve a scripts/ module reference by name or path.
     * Returns a whole `Script` object, or null when unresolvable.
     * Path references always resolve (the file may not exist yet — the
     * import step reports that); name references must match a discovered
     * module.
     */
    resolveModuleRef(ref: string): Script | null {
        const scripts = this.discoverModules();
        const isPathRef = ref.includes('/') || ref.includes(path.sep) || ref.startsWith('./');

        if (isPathRef) {
            const rel = this.relPath(path.resolve(this.root, ref));
            const found = scripts.find((s) => s.path === rel || s.path === ref);
            return found
                ? new Script(found.name, found.path, this.root)
                : new Script(path.basename(ref, path.extname(ref)), rel, this.root);
        }

        const name = this.normalizeModuleName(ref);
        const found = scripts.find((s) => this.normalizeModuleName(s.name) === name);
        return found ? new Script(found.name, found.path, this.root) : null;
    }

    absPath(rel: string): string {
        return path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    }

    relPath(abs: string): string {
        return path.relative(this.root, abs);
    }

    readDirectoryFlag(args: string[] = []): string | null {
        if (args.includes('--lib')) return 'lib';
        if (args.includes('--src')) return 'src';
        if (args.includes('--supports')) return 'supports';
        if (args.includes('--scripts') || args.includes('--script')) return 'scripts';
        return null;
    }

    async promptDirectory(defaultDirectory = 'scripts'): Promise<string> {
        if (process.stdin.isTTY !== true) {
            console.log(`Non-interactive; defaulting directory to ${defaultDirectory}.`);
            return defaultDirectory;
        }

        const { default: Enquirer } = await import('enquirer');
        const prompt = new (Enquirer as unknown as {
            Select: new (opts: Record<string, unknown>) => { run(): Promise<string> };
        }).Select({
            name: 'directory',
            initial: defaultDirectory,
            choices: this.discover().map((p) => ({ name: p.key, message: p.label }))
        });

        try {
            return await prompt.run();
        } catch {
            throw new AbortError();
        }
    }

    async resolveDirectory(args: string[] = [], defaultDirectory = 'scripts'): Promise<string> {
        return this.readDirectoryFlag(args) ?? (await this.promptDirectory(defaultDirectory));
    }

    normalizeModuleName(rawName: string, extensions = ['.ts', '.js', '.mjs', '.py']): string {
        const name = rawName.trim();
        for (const ext of extensions) {
            if (name.endsWith(ext)) return name.slice(0, -ext.length);
        }
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
            throw new Error(
                'Invalid module name: must start with letter/underscore and contain only letters, numbers, underscores, or hyphens'
            );
        }
        return name;
    }

    /**
     * Best-effort regex scrape of a module's metadata without importing it:
     * .py → first line of the docstring; else `export default ({ ... })`'s
     * `name:` and `description:` string-literal values. Returns {} on failure.
     */
    getScriptMetadata(scriptPath: string): Record<string, string> {
        const abs = path.isAbsolute(scriptPath) ? scriptPath : this.absPath(scriptPath);
        let content;
        try {
            content = fs.readFileSync(abs, 'utf-8');
        } catch {
            return {};
        }
        try {
            if (abs.endsWith('.py')) {
                const docMatch = content.match(/"""([\s\S]*?)"""/);
                if (docMatch) {
                    return { description: docMatch[1].split('\n')[0].trim() };
                }
                return {};
            }
            const defaultMatch = content.match(/export\s+default\s+\(?\{([\s\S]*?)\}\)?\s*;/);
            if (defaultMatch) {
                const block = defaultMatch[1];
                const collapse = (s: string | null | undefined) =>
                    (s ?? '').replace(/\s+/g, ' ').trim();
                const name = block.match(/\bname\s*:\s*(['"`])([\s\S]*?)\1/);
                const description = block.match(/\bdescription\s*:\s*(['"`])([\s\S]*?)\1/);
                return {
                    ...(name ? { name: collapse(name[2]) } : {}),
                    ...(description ? { description: collapse(description[2]) } : {})
                };
            }
        } catch {
            /* scraping is best-effort */
        }
        return {};
    }

    /** List one folder's modules to stdout (path padded + first description line). */
    listOne(project: ProjectFolder): void {
        const modules = this.discoverModules(project.dir, project.exts);
        for (const m of modules) {
            const meta = this.getScriptMetadata(m.path);
            const desc = meta.description ? meta.description.split('\n')[0] : '';
            console.log(`${m.path.padEnd(24)}${desc}`);
        }
    }

    /** List modules, scoped by directory flags when present. */
    async listModules(args: string[] = []): Promise<void> {
        const directoryFlag = this.readDirectoryFlag(args);
        if (directoryFlag) {
            const project = this.projectByKey(directoryFlag);
            if (project) {
                this.listOne(project);
                return;
            }
        }
        for (const project of this.discover()) {
            console.log(project.label ?? project.rel);
            this.listOne(project);
            console.log('');
        }
    }
}

export const home = new Project(ROOT, { cached: true });
export const rarebert = new Project(process.cwd());
export const current = rarebert; // legacy alias
export default Project;
