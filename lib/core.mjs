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

class ExitSignal {
    constructor(code, onExit = {}) {
        this.code = code;
        this.onExit = onExit;
    }

    complete() {
        if (typeof this.onExit === 'function') {
            this.onExit();
        } else if (this.onExit) {
            console.dir(this.onExit);
        }
    }
}

class HelpRequestedSignal extends Error {
    constructor() {
        super('Help requested');
        this.name = 'HelpRequestedSignal';
    }
}

function exit(code = 0, onExit = undefined) {
    return new ExitSignal(code, onExit);
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
}

const store = new Store();
// Eagerly open the DB at module load so the ExperimentalWarning (if
// any slips past the suppression) fires here — before any console
// output from other modules.
store.db();

export { ExitSignal, HelpRequestedSignal, exit, Store, store, DB_PATH, DATA_DIR };
export default { ExitSignal, HelpRequestedSignal, exit, Store, store, DB_PATH, DATA_DIR };
