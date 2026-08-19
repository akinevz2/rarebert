import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Enquirer from 'enquirer';
import { store } from './core.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, '..');

/**
 * Default extension map — the first matching entry for a folder name wins.
 * Folders not listed here fall back to the generic JS/MJS defaults.
 */
const FOLDER_EXT_DEFAULTS = {
    lib: ['.mjs', '.js'],
    scripts: ['.mjs', '.js'],
    supports: ['.js'],
    src: ['.py', '.mjs', '.js'],
    docs: ['.md']
};

/**
 * Human-readable labels for known top-level folders. Unknown folders get
 * a generated label of the form `name/  (auto)`.
 */
const FOLDER_LABELS = {
    lib: 'lib/  (rarebert libraries)',
    scripts: 'scripts/  (rarebert core api)',
    supports: 'supports/  (rarebert language support)',
    src: 'src/  (rarebert projects)',
    docs: 'docs/  (documentation)'
};

/**
 * Special sub-folders to discover beneath top-level folders (currently only
 * `lib/supports`). Each entry is `{ parent, name }`.
 */
const NESTED_FOLDERS = [{ parent: 'lib', name: 'supports' }];

/**
 * Top-level folders to exclude from discovery (dependencies, build output, etc.).
 */
const IGNORED_FOLDERS = new Set([
    'node_modules',
    'dist',
    'build',
    '.git',
    '.opencode',
    'report',
    'out',
    'coverage',
    'tmp',
    'temp',
    'vendor'
]);

class ProjectFolder {
    constructor({ key, rel, dir, label, exts }) {
        this.key = key;
        this.rel = rel;
        this.dir = dir;
        this.label = label;
        this.exts = exts;
    }
}

class Project {
    constructor(root, { cached = false } = {}) {
        this.root = root;
        // `home` (rarebert's own install) is immutable during a process,
        // so its folders are cached at construction. External projects
        // (`rarebert`) re-evaluate on every discover() call so onboarding
        // changes are picked up without a reload().
        this._cached = cached;
        this._foldersCache = cached ? this._loadFolders() : null;
    }

    /**
     * Load constituent folders for this project. When the project has
     * been registered in the SQLite store (via per-project onboarding),
     * use the user-marked folders from the database. Otherwise fall
     * back to the heuristic filesystem scan — which is correct for
     * rarebert's own install (home) and as a pre-onboarding default.
     */
    _loadFolders() {
        try {
            const registered = store.getFoldersForPath(this.root);
            if (registered.length > 0) {
                return this._foldersFromRegistered(registered);
            }
        } catch {
            // Store not available (e.g. node:sqlite missing) — fall back.
        }
        return this._scanFolders();
    }

    /**
     * Build ProjectFolder descriptors from rows in the folders table.
     * Always includes the root pseudo-folder first.
     */
    _foldersFromRegistered(rows) {
        const folders = [
            new ProjectFolder({
                key: 'root',
                rel: '.',
                dir: this.root,
                label: './  (project root)',
                exts: ['.mjs', '.js']
            })
        ];
        for (const r of rows) {
            folders.push(
                new ProjectFolder({
                    key: r.key,
                    rel: r.rel,
                    dir: path.join(this.root, r.rel),
                    label: r.label ?? `${r.rel}/  (registered)`,
                    exts: r.exts
                })
            );
        }
        return folders;
    }

    _scanFolders() {
        const folders = [];

        // Root pseudo-folder — always present.
        folders.push(
            new ProjectFolder({
                key: 'root',
                rel: '.',
                dir: this.root,
                label: './  (rarebert core)',
                exts: ['.mjs', '.js']
            })
        );

        if (!fs.existsSync(this.root)) return folders;

        // Top-level non-hidden directories.
        const top = fs
            .readdirSync(this.root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .filter((e) => !e.name.startsWith('.'))
            .filter((e) => !IGNORED_FOLDERS.has(e.name))
            .map((e) => e.name)
            .sort();

        for (const name of top) {
            folders.push(this._makeFolder(name, name));
        }

        // Nested folders (e.g. lib/supports).
        for (const { parent, name } of NESTED_FOLDERS) {
            const rel = path.join(parent, name);
            if (!fs.existsSync(path.join(this.root, rel))) continue;
            folders.push(this._makeFolder(name, rel));
        }

        return folders;
    }

    _makeFolder(name, rel) {
        const dir = path.join(this.root, rel);
        return new ProjectFolder({
            key: name,
            rel,
            dir,
            label: FOLDER_LABELS[name] ?? `${name}/  (auto)`,
            exts: FOLDER_EXT_DEFAULTS[name] ?? ['.mjs', '.js']
        });
    }

    /**
     * The constituent project folders that modules live in. Each descriptor
     * is `{ key, rel, dir, label, exts }` where `dir` is the absolute folder
     * path and `rel` its root-relative path. These folders are the interface
     * to `module.mjs`'s Module constructor.
     *
     * For external projects (`rarebert`), this is lazily evaluated on
     * every call so onboarding changes are visible without a reload.
     * For `home` (rarebert's install), folders are cached at construction.
     */
    discover() {
        if (this._cached) return this._foldersCache;
        return this._loadFolders();
    }

    /**
     * Redirect this Project to a new root path. Used by `rarebert --core`
     * to point the `rarebert` singleton at the install prefix (home.root)
     * so the dispatcher operates against rarebert's own modules rather
     * than the current working directory.
     */
    redirect(root) {
        this.root = root;
        if (this._cached) {
            this._cached = false;
            this._foldersCache = null;
        }
        return this;
    }

    /** Convenience getters backed by the discovered folders. */
    get scriptsDir() {
        return this.projectByKey('scripts')?.dir ?? path.join(this.root, 'scripts');
    }

    get libDir() {
        return this.projectByKey('lib')?.dir ?? path.join(this.root, 'lib');
    }

    get srcDir() {
        return this.projectByKey('src')?.dir ?? path.join(this.root, 'src');
    }

    get supportsDir() {
        return this.projectByKey('supports')?.dir ?? path.join(this.root, 'lib', 'supports');
    }

    projectByKey(key) {
        return this.discover().find((p) => p.key === key) || null;
    }

    /**
     * Enumerate module files in `dir`. When `exts` is provided it overrides
     * the folder's default extension list; otherwise the folder's `exts`
     * are used (falling back to ['.mjs', '.js']). Pass `{ all: true }` to
     * index every regular file regardless of extension — used by memo
     * indexing where any file in a tracked folder may receive a sidecar.
     * Returns an array of { name, path } with root-relative `path`.
     */
    discoverModules(dir, exts, options = {}) {
        // No dir: default to the scripts folder (runnable modules).
        if (dir === undefined || dir === null) {
            const scriptsFolder = this.projectByKey('scripts');
            if (scriptsFolder)
                return this.discoverModules(scriptsFolder.dir, scriptsFolder.exts, options);
            return [];
        }
        const folder = this.discover().find((p) => p.dir === dir);
        const effectiveExts = exts ?? folder?.exts ?? ['.mjs', '.js'];
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

    absPath(rel) {
        return path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    }

    relPath(abs) {
        return path.relative(this.root, abs);
    }

    readDirectoryFlag(args = []) {
        if (args.includes('--lib')) return 'lib';
        if (args.includes('--src')) return 'src';
        if (args.includes('--supports')) return 'supports';
        if (args.includes('--scripts') || args.includes('--script')) return 'scripts';
        return null;
    }

    async promptDirectory(defaultDirectory = 'scripts') {
        if (process.stdin.isTTY !== true) {
            console.log(`Non-interactive; defaulting directory to ${defaultDirectory}.`);
            return defaultDirectory;
        }

        const prompt = new Enquirer.Select({
            name: 'directory',
            initial: defaultDirectory,
            choices: this.discover().map((p) => ({ name: p.key, message: p.label }))
        });

        try {
            return await prompt.run();
        } catch {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            throw e;
        }
    }

    async resolveDirectory(args = [], defaultDirectory = 'scripts') {
        return this.readDirectoryFlag(args) ?? (await this.promptDirectory(defaultDirectory));
    }

    // assertProjectRoot() {
    //     const cwd = process.cwd();
    //     if (cwd !== this.root) {
    //         console.error(`Error: must be run from project root (${this.root})`);
    //         console.error(`  Current directory: ${cwd}`);
    //         console.error(`  Run: cd ${this.root} && make ...`);
    //         process.exit(1);
    //     }
    // }

    normalizeModuleName(rawName, extensions = ['.js', '.mjs', '.py']) {
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

    getScriptMetadata(scriptPath) {
        try {
            const content = fs.readFileSync(scriptPath, 'utf-8');
            if (scriptPath.endsWith('.py')) {
                const docMatch = content.match(/"""([\s\S]*?)"""/);
                const desc = docMatch ? docMatch[1].trim().split('\n')[0] : '';
                return desc ? { description: desc } : {};
            }
            const match = content.match(/export\s+default\s*({[\s\S]+?})\s*;?/);
            if (!match) return {};
            const obj = match[1];
            const nameMatch = obj.match(/name:\s*['"`]([^'"`]+)['"`]/);
            const descMatch = obj.match(/description:\s*(['"`])([\s\S]*?)\1\s*,?/);
            const desc = descMatch ? descMatch[2].replace(/\s+/g, ' ').trim() : '';
            return {
                name: nameMatch ? nameMatch[1] : '',
                description: desc
            };
        } catch {
            return {};
        }
    }

    listOne(project) {
        const scripts = this.discoverModules(project.dir, project.exts);
        if (scripts.length === 0) {
            console.log(`${project.rel}/ (0 modules)`);
            return;
        }
        console.log(
            `${project.rel}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`
        );
        for (const mod of scripts) {
            const scriptMeta = this.getScriptMetadata(this.absPath(mod.path));
            console.log(`  ${mod.path.padEnd(24)}${scriptMeta.description || ''}`);
        }
    }

    async listModules(args = []) {
        const hasDirectoryFlag = args.some(
            (a) =>
                a === '--lib' ||
                a === '--src' ||
                a === '--supports' ||
                a === '--scripts' ||
                a === '--script'
        );
        if (hasDirectoryFlag) {
            const directory = await this.resolveDirectory(args, 'scripts');
            const project = this.projectByKey(directory);
            if (project) this.listOne(project);
            return;
        }

        const projects = this.discover();
        for (const project of projects) {
            if (project !== projects[0]) console.log();
            this.listOne(project);
        }
    }

    // -----------------------------------------------------------------------
    // Module discovery & resolution — moved from lib/module.mjs standalone
    // functions. These enumerate, resolve, and prompt for modules across
    // the project's discovered folders.
    // -----------------------------------------------------------------------

    findDirectoryTarget(key) {
        return this.discover().find((t) => t.key === key) || null;
    }

    directoryTargetByPath(absPath) {
        const resolved = path.resolve(absPath);
        const targets = this.discover();
        return (
            targets.find((t) => t.dir === resolved) ||
            targets.find((t) => resolved.startsWith(t.dir + path.sep)) ||
            null
        );
    }

    resolveModule(arg, modules) {
        const rel = path.isAbsolute(arg) ? this.relPath(arg) : arg;
        const mod =
            modules.find((m) => m.path === rel) ||
            modules.find((m) => m.path.endsWith(rel)) ||
            modules.find((m) => m.name === path.basename(rel, path.extname(rel)));
        if (!mod) return null;
        return { module: mod, rel: mod.path, sidecar: mod.memoFile() };
    }

    resolveModuleSet(args, modules) {
        const result = [];
        const seen = new Set();
        for (const arg of args) {
            const abs = path.isAbsolute(arg) ? arg : path.resolve(this.root, arg);
            if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
                for (const m of modules) {
                    if ((m.abs.startsWith(abs + path.sep) || m.abs === abs) && !seen.has(m.path)) {
                        seen.add(m.path);
                        result.push({ module: m, rel: m.path, sidecar: m.memoFile() });
                    }
                }
                continue;
            }
            const resolved = this.resolveModule(arg, modules);
            if (resolved) {
                if (!seen.has(resolved.rel)) {
                    seen.add(resolved.rel);
                    result.push(resolved);
                }
            } else {
                console.error(`no module matched "${arg}"`);
            }
        }
        return result;
    }

    buildModuleChoices(modules) {
        return modules.map((s) => {
            const meta = this.getScriptMetadata(s.abs);
            const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
            const label = `${s.path}${desc ? ' - ' + desc : ''}`;
            return { name: s.path, message: label };
        });
    }

    async promptModule(modules, moduleArg, message = 'Select a module') {
        if (moduleArg) {
            const match =
                modules.find(
                    (s) =>
                        this.normalizeModuleName(s.name) === this.normalizeModuleName(moduleArg)
                ) ||
                modules.find((s) => s.path === moduleArg) ||
                modules.find((s) => s.path.endsWith(moduleArg) || s.name === moduleArg);
            if (!match) {
                const e = new Error(`Module not found: ${moduleArg}`);
                e.name = 'AbortError';
                e.exitCode = 1;
                throw e;
            }
            return match;
        }

        if (process.stdin.isTTY !== true) {
            const e = new Error('Non-interactive; pass a module name as an argument.');
            e.name = 'AbortError';
            e.exitCode = 1;
            throw e;
        }

        const choices = this.buildModuleChoices(modules);
        const answer = await this.promptModuleChoices(message, choices, { limit: 12 });
        return modules.find((s) => s.path === answer);
    }

    async promptModuleChoices(message, choices, options = {}) {
        const { limit = 10, specials = [] } = options;
        const specialSet = new Set(specials);

        if (process.stdin.isTTY !== true) {
            const prompt = new Enquirer.Select({ name: 'select', message, choices, initial: 0, limit });
            try {
                return await prompt.run();
            } catch {
                const e = new Error('Aborted');
                e.name = 'AbortError';
                throw e;
            }
        }

        const indexed = choices.map((c) => {
            const msg = (c.message || '').toLowerCase();
            const name = (c.name || '').toLowerCase();
            const basename = name.replace(/^.*\//, '').replace(/\.\w+$/, '');
            return { choice: c, name, basename, msg };
        });

        const fuzzyMatch = (text, query) => {
            const tokens = query.split(/\s+/).filter(Boolean);
            if (tokens.length === 0) return true;
            let pos = 0;
            for (const token of tokens) {
                const idx = text.indexOf(token, pos);
                if (idx === -1) return false;
                pos = idx + token.length;
            }
            return true;
        };

        const DEFAULT_CTRL = {
            a: 'first', b: 'backward', c: 'cancel', d: 'deleteForward',
            e: 'last', f: 'forward', g: 'reset', i: 'tab', k: 'cutForward',
            l: 'reset', n: 'newItem', m: 'cancel', j: 'submit', p: 'search',
            r: 'remove', s: 'save', u: 'undo', w: 'cutLeft', x: 'toggleCursor', v: 'paste'
        };
        const DEFAULT_KEYS = {
            pageup: 'pageUp', pagedown: 'pageDown', home: 'home', end: 'end',
            cancel: 'cancel', delete: 'deleteForward', backspace: 'delete',
            down: 'down', enter: 'submit', escape: 'cancel', left: 'left',
            space: 'space', number: 'number', return: 'submit', right: 'right',
            tab: 'next', up: 'up'
        };

        const prompt = new Enquirer.AutoComplete({
            name: 'module',
            message,
            choices,
            limit,
            actions: {
                ctrl: { ...DEFAULT_CTRL, w: 'deleteWordLeft', h: 'deleteWordLeft' },
                keys: { ...DEFAULT_KEYS, backspace: 'deleteWordLeftIfCtrl' }
            },
            deleteWordLeft(input, key) {
                const inputVal = this.input || '';
                if (!inputVal) return this.alert();
                const trimmed = inputVal.replace(/\s+$/, '');
                const lastSpace = trimmed.lastIndexOf(' ');
                this.input = lastSpace >= 0 ? trimmed.slice(0, lastSpace) : '';
                this.cursor = this.input.length;
                this.render();
            },
            deleteWordLeftIfCtrl(input, key) {
                if (key && key.ctrl) {
                    return this.options.deleteWordLeft.call(this, input, key);
                }
                return this.delete.call(this, input, key);
            },
            dispatch(ch, key) {
                if (ch === undefined || ch === null || typeof ch !== 'string' || !ch.trim()) {
                    return this.alert();
                }
                if (ch.charCodeAt(0) < 32) return this.alert();
                return this.append(ch);
            },
            suggest(input) {
                const q = (input || '').toLowerCase().trim();
                if (!q) return choices;
                const tokens = q.split(/\s+/).filter(Boolean);
                const pinned = [];
                const allTokensInMsg = (msg) => tokens.every((t) => msg.includes(t));
                const lastToken = tokens[tokens.length - 1];
                const buckets = [[], [], [], [], []];
                for (const item of indexed) {
                    const { choice, name, basename, msg } = item;
                    if (specialSet.has(choice.name)) {
                        if (fuzzyMatch(name, q) || fuzzyMatch(msg, q)) pinned.push(choice);
                        continue;
                    }
                    if (!allTokensInMsg(msg)) continue;
                    if (basename.includes(lastToken)) buckets[0].push(choice);
                    else if (tokens.some((t) => basename.includes(t))) buckets[1].push(choice);
                    else if (name.includes(lastToken)) buckets[2].push(choice);
                    else if (tokens.some((t) => name.includes(t))) buckets[3].push(choice);
                    else buckets[4].push(choice);
                }
                return [...pinned, ...buckets.flat()];
            }
        });

        try {
            return await prompt.run();
        } catch {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            throw e;
        }
    }
}

/**
 * `home` is always the rarebert installation directory (where lib/,
 * scripts/, opencode.jsonc live).  Use it for locating rarebert's own
 * resources — the opencode binary, server state dir, install symlink,
 * language templates, config files.
 *
 * `rarebert` is the current working directory projected as a Project.
 * Use it for user-facing module discovery and operations against
 * whatever project the developer is currently in.
 *
 * When rarebert runs from its own repo (in-tree development),
 * `rarebert.root === home.root` and the two are interchangeable.
 */
export const home = new Project(ROOT, { cached: true });
export const rarebert = new Project(process.cwd());
export const current = rarebert;

export { Project };
export default Project;
