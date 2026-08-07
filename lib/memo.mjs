import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rarebert } from './projects.mjs';
import { listAllModules } from './modules.mjs';
import { cli } from './cli.mjs';
import { git } from './git.mjs';

const SUFFIX = '.';

/**
 * Value object representing the memo sidecar for a single owner module.
 *
 *  owner        - filename of the module this memo is attached to
 *  name         - filename of the sidecar storing this memo
 *  lastModified - timestamp of the most recent write to the sidecar
 *  path         - rarebert-relative path of owner *and* sidecar directory
 *  content      - ordered list of individual memo notes (strings)
 *  related      - relative paths of memoised imports, oldest memo first
 */
class Memo {
    constructor({ owner, name, lastModified = 0, path: relPath = '', content = [], related = [] }) {
        this.owner = owner;
        this.name = name;
        this.lastModified = lastModified;
        this.path = relPath;
        this.content = [...content];
        this.related = [...related];
    }
}

/**
 * In-memory buffer + persistence manager for the cascading memo subsystem.
 * Previously named `Memo`; renamed so `Memo` can describe a loaded sidecar.
 */
class Memory {
    constructor() {
        this.buffer = [];
        this.flushed = false;
        this.modulesCache = null;
    }

    modules() {
        if (!this.modulesCache) this.modulesCache = listAllModules();
        return this.modulesCache;
    }

    memoFilePathFor(moduleRef) {
        if (path.isAbsolute(moduleRef)) {
            const rel = rarebert.relPath(moduleRef);
            const mod = this.modules().find((m) => m.path === rel);
            return mod ? mod.abs + SUFFIX : null;
        }
        const mod = this.modules().find((m) => m.name === moduleRef || m.path === moduleRef);
        return mod ? mod.abs + SUFFIX : null;
    }

    remember(moduleRef, content) {
        const file = this.memoFilePathFor(moduleRef);
        const mod = this.modules().find((m) => m.name === moduleRef || m.path === moduleRef);
        const name = mod?.name ?? moduleRef;
        const modulePath = mod?.path ?? '';

        if (this.buffer.some((m) => m.name === name && m.content === content)) return;

        this.buffer.push({ name, content, modulePath, lastModified: Date.now() });

        if (!file) {
            console.error(`memo: no module path resolved for "${name}"; not persisted`);
            return;
        }

        const existing = this.loadMemos(moduleRef).flatMap((m) => m.content);
        const contentSet = new Set([...existing, content]);
        fs.writeFileSync(
            file,
            JSON.stringify({ name, content: [...contentSet], lastModified: Date.now() }, null, 2) +
                '\n'
        );
    }

    forgetAll() {
        for (const m of this.modules()) {
            this.forgetByPath(m.path);
        }
    }

    forgetByPath(moduleRelPath) {
        const file = rarebert.absPath(moduleRelPath) + SUFFIX;
        try {
            fs.unlinkSync(file);
        } catch {
            /* already absent */
        }
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            if (this.buffer[i].modulePath === moduleRelPath) this.buffer.splice(i, 1);
        }
    }

    loadMemos(moduleRef) {
        const mod = this.modules().find(
            (m) => m.name === moduleRef || m.path === moduleRef || m.abs === moduleRef
        );
        const owner = mod?.name ?? moduleRef;
        const relPath = mod?.path ?? '';
        const entries = this.loadMemosWithTimestamps(moduleRef);
        if (!entries.length) return [];
        const file = this.memoFilePathFor(moduleRef);
        let lastModified = 0;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            lastModified = typeof data.lastModified === 'number' ? data.lastModified : 0;
        } catch {
            /* missing sidecar */
        }
        const related = this._relatedMemos(mod);
        return [
            new Memo({
                owner,
                name: owner + SUFFIX,
                lastModified,
                path: relPath,
                content: entries.map((e) => e.content),
                related
            })
        ];
    }

    _relatedMemos(mod) {
        if (!mod) return [];
        const related = [];
        for (const rel of this._allImports(mod)) {
            const file = rarebert.absPath(rel) + SUFFIX;
            try {
                fs.accessSync(file);
                related.push(rel);
            } catch {
                /* no memo sidecar for this import */
            }
        }
        const oldestToNewestByKey = (key) => (a, b) => {
            if (!(key in a && key in b))
                throw new Error(`can't sort {${a}<>${b}}, missing comparable field ${key}`);
            return a[key] - b[key];
        };
        const stamped = related.map((rel) => {
            const file = rarebert.absPath(rel) + SUFFIX;
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
                return {
                    rel,
                    lastModified: typeof data.lastModified === 'number' ? data.lastModified : 0
                };
            } catch {
                return { rel, lastModified: 0 };
            }
        });
        return [...stamped].sort(oldestToNewestByKey('lastModified')).map((e) => e.rel);
    }

    /**
     * Return ALL import paths (relative) for a module, memoised or not.
     * Used by walkAll() to traverse the full import graph so transitive
     * dependencies through non-memoised intermediaries are discovered.
     */
    _allImports(mod) {
        if (!mod) return [];
        const imports = parseImports(mod.abs);
        const rels = [];
        for (const libPath of imports) {
            const rel = path.isAbsolute(libPath) ? rarebert.relPath(libPath) : libPath;
            rels.push(rel);
        }
        return rels;
    }

    loadMemosWithTimestamps(moduleRef) {
        const file = this.memoFilePathFor(moduleRef);
        if (!file) return [];
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const entries = (data.content || []).map((c, i) => ({
                content: c,
                lastModified:
                    typeof data.lastModified === 'number'
                        ? data.lastModified
                        : typeof c === 'object' && c !== null
                          ? c.lastModified || 0
                          : 0,
                idx: i
            }));
            return entries;
        } catch {
            return [];
        }
    }

    loadAllMemos() {
        const entries = [];
        for (const m of this.modules()) {
            const file = m.abs + SUFFIX;
            let memos = [];
            let lastModified = 0;
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
                memos = data.content || [];
                lastModified = typeof data.lastModified === 'number' ? data.lastModified : 0;
            } catch {
                /* file absent or invalid */
            }
            if (memos.length) entries.push({ module: m, memos, lastModified });
        }
        entries.sort((a, b) => a.lastModified - b.lastModified);
        return entries;
    }

    loadMemosByPath(modulePath) {
        const rel = path.isAbsolute(modulePath) ? rarebert.relPath(modulePath) : modulePath;
        const file = rarebert.absPath(rel) + SUFFIX;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const entries = (data.content || []).map((c, i) => ({
                content: c,
                lastModified:
                    typeof data.lastModified === 'number'
                        ? data.lastModified
                        : typeof c === 'object' && c !== null
                          ? c.lastModified || 0
                          : 0,
                idx: i
            }));
            entries.sort((a, b) => a.lastModified - b.lastModified);
            return {
                name: data.name || path.basename(rel, path.extname(rel)),
                memos: entries,
                modulePath: rel
            };
        } catch {
            return { name: path.basename(rel, path.extname(rel)), memos: [], modulePath: rel };
        }
    }

    recallImports(callerRef) {
        const callerPath = callerRef.startsWith('file://') ? fileURLToPath(callerRef) : callerRef;
        const imports = parseImports(callerPath);
        const collected = [];
        for (const libPath of imports) {
            const { name: libName, memos, modulePath: relPath } = this.loadMemosByPath(libPath);
            for (const entry of memos) {
                if (
                    this.buffer.some((m) => m.modulePath === relPath && m.content === entry.content)
                )
                    continue;
                collected.push({
                    name: libName,
                    content: entry.content,
                    modulePath: relPath,
                    lastModified: entry.lastModified
                });
            }
        }
        for (const entry of collected) {
            this.buffer.unshift(entry);
        }
        return collected;
    }

    loadForRun(scriptPath, scriptName) {
        this.recallImports(scriptPath);
        const mod = this.modules().find((m) => m.name === scriptName);
        const modulePath = mod?.path ?? scriptPath;
        for (const entry of this.loadMemosWithTimestamps(scriptName)) {
            if (!this.buffer.some((m) => m.name === scriptName && m.content === entry.content)) {
                this.buffer.push({
                    name: scriptName,
                    content: entry.content,
                    modulePath: modulePath || '',
                    lastModified: entry.lastModified
                });
            }
        }
        this.installFlushHandlers();
    }

    flush() {
        if (this.flushed || this.buffer.length === 0) return;
        this.flushed = true;
        const sorted = [...this.buffer].sort((a, b) => {
            const ta = a.lastModified || 0;
            const tb = b.lastModified || 0;
            return ta - tb;
        });
        process.stderr.write('\n');
        for (const entry of sorted) {
            const display = entry.modulePath || entry.name;
            process.stderr.write(`\x1b[1;2m${display}:\x1b[0m ${entry.content}\n`);
        }
    }

    clearBuffer() {
        this.buffer.length = 0;
    }

    installFlushHandlers() {
        process.on('exit', () => this.flush());
        cli.onAbort(() => this.flush());
    }

    snapshot(label = 'memo snapshot') {
        const all = this.loadAllMemos();
        if (all.length === 0) {
            console.log('memo: nothing to snapshot (no memos found)');
            return false;
        }
        const modules = all.map((e) => e.module.path).join(', ');
        const payload = JSON.stringify(all, null, 2);
        const message = `${modules}\n\n${payload}`;
        const ok = git.notesAdd(message, 'HEAD');
        if (ok) {
            console.log(`memo: snapshotted ${all.length} module(s) to refs/notes/memos`);
        } else {
            console.error('memo: git notes add failed');
        }
        return ok;
    }

    showSnapshot(ref = 'HEAD') {
        const note = git.notesShow(ref);
        if (!note) {
            console.log(`memo: no snapshot at ${ref}`);
            return null;
        }
        const newlineIdx = note.indexOf('\n\n');
        const payload = newlineIdx >= 0 ? note.slice(newlineIdx + 2) : note;
        try {
            return JSON.parse(payload);
        } catch {
            console.error('memo: snapshot payload is not valid JSON');
            return null;
        }
    }

    log(limit = 20) {
        const entries = git.notesLog('refs/notes/memos', limit);
        if (entries.length === 0) {
            console.log('memo: no snapshots in refs/notes/memos');
            return [];
        }
        for (const e of entries) {
            console.log(`${e.date}  ${e.subject}`);
        }
        return entries;
    }

    restore(ref = 'HEAD') {
        const snapshot = this.showSnapshot(ref);
        if (!snapshot) return false;

        this.forgetAll();
        for (const { module, memos } of snapshot) {
            const file = rarebert.absPath(module.path) + SUFFIX;
            const entry = {
                name: module.name,
                content: memos,
                lastModified: Date.now()
            };
            fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
            console.log(`memo: restored ${module.path} (${memos.length} memo(s))`);
        }
        return true;
    }

    /**
     * Build a flat, unique-element DAG view of all memoised modules.
     *
     * Traverses the FULL import graph (including non-memoised
     * intermediaries) so transitive dependencies are discovered:
     * if A → B → C where B has no memo, C is still emitted before A.
     * Only memoised modules produce output rows; non-memoised nodes
     * are walked through (for ordering/cycle detection) but not emitted.
     *
     * Uses DFS post-order so dependencies appear before dependents
     * (topological order). Each memoised module appears exactly once.
     *
     * Cycle detection: a true back-edge is an edge to a node on the
     * *current DFS path* (the recursion stack), not merely a visited
     * node. A shared dependency (in-degree > 1) is NOT a cycle.
     *
     * Returns groups of:
     *   { owner, path, memos: string[], related: RelatedEntry[], cycles: number }
     *
     * where RelatedEntry is { path, cycle: boolean }. `related` lists
     * only the memoised imports (for display); cycle is true only for
     * genuine back-edges.
     */
    walkAll() {
        const allModules = this.modules();
        const byPath = new Map(allModules.map((m) => [m.path, m]));

        const memoCache = new Map();
        const loadMemo = (modPath) => {
            if (memoCache.has(modPath)) return memoCache.get(modPath);
            const own = this.loadMemos(modPath);
            const memo = own.length > 0 ? own[0] : null;
            memoCache.set(modPath, memo);
            return memo;
        };

        const visited = new Set(); // fully processed nodes (memoised or not)
        const onStack = new Set(); // nodes on the current DFS path
        const groups = [];
        let totalCycles = 0;

        // DFS over the full import graph. Recurses through non-memoised
        // nodes (tracking them for cycle detection) but only emits
        // memoised nodes in post-order.
        const visit = (modPath) => {
            if (visited.has(modPath)) return;
            if (onStack.has(modPath)) return; // caller handles back-edge check

            const mod = byPath.get(modPath);
            if (!mod) {
                // external/non-project import — nothing to traverse
                visited.add(modPath);
                return;
            }

            const ownerMemo = loadMemo(modPath);
            onStack.add(modPath);

            // Traverse ALL imports (memoised or not) for ordering/cycles.
            const allImports = this._allImports(mod);
            for (const relPath of allImports) {
                if (onStack.has(relPath)) {
                    // genuine back-edge: target is an ancestor on this DFS path
                    if (ownerMemo) {
                        totalCycles++;
                    }
                } else if (!visited.has(relPath)) {
                    // recurse into unvisited dependency (emits it before us
                    // if it's memoised, or just traverses through it if not)
                    visit(relPath);
                }
                // cross/forward edge to an already-visited node: nothing to do
            }

            onStack.delete(modPath);
            visited.add(modPath);

            // Only emit memoised nodes
            if (ownerMemo) {
                // Build the display `related` from memoised imports only,
                // pre-sorted oldest memo first.
                const related = [];
                let cycles = 0;
                for (const relPath of this._relatedMemos(mod)) {
                    if (onStack.has(relPath)) {
                        cycles++;
                        related.push({ path: relPath, cycle: true });
                    } else {
                        related.push({ path: relPath, cycle: false });
                    }
                }

                groups.push({
                    owner: ownerMemo.owner,
                    path: ownerMemo.path,
                    memos: ownerMemo.content,
                    related,
                    cycles
                });
            }
        };

        // Iterate oldest memo first so the DFS roots favour old nodes,
        // though post-order emission is what guarantees dependencies-first.
        const oldestToNewestByKey = (key) => (a, b) => {
            if (!(key in a && key in b))
                throw new Error(`can't sort {${a}<>${b}}, missing comparable field ${key}`);
            return a[key] - b[key];
        };
        const stamped = allModules
            .map((m) => ({ mod: m, ts: this._moduleLastModified(m.path) }))
            .sort(oldestToNewestByKey('ts'));

        for (const { mod } of stamped) {
            visit(mod.path);
        }

        groups.totalCycles = totalCycles;
        return groups;
    }

    _moduleLastModified(modulePath) {
        const file = rarebert.absPath(modulePath) + SUFFIX;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return typeof data.lastModified === 'number' ? data.lastModified : 0;
        } catch {
            return 0;
        }
    }
}

function parseImports(filePath) {
    let src;
    try {
        src = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }
    const importerDir = path.dirname(filePath);
    const results = [];
    const seen = new Set();
    const re = /from\s+(['"`])([^'"`]+)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const spec = m[2];
        if (!spec.includes('/') && !spec.startsWith('.')) continue;
        let resolved;
        try {
            resolved = path.resolve(importerDir, spec);
        } catch {
            continue;
        }
        if (!seen.has(resolved)) {
            seen.add(resolved);
            results.push(resolved);
        }
    }
    return results;
}

const memo = new Memory();

export { Memo, Memory, memo };
export default memo;
