import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rarebert } from './projects.mjs';
import { listAllModules, cli, promptModule, resolveModule, AbortError } from './module.mjs';
import { git } from './git.mjs';
import { YELLOW_TICK, RED_BOLD, DIM, RESET, BOLD, BOLD_DIM } from '../scripts/symbols.mjs';

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
        // Always match by full relative path first; bare name is last resort.
        const mod =
            this.modules().find((m) => m.path === moduleRef) ||
            this.modules().find((m) => m.path.endsWith(moduleRef)) ||
            this.modules().find((m) => m.name === moduleRef);
        return mod ? mod.abs + SUFFIX : null;
    }

    remember(moduleRef, content) {
        const file = this.memoFilePathFor(moduleRef);
        // Resolve moduleRef to a relative path for consistent buffer entries.
        // moduleRef may be a name, a relative path, or an absolute path.
        const relPath = path.isAbsolute(moduleRef) ? rarebert.relPath(moduleRef) : moduleRef;
        const mod =
            this.modules().find(
                (m) => m.path === relPath || m.path === moduleRef || m.path.endsWith(relPath)
            ) || this.modules().find((m) => m.name === moduleRef);
        const name = mod?.name ?? path.basename(relPath, path.extname(relPath));
        const modulePath = mod?.path ?? relPath;

        if (this.buffer.some((m) => m.name === name && m.content === content)) return;

        // Only surface the memo in the flush trail when it belongs to the
        // running module or one of its imports. A memo added to an
        // unrelated target during a command (e.g. `memo --add
        // scripts/edit.mjs ...` run from memo.mjs) is persisted to its
        // sidecar but should not pollute the running module's reminder
        // trail, and in particular must not outrank the running module's
        // own memos (which it would, since remember() stamps Date.now()).
        if (this._isTrailRelevant(modulePath)) {
            this.buffer.push({ name, content, modulePath, lastModified: Date.now() });
        }

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
        const inputRel = path.isAbsolute(moduleRef) ? rarebert.relPath(moduleRef) : moduleRef;
        const mod =
            this.modules().find(
                (m) => m.path === inputRel || m.path === moduleRef || m.abs === moduleRef
            ) || this.modules().find((m) => m.path.endsWith(inputRel) || m.name === moduleRef);
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

    /**
     * Decide whether a memo added to `modulePath` should appear in the
     * running module's flush trail. Returns true when `modulePath` is
     * the running script itself or a (transitive) import of it. A memo
     * written to an unrelated target during a command is persisted but
     * kept out of the trail so it can't outrank the running module's
     * own memos.
     */
    _isTrailRelevant(modulePath) {
        if (!this.runScriptName) return true; // no run context: keep legacy behaviour
        const byPath = new Map(this.modules().map((m) => [m.path, m]));
        const running =
            byPath.get(`scripts/${this.runScriptName}.mjs`) ||
            byPath.get(this.runScriptName) ||
            this.modules().find(
                (m) => m.path.endsWith(this.runScriptName) || m.name === this.runScriptName
            );
        if (!running) return true;
        if (running.path === modulePath) return true;

        // BFS over the running module's transitive imports.
        const seen = new Set();
        const queue = [running.path];
        while (queue.length) {
            const cur = queue.shift();
            if (seen.has(cur)) continue;
            seen.add(cur);
            if (cur === modulePath) return true;
            const mod = byPath.get(cur);
            if (mod) queue.push(...this._allImports(mod));
        }
        return false;
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
                    lastModified: entry.lastModified,
                    idx: entry.idx ?? 0
                });
            }
        }
        for (const entry of collected) {
            this.buffer.push(entry);
        }
        return collected;
    }

    loadForRun(scriptPath, scriptName) {
        this.runScriptName = scriptName;
        // If the running script has no memos of its own, don't load
        // import memos or install flush handlers — the cascading buffer
        // would only print dependency memos, which is confusing when
        // the command's own output already covered them.
        const ownMemos = this.loadMemosWithTimestamps(scriptName);
        if (ownMemos.length === 0) return;

        this.recallImports(scriptPath);
        const mod =
            this.modules().find((m) => m.path === scriptPath) ||
            this.modules().find((m) => m.name === scriptName);
        const modulePath = mod?.path ?? scriptPath;
        for (const entry of ownMemos) {
            if (!this.buffer.some((m) => m.name === scriptName && m.content === entry.content)) {
                this.buffer.push({
                    name: scriptName,
                    content: entry.content,
                    modulePath: modulePath || '',
                    lastModified: entry.lastModified,
                    idx: entry.idx ?? 0
                });
            }
        }
        this.installFlushHandlers();
    }

    flush() {
        if (this.flushed || this.buffer.length === 0) return;
        this.flushed = true;

        // Compute dependency depth for each buffer entry so that
        // dependencies print before dependents (topological order).
        // Depth = longest path from a leaf (no memoised imports) to this node.
        const allModules = this.modules();
        const byPath = new Map(allModules.map((m) => [m.path, m]));
        const depthCache = new Map();
        const computing = new Set();

        const depthOf = (modPath) => {
            if (depthCache.has(modPath)) return depthCache.get(modPath);
            if (computing.has(modPath)) return 0; // cycle guard
            const mod = byPath.get(modPath);
            if (!mod) {
                depthCache.set(modPath, 0);
                return 0;
            }
            computing.add(modPath);
            const imports = this._allImports(mod);
            let maxChildDepth = 0;
            for (const imp of imports) {
                const d = depthOf(imp);
                if (d > maxChildDepth) maxChildDepth = d;
            }
            computing.delete(modPath);
            const depth = maxChildDepth + 1;
            depthCache.set(modPath, depth);
            return depth;
        };

        const sorted = [...this.buffer].sort((a, b) => {
            const da = depthOf(a.modulePath) || 0;
            const db = depthOf(b.modulePath) || 0;
            if (da !== db) return da - db; // deeper dependencies first
            const ta = a.lastModified || 0;
            const tb = b.lastModified || 0;
            if (ta !== tb) return ta - tb; // oldest memo first within same depth
            return (a.idx ?? 0) - (b.idx ?? 0); // storage order tiebreaker
        });
        process.stderr.write('\n');
        const runLabel = this.runScriptName || 'this module';
        process.stderr.write(`${YELLOW_TICK} Reminder for ${runLabel}, memos exist:\n`);
        for (const entry of sorted) {
            const display = entry.modulePath || entry.name;
            process.stderr.write(`${BOLD_DIM}${display}:${RESET} ${entry.content}\n`);
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
            return { legacy: false, entries: JSON.parse(payload) };
        } catch {
            // Legacy snapshots may be a plain list of lines, one memo per line.
            // Normalise into the same shape as JSON snapshots, flagged legacy.
            const lines = payload
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean);
            if (lines.length === 0) {
                console.error('memo: snapshot payload is empty or unparseable');
                return null;
            }
            return { legacy: true, entries: lines };
        }
    }

    log(limit = -1) {
        const entries = this.logEntries(limit);
        if (entries.length === 0) {
            console.log('memo: no snapshots in refs/notes/memos');
            return [];
        }
        for (const e of entries) {
            console.log(`${e.date}  ${e.subject}`);
        }
        return entries;
    }

    /**
     * Return snapshot log entries (data only, no printing). Each entry is
     * { hash, date, subject, modules: string[] } where `modules` lists the
     * module paths covered by that snapshot's subject line.
     */
    /**
     * Return snapshot log entries (data only, no printing). Each entry is
     * { hash, date, subject, modules: string[] } where `modules` lists the
     * module paths covered by that snapshot's subject line.
     *
     * `limit` defaults to -1, meaning "all entries". A positive limit
     * caps the result count. Entries are sorted reverse-chronologically
     * (newest first) so that on an unbounded `--log` the most recent
     * snapshots print first and a developer can interrupt once they've
     * seen fresh information.
     */
    logEntries(limit = -1) {
        const raw = git.notesLog('refs/notes/memos', limit);
        const entries = raw.map((e) => ({
            hash: e.hash,
            date: e.date,
            subject: e.subject,
            modules: e.subject
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
        }));
        // Reverse-chronological (newest first). git notes list order is by
        // target object hash, not by date, so we sort explicitly. Newest
        // first so an unbounded --log surfaces recent content immediately.
        entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        return entries;
    }

    /**
     * Restore memos from a git notes snapshot. If `files` is given (an
     * array of module paths), only those modules are restored; otherwise
     * the full snapshot is restored.
     *
     * Restored memos are UNIFIED with any existing sidecar content
     * (set union, existing entries first) rather than overwriting it.
     *
     * `since` field: for JSON-structured snapshots, the oldest
     * lastModified across the unified content is preserved as the
     * sidecar's lastModified (so "how long ago" is answerable). For
     * legacy plain-text snapshots (one memo per line, no timestamps),
     * the sidecar's lastModified is not updated.
     */
    restore(ref = 'HEAD', files = null) {
        const snapshot = this.showSnapshot(ref);
        if (!snapshot) return false;

        const wanted = files && files.length ? new Set(files) : null;
        const { legacy, entries } = snapshot;
        const restored = [];

        // Normalise legacy plain-line snapshots into the {module, memos} shape.
        // Legacy lines are "<modulePath>: <memo>" or bare "<memo>" lines.
        const normalised = legacy ? this._normaliseLegacySnapshot(entries) : entries;

        for (const { module, memos } of normalised) {
            if (wanted && !wanted.has(module.path)) continue;
            const file = rarebert.absPath(module.path) + SUFFIX;

            // Load existing sidecar content (if any) to unify with.
            const existing = this._readSidecarContent(file);
            const unified = [...existing];
            const seen = new Set(existing);
            for (const m of memos) {
                if (!seen.has(m)) {
                    seen.add(m);
                    unified.push(m);
                }
            }

            // Compute the oldest lastModified across the unified set.
            // Only for JSON snapshots; legacy snapshots leave it untouched.
            let lastModified;
            if (legacy) {
                const cur = this._readSidecarLastModified(file);
                lastModified = cur; // unchanged
            } else {
                const snapshotTs = this._oldestTimestampInSnapshot(normalised, module.path);
                const existingTs = this._readSidecarLastModified(file);
                lastModified = Math.min(
                    ...[snapshotTs, existingTs].filter((t) => typeof t === 'number' && t > 0)
                );
                if (!Number.isFinite(lastModified)) lastModified = Date.now();
            }

            const entry = {
                name: module.name,
                content: unified,
                lastModified
            };
            fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
            const added = unified.length - existing.length;
            restored.push({ path: module.path, count: unified.length, added });
            const since = lastModified
                ? ` (since ${new Date(lastModified).toISOString().slice(0, 10)})`
                : '';
            console.log(
                `memo: restored ${module.path} (${unified.length} memo(s)${added ? `, +${added} new` : ''}${since})`
            );
        }
        if (restored.length === 0 && wanted) {
            console.log(`memo: no matching modules in snapshot at ${ref}`);
        }
        return true;
    }

    /**
     * Convert a legacy plain-text snapshot (array of lines) into the
     * { module, memos } shape. Lines of the form "<path>: <memo>" are
     * grouped by path; bare lines are grouped under an "unknown" module.
     */
    _normaliseLegacySnapshot(lines) {
        const byPath = new Map();
        for (const line of lines) {
            const m = line.match(/^([^:\s]+(?:\.[a-z]+)?)\s*:\s*(.+)$/i);
            if (m) {
                const modPath = m[1];
                const content = m[2].trim();
                if (!byPath.has(modPath)) byPath.set(modPath, []);
                byPath.get(modPath).push(content);
            } else {
                if (!byPath.has('unknown')) byPath.set('unknown', []);
                byPath.get('unknown').push(line);
            }
        }
        return [...byPath.entries()].map(([modPath, memos]) => ({
            module: { path: modPath, name: path.basename(modPath, path.extname(modPath)) },
            memos
        }));
    }

    _readSidecarContent(file) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return Array.isArray(data.content) ? data.content : [];
        } catch {
            return [];
        }
    }

    _readSidecarLastModified(file) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return typeof data.lastModified === 'number' ? data.lastModified : 0;
        } catch {
            return 0;
        }
    }

    _oldestTimestampInSnapshot(normalised, modPath) {
        const entry = normalised.find((e) => e.module.path === modPath);
        if (!entry) return 0;
        const ts = typeof entry.lastModified === 'number' ? entry.lastModified : 0;
        return ts;
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
        const stackPath = []; // ordered list of modPaths on the current DFS path
        const groups = [];
        const cycles = []; // array of { path: string[] } cycle descriptions

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
            stackPath.push(modPath);

            // Traverse ALL imports (memoised or not) for ordering/cycles.
            const allImports = this._allImports(mod);
            for (const relPath of allImports) {
                if (onStack.has(relPath)) {
                    // genuine back-edge: target is an ancestor on this DFS path.
                    // Only warn if BOTH endpoints are memoised — a cycle
                    // through non-memoised intermediaries is valid JS and
                    // doesn't affect the memo DAG.
                    const targetMemo = loadMemo(relPath);
                    if (ownerMemo && targetMemo) {
                        // Record the cycle path: from the ancestor back to us
                        const cycleStart = stackPath.indexOf(relPath);
                        const cyclePath = stackPath.slice(cycleStart).concat(relPath);
                        cycles.push({ path: cyclePath });
                    }
                } else if (!visited.has(relPath)) {
                    // recurse into unvisited dependency (emits it before us
                    // if it's memoised, or just traverses through it if not)
                    visit(relPath);
                }
                // cross/forward edge to an already-visited node: nothing to do
            }

            onStack.delete(modPath);
            stackPath.pop();
            visited.add(modPath);

            // Only emit memoised nodes
            if (ownerMemo) {
                // Build the display `related` from memoised imports only,
                // pre-sorted oldest memo first.
                const related = [];
                let nodeCycles = 0;
                for (const relPath of this._relatedMemos(mod)) {
                    if (onStack.has(relPath)) {
                        nodeCycles++;
                        related.push({ path: relPath, cycle: true });
                    } else {
                        related.push({ path: relPath, cycle: false });
                    }
                }

                groups.push({
                    owner: ownerMemo.owner,
                    path: ownerMemo.path,
                    memos: ownerMemo.content,
                    lastModified: ownerMemo.lastModified || 0,
                    related,
                    cycles: nodeCycles
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

        groups.totalCycles = cycles.length;
        groups.cycles = cycles;
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

// ---------------------------------------------------------------------------
// Memo CLI command helpers (merged from lib/memo-cmd.mjs)
// ---------------------------------------------------------------------------

export function printMemoAdded(rel) {
    console.log(`${YELLOW_TICK} Memo added to ${rel}`);
}

/**
 * Split argv into a list of { flags: string[], positional: string[] } groups,
 * where each `--flag` starts a new group that consumes following positionals
 * until the next `--flag`. Non-flag positionals before any flag form a leading
 * group with an empty flags array.
 */
export function groupArgs(argv) {
    const groups = [];
    let current = { flags: [], positional: [] };
    groups.push(current);
    for (const arg of argv) {
        if (arg.startsWith('--')) {
            if (current.flags.length || current.positional.length) {
                current = { flags: [arg], positional: [] };
                groups.push(current);
            } else {
                current.flags.push(arg);
            }
        } else {
            current.positional.push(arg);
        }
    }
    return groups.filter((g) => g.flags.length || g.positional.length);
}

export function printFlatMemos(entries) {
    if (entries.length === 0) {
        console.log('No memos found.');
        return false;
    }
    const flat = [];
    for (const { module, memos: contents, lastModified } of entries) {
        for (const content of contents) {
            flat.push({ path: module.path, content, lastModified });
        }
    }
    flat.sort((a, b) => a.lastModified - b.lastModified);
    for (const { path: p, content } of flat) {
        console.log(`${p} memos:`);
        console.log(`\t${content}`);
    }
    return true;
}

/**
 * Print the memo DAG, optionally filtered to a set of resolved module
 * descriptors. When a set is given, ancestors are emitted before the
 * members that reference them (deepest-first).
 */
export function printDagForSet(resolvedSet) {
    const groups = memo.walkAll();
    if (groups.length === 0) {
        console.log('No memos found.');
        return false;
    }

    const totalCycles = groups.totalCycles ?? 0;
    const cyclePaths = groups.cycles ?? [];
    const wanted = resolvedSet ? new Set(resolvedSet.map((r) => r.rel)) : null;
    const byPath = new Map(groups.map((g) => [g.path, g]));
    const emitted = new Set();
    let shown = 0;

    // Compute priority ranks: most recent lastModified = 0, next = 1, ...
    const sortedByRecency = [...groups].sort(
        (a, b) => (b.lastModified || 0) - (a.lastModified || 0)
    );
    const priorityByPath = new Map();
    for (let i = 0; i < sortedByRecency.length; i++) {
        priorityByPath.set(sortedByRecency[i].path, i);
    }

    const emitGroup = (groupPath, indent) => {
        if (emitted.has(groupPath)) return;
        emitted.add(groupPath);
        const g = byPath.get(groupPath);
        if (!g) return;

        for (const entry of g.related) {
            if (!entry.cycle) emitGroup(entry.path, true);
        }

        shown++;
        const prefix = indent ? '  ' : '';
        const style = indent ? DIM : BOLD;
        console.log(`\n${style}${prefix}${g.path}${DIM} has ${g.memos.length} memos${RESET}`);

        const ts = g.lastModified || 0;
        const priority = priorityByPath.get(g.path) ?? 0;
        const tsLabel = ts
            ? new Date(ts)
                  .toISOString()
                  .replace('T', ' ')
                  .replace(/\.\d+Z$/, 'Z')
            : 'unknown';
        console.log(`${prefix}  timestamp: ${tsLabel}`);
        console.log(`${prefix}  priority: ${priority}`);

        if (g.related.length) {
            for (let i = 0; i < g.related.length; i++) {
                const entry = g.related[i];
                const isLast = i === g.related.length - 1;
                const branch = isLast ? '└── ' : '├── ';
                if (entry.cycle) {
                    console.log(`${prefix}  ${RED_BOLD}${branch}${entry.path} ↻${RESET}`);
                } else {
                    console.log(`${prefix}  ${DIM}${branch}${entry.path}${RESET}`);
                }
            }
        }

        for (const content of g.memos) {
            console.log(`${prefix}  ${DIM}└${g.path}${RESET} memo: ${content}`);
        }
    };

    if (wanted) {
        for (const { path } of groups) {
            if (wanted.has(path)) emitGroup(path, false);
        }
    } else {
        for (const { path } of groups) emitGroup(path, false);
    }

    if (shown === 0) {
        console.log('No memos found for the given modules.');
        return false;
    }
    if (totalCycles > 0) {
        console.log(
            `\n${RED_BOLD}⚠ ${totalCycles} cyclic import${totalCycles === 1 ? '' : 's'} detected:${RESET}`
        );
        for (const c of cyclePaths) {
            console.log(`  ${RED_BOLD}${c.path.join(' → ')}${RESET}`);
        }
    }
    console.log();
    return true;
}

/**
 * Parse a comma-separated indices string into 0-based array indices.
 * 1-based positive; negative counts from end; 0 is invalid.
 */
export function parseIndices(arg, count) {
    if (count === 0) {
        console.error('No memos to drop.');
        return null;
    }
    const raw = arg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (!raw.length) {
        console.error(`No indices provided in "${arg}".`);
        return null;
    }

    const indices = [];
    for (const token of raw) {
        const n = parseInt(token, 10);
        if (Number.isNaN(n)) {
            console.error(`Invalid index "${token}"; expected an integer.`);
            return null;
        }
        if (n === 0) {
            console.error(
                `Index 0 is invalid; indices are 1-based (use 1 for the first memo, -1 for the last).`
            );
            return null;
        }
        const idx = n > 0 ? n - 1 : count + n;
        if (idx < 0 || idx >= count) {
            const range = `1–${count} (or -1 to -${count} from end)`;
            console.error(`Index ${n} is out of bounds; valid range: ${range}.`);
            return null;
        }
        indices.push(idx);
    }
    return indices;
}

export function applyDrop(resolved, selected) {
    const remaining = memo
        .loadMemos(resolved.rel)
        .flatMap((m) => m.content)
        .filter((c) => !selected.includes(c));
    if (!remaining.length) {
        try {
            fs.unlinkSync(resolved.sidecar);
        } catch {
            /* already absent */
        }
    } else {
        fs.writeFileSync(
            resolved.sidecar,
            JSON.stringify(
                { name: resolved.module.name, content: remaining, lastModified: Date.now() },
                null,
                2
            ) + '\n'
        );
    }
    console.log(`Dropped ${selected.length} memo(s) from ${resolved.rel}`);
}

export async function multiSelectMemos(resolved) {
    const memos = memo.loadMemos(resolved.rel).flatMap((m) => m.content);
    if (!memos.length) return [];

    const { default: Enquirer } = await import('enquirer');
    const prompt = new Enquirer.MultiSelect({
        name: 'memos',
        message: `Select memos to drop:`,
        choices: memos.map((content, idx) => ({
            name: idx.toString(),
            message: content,
            value: content
        }))
    });
    try {
        const result = await prompt.run();
        return result.map((idx) => memos[parseInt(idx, 10)]);
    } catch {
        throw new AbortError();
    }
}

export function cmdPrintSet(resolvedSet, withAncestors) {
    if (withAncestors) {
        printDagForSet(resolvedSet);
    } else {
        const setPaths = new Set(resolvedSet.map((r) => r.rel));
        const all = memo.loadAllMemos().filter((e) => setPaths.has(e.module.path));
        printFlatMemos(all);
    }
}

export function cmdPrintAll(withAncestors = false) {
    if (withAncestors) {
        printDagForSet(null);
    } else {
        printFlatMemos(memo.loadAllMemos());
    }
}

export async function cmdAdd(groups, modules) {
    for (const g of groups) {
        if (g.flags[0] !== '--add') continue;
        const [modArg, ...rest] = g.positional;
        if (!modArg) {
            console.error('memo --add: missing module path');
            continue;
        }
        const content = rest.join(' ').trim();
        if (!content) {
            console.error(`memo --add: missing memo content for "${modArg}"`);
            continue;
        }
        const resolved = resolveModule(modArg, modules);
        if (!resolved) {
            console.error(`memo --add: module not found: ${modArg}`);
            continue;
        }
        memo.remember(resolved.rel, content);
        printMemoAdded(resolved.rel);
    }
}

export async function cmdCommit(isYes, isFresh) {
    const label = 'memo snapshot';
    const hadMemos = memo.loadAllMemos().length > 0;
    if (!hadMemos) {
        console.log('No memos to commit.');
        return;
    }
    if (!isYes) {
        const ok = await cli.confirm('Commit memos to git notes?');
        if (!ok) {
            console.log('Aborted; memos not committed.');
            return;
        }
    }
    memo.snapshot(label);
    if (isFresh) {
        memo.forgetAll();
        console.log('Fresh slate (working sidecars cleared).');
    }
    memo.clearBuffer();
}

export function cmdLog(nonFlag) {
    const entries = memo.logEntries();
    if (entries.length === 0) {
        console.log('memo: no snapshots in refs/notes/memos');
        return;
    }
    const wanted = nonFlag.length ? new Set(nonFlag) : null;
    let shown = 0;
    for (const e of entries) {
        if (wanted) {
            const hits = e.modules.filter((m) => wanted.has(m));
            if (hits.length === 0) continue;
            console.log(`${e.date}  ${e.subject}  [${hits.join(', ')}]`);
        } else {
            console.log(`${e.date}  ${e.subject}`);
        }
        shown++;
    }
    if (shown === 0) {
        console.log('memo: no snapshots reference the given filenames');
    }
}

export function cmdRecall(ref, nonFlag) {
    if (!ref) {
        console.error('memo --recall: missing ref argument');
        return;
    }
    memo.restore(ref, nonFlag.length ? nonFlag : null);
    memo.clearBuffer();
}

export async function cmdDrop(moduleArg, indicesArg, modules) {
    if (!moduleArg) {
        return cli.fail("A memo'd module must be specified for --drop.");
    }

    const target = await promptModule(modules, moduleArg, 'Select module to drop memos from');
    const resolved = { module: target, rel: target.path, sidecar: target.memoFile() };

    const allMemos = memo.loadMemos(resolved.rel).flatMap((m) => m.content);
    if (!allMemos.length) {
        console.log('No memos found for this module.');
        return;
    }

    if (process.stdin.isTTY !== true) {
        if (!indicesArg) {
            console.error(
                `Error: missing indices argument for non-interactive --drop:\n` +
                    `Non-interactive mode cannot prompt for memo selection.\n` +
                    `  Pass comma-separated indices (1 for first, -1 for last): --drop ${moduleArg} 1,3,-1\n` +
                    `  Or to remove all memos for this module, use: --forget ${moduleArg}`
            );
            return cli.fail();
        }
        const indices = parseIndices(indicesArg, allMemos.length);
        if (!indices) return;
        applyDrop(
            resolved,
            indices.map((i) => allMemos[i])
        );
        return;
    }

    let selected;
    if (indicesArg) {
        const indices = parseIndices(indicesArg, allMemos.length);
        if (!indices) return;
        selected = indices.map((i) => allMemos[i]);

        console.log(`\n${BOLD}Memos to drop from ${resolved.rel}:${RESET}`);
        for (const [i, content] of selected.entries()) {
            console.log(`  ${indicesArg.split(',')[i]?.trim() || i + 1}. ${content}`);
        }
        console.log();
        const confirmed = await cli.select('Proceed?', [
            { name: 'drop', message: 'Drop the listed memos' },
            { name: 'cancel', message: 'Cancel' }
        ]);
        if (confirmed === 'cancel') {
            console.log('Aborted; no memos dropped.');
            return;
        }
    } else {
        selected = await multiSelectMemos(resolved);
    }

    if (!selected.length) {
        console.log('No memos selected; nothing dropped.');
        return;
    }
    applyDrop(resolved, selected);
}

export function cmdForget(moduleArgs, modules) {
    if (!moduleArgs || moduleArgs.length === 0) {
        console.error('memo --forget: missing module argument');
        return;
    }

    // Resolve every argument first; if any module is not found, error
    // out completely without forgetting anything.
    const resolved = [];
    for (const moduleArg of moduleArgs) {
        const r = resolveModule(moduleArg, modules);
        if (!r) {
            console.error(`memo --forget: module not found: ${moduleArg}`);
            return;
        }
        resolved.push(r);
    }

    for (const r of resolved) {
        if (!fs.existsSync(r.sidecar)) {
            console.log(`${YELLOW_TICK} No memos were found on ${r.rel}`);
            continue;
        }
        memo.forgetByPath(r.rel);
        console.log(`${YELLOW_TICK} Forgot all memos for ${r.rel}`);
    }
}

export { Memo, Memory, memo };
export default memo;
