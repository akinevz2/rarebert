import fs from 'fs';
import path from 'path';
import os from 'os';
import { DatabaseSync } from 'node:sqlite';

// The SQLite ExperimentalWarning fires when DatabaseSync is first
// constructed, and Node's default 'warning' listener prints it to
// stderr — which can land mid-prompt and shadow Enquirer output. We
// replace the default listener with a filtered one that swallows the
// SQLite experimental warning (noise the user can't act on) and
// forwards everything else.
for (const l of process.listeners('warning')) {
    process.removeListener('warning', l);
}
process.on('warning', (w) => {
    if (w && w.message && w.message.includes('SQLite is an experimental')) return;
    process.stderr.write(`${w.name || 'Warning'}: ${w.message}\n`);
});

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ABORT = 130;

/**
 * ExitSignal represents the result of a module execution.
 * It can wrap an exit code, a submodule (CLI/TUI instance), or an onExit callback.
 * 
 * DEPRECATED METHODS that bypass the exit() callback system:
 * - die() in lib/core.mjs:133 - use exit() instead
 * - abort() in lib/cli.mjs - use exit() with AbortError instead
 * - ok/fail() in lib/cli.mjs - use exit() instead
 * - nonInteractive() in lib/cli.mjs - use exit() with appropriate code
 */
class ExitSignal {
    constructor(code, onExit = undefined, retry = false, cleanup = null, submodule = null) {
        this.code = code;
        this.onExit = onExit;
        this.retry = retry;
        this.cleanup = cleanup;
        this.submodule = submodule;
    }

    async complete() {
        if (this.submodule) {
            try {
                if (typeof this.submodule.execute === 'function') {
                    const result = await this.submodule.execute();
                    const exitCode = result instanceof ExitSignal 
                        ? await result.complete() 
                        : (typeof result === 'number' ? result : 0);
                    if (typeof this.onExit === 'function') {
                        await this.onExit(exitCode);
                    }
                    return exitCode;
                } else if (typeof this.submodule === 'function') {
                    const result = await this.submodule();
                    const exitCode = typeof result === 'number' ? result : 0;
                    if (typeof this.onExit === 'function') {
                        await this.onExit(exitCode);
                    }
                    return exitCode;
                } else if (this.submodule && typeof this.submodule.then === 'function') {
                    const result = await this.submodule;
                    const exitCode = typeof result === 'number' ? result : 0;
                    if (typeof this.onExit === 'function') {
                        await this.onExit(exitCode);
                    }
                    return exitCode;
                }
            } catch (err) {
                if (typeof this.onExit === 'function') {
                    await this.onExit(1);
                }
                return 1;
            }
        }
        
        if (this.cleanup) {
            try {
                await this.cleanup();
            } catch {
                /* cleanup errors don't propagate */
            }
        }
        
        if (typeof this.onExit === 'function') {
            await this.onExit(this.code);
        }
        return this.code;
    }

    isSubmodule() {
        return this.submodule !== null;
    }

    getRetry() {
        return this.retry;
    }

    getCleanup() {
        return this.cleanup;
    }
}

class HelpRequestedSignal extends Error {
    constructor() {
        super('Help requested');
        this.name = 'HelpRequestedSignal';
    }
}

function exit(codeOrSubmodule, options = {}) {
    const { onExit, retry, cleanup } = options;
    
    if (codeOrSubmodule === undefined || codeOrSubmodule === null) {
        return new ExitSignal(0, onExit, retry, cleanup, null);
    }
    
    if (typeof codeOrSubmodule === 'number') {
        return new ExitSignal(codeOrSubmodule, onExit, retry, cleanup, null);
    }
    
    if (typeof codeOrSubmodule === 'function') {
        return new ExitSignal(0, onExit, retry, cleanup, codeOrSubmodule);
    }
    
    if (codeOrSubmodule instanceof ExitSignal) {
        return codeOrSubmodule;
    }
    
    return new ExitSignal(codeOrSubmodule.code ?? 0, onExit, retry, cleanup, codeOrSubmodule);
}

// ---------------------------------------------------------------------------
// Rarebert data directory and SQLite store.
//
// The data directory follows the XDG convention: $XDG_DATA_HOME or
// ~/.local/share/rarebert. This is the install prefix used by
// `make install` and the home of rarebert.db — the per-project
// onboarding registry. Keeping it independent of projects.mjs avoids
// a circular import (projects.mjs imports the store from core.mjs).
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'rarebert')
    : path.join(os.homedir(), '.local', 'share', 'rarebert');

const DB_PATH = path.join(DATA_DIR, 'rarebert.db');

/**
 * Thin wrapper over node:sqlite DatabaseSync. Opens (or creates) the
 * rarebert.db file in the data directory and initialises the schema.
 *
 * Schema:
 *   projects
 *     id          INTEGER PRIMARY KEY
 *     path        TEXT UNIQUE        — absolute path to the project root
 *     onboarded   INTEGER            — 1 once onboarding completed
 *     editor_type TEXT               — 'terminal' | 'graphical' | NULL (rarebert pref)
 *     last_model  TEXT               — last-chosen model id ('provider/model'), NULL if unset
 *     created_at  TEXT               — ISO timestamp
 *
 *   folders
 *     id          INTEGER PRIMARY KEY
 *     project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE
 *     rel         TEXT               — root-relative folder path (e.g. "src", "lib")
 *     key         TEXT               — folder key used by Project.discover()
 *     exts        TEXT               — JSON array of extensions (e.g. '[".ts",".js"]')
 *     label       TEXT               — human-readable label
 *
 * Callers go through the `store` singleton; never construct Store
 * directly outside of tests.
 */
class Store {
    constructor(dbPath = DB_PATH) {
        this.dbPath = dbPath;
        this._db = null;
    }

    /** Lazily open the database and create tables if missing. */
    db() {
        if (this._db) return this._db;
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this._db = new DatabaseSync(this.dbPath);
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                path        TEXT UNIQUE NOT NULL,
                onboarded   INTEGER NOT NULL DEFAULT 0,
                editor_type TEXT,
                last_model  TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS folders (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                rel         TEXT NOT NULL,
                key         TEXT NOT NULL,
                exts        TEXT NOT NULL DEFAULT '[".mjs",".js"]',
                label       TEXT,
                UNIQUE(project_id, rel)
            );
        `);
        // Add columns to pre-existing projects tables (created before the
        // columns existed). CREATE TABLE IF NOT EXISTS won't alter an
        // existing table, so we probe PRAGMA table_info and ALTER if missing.
        const cols = this._db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
        if (!cols.includes('editor_type')) {
            this._db.exec('ALTER TABLE projects ADD COLUMN editor_type TEXT');
        }
        if (!cols.includes('last_model')) {
            this._db.exec('ALTER TABLE projects ADD COLUMN last_model TEXT');
        }
        // Ensure introspect_cache table exists (added for the introspect
        // tooling framework).
        const tables = this._db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='introspect_cache'").all();
        if (tables.length === 0) {
            this._db.exec(`CREATE TABLE introspect_cache (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                tool        TEXT NOT NULL,
                cache_key   TEXT NOT NULL,
                abs_path    TEXT NOT NULL,
                output      TEXT NOT NULL,
                parsed      TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(tool, cache_key)
            )`);
        }
        return this._db;
    }

    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }

    // ---- projects ----

    /**
     * Look up a project by its absolute root path. Returns
     * { id, path, onboarded, created_at } or null.
     */
    getProject(absPath) {
        const row = this.db().prepare('SELECT * FROM projects WHERE path = ?').get(absPath);
        return row ?? null;
    }

    /**
     * Insert a project row (if not already present) and return the
     * record. Does NOT mark it onboarded — call markOnboarded() after
     * the onboarding flow completes.
     */
    registerProject(absPath) {
        const db = this.db();
        const existing = this.getProject(absPath);
        if (existing) return existing;
        db.prepare('INSERT INTO projects (path) VALUES (?)').run(absPath);
        return this.getProject(absPath);
    }

    /** Mark a project as having completed onboarding. */
    markOnboarded(absPath) {
        this.db().prepare('UPDATE projects SET onboarded = 1 WHERE path = ?').run(absPath);
    }

    /**
     * Get the persisted `editor_type` preference for a project.
     * Returns 'terminal' | 'graphical' | null.
     */
    getEditorType(absPath) {
        const p = this.getProject(absPath);
        if (!p) return null;
        return p.editor_type === 'terminal'
            ? 'terminal'
            : p.editor_type === 'graphical'
              ? 'graphical'
              : null;
    }

    /** Persist the editor_type preference for a project. */
    setEditorType(absPath, editorType) {
        const p = this.getProject(absPath);
        if (!p) return;
        this.db()
            .prepare('UPDATE projects SET editor_type = ? WHERE id = ?')
            .run(editorType ?? null, p.id);
    }

    /**
     * Get the last-chosen model id for a project ('provider/model' or null).
     */
    getLastModel(absPath) {
        const p = this.getProject(absPath);
        return p?.last_model ?? null;
    }

    /** Persist the last-chosen model id for a project. */
    setLastModel(absPath, modelId) {
        const p = this.getProject(absPath);
        if (!p) return;
        this.db()
            .prepare('UPDATE projects SET last_model = ? WHERE id = ?')
            .run(modelId ?? null, p.id);
    }

    /** True when the project at absPath has completed onboarding. */
    isOnboarded(absPath) {
        const p = this.getProject(absPath);
        return p?.onboarded === 1;
    }

    /** Remove a project and its folders (cascade). */
    forgetProject(absPath) {
        this.db().prepare('DELETE FROM projects WHERE path = ?').run(absPath);
    }

    // ---- folders ----

    /**
     * Replace the set of registered folders for a project. `folders` is
     * an array of { rel, key, exts (array), label }.
     */
    setFolders(projectId, folders) {
        const db = this.db();
        db.prepare('DELETE FROM folders WHERE project_id = ?').run(projectId);
        const ins = db.prepare(
            'INSERT INTO folders (project_id, rel, key, exts, label) VALUES (?, ?, ?, ?, ?)'
        );
        for (const f of folders) {
            ins.run(projectId, f.rel, f.key, JSON.stringify(f.exts), f.label ?? null);
        }
    }

    /**
     * Return the registered folders for a project as
     * [{ id, project_id, rel, key, exts (array), label }] or [].
     */
    getFolders(projectId) {
        const rows = this.db().prepare('SELECT * FROM folders WHERE project_id = ?').all(projectId);
        return rows.map((r) => ({ ...r, exts: JSON.parse(r.exts) }));
    }

    /**
     * Return the registered folders for a project identified by its
     * absolute root path, or [] when the project isn't registered.
     */
    getFoldersForPath(absPath) {
        const p = this.getProject(absPath);
        if (!p) return [];
        return this.getFolders(p.id);
    }

    // ---- introspect_cache ----

    getIntrospectCache(tool, key) {
        const row = this.db()
            .prepare('SELECT parsed FROM introspect_cache WHERE tool = ? AND cache_key = ?')
            .get(tool, key);
        if (!row || !row.parsed) return null;
        return { parsed: row.parsed };
    }

    setIntrospectCache(tool, key, absPath, output, parsed) {
        this.db()
            .prepare(
                `INSERT INTO introspect_cache (tool, cache_key, abs_path, output, parsed)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(tool, cache_key) DO UPDATE SET
                     abs_path = excluded.abs_path,
                     output = excluded.output,
                     parsed = excluded.parsed,
                     created_at = datetime('now')`
            )
            .run(tool, key, absPath, output, parsed ?? null);
    }

    clearIntrospectCache(tool = null) {
        if (tool) {
            this.db().prepare('DELETE FROM introspect_cache WHERE tool = ?').run(tool);
        } else {
            this.db().exec('DELETE FROM introspect_cache');
        }
    }
}

const store = new Store();
// Eagerly open the DB at module load so the ExperimentalWarning (if
// any slips past the suppression) fires here — before any console
// output from other modules.
store.db();

export { ExitSignal, HelpRequestedSignal, exit, EXIT_OK, EXIT_FAIL, EXIT_ABORT, Store, store, DB_PATH, DATA_DIR };
export default { ExitSignal, HelpRequestedSignal, exit, EXIT_OK, EXIT_FAIL, EXIT_ABORT, Store, store, DB_PATH, DATA_DIR };
