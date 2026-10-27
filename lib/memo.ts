import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rarebert } from './runtime/Project.ts';
import { listAllModules, resolveModule } from './runtime/discovery.ts';
import type { Module } from './runtime/Module.ts';
import { Script } from './runtime/Script.ts';
import { Languages } from './runtime/Language.ts';
import type { Language } from './runtime/Language.ts';
import { parseModuleImports, buildImportGraph, computeChainDepths, stronglyConnectedComponents, compareDagGroups } from './depgraph.ts';
// Terminal/abort helpers — free functions from the runtime Module module
// (the legacy `cli` singleton was deleted).
import { onAbort } from './runtime/Module.ts';
import { git } from './git.ts';
import { YELLOW_TICK, RED_BOLD, DIM, RESET, BOLD, BOLD_DIM } from './supports/symbols.ts';

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
/** Constructor payload for a Memo. */
export interface MemoInit {
    /** Filename of the module this memo is attached to. */
    owner: string;
    /** Filename of the sidecar storing this memo. */
    name: string;
    /** Timestamp of the most recent write to the sidecar. */
    lastModified?: number;
    /** Project-relative path of the owner and sidecar directory. */
    path?: string;
    /** Ordered list of individual memo notes (strings and/or rich shape entries). */
    content?: MemoContent[];
    /** Relative paths of memoised imports, oldest memo first. */
    related?: string[];
}

class Memo {
    /** Filename of the module this memo is attached to. */
    owner: string;
    /** Filename of the sidecar storing this memo. */
    name: string;
    /** Timestamp of the most recent write to the sidecar. */
    lastModified: number;
    /** Project-relative path of the owner and sidecar directory. */
    path: string;
    /** Ordered list of individual memo notes (strings and/or rich shape entries). */
    content: MemoContent[];
    /** Relative paths of memoised imports, oldest memo first. */
    related: string[];

    constructor({ owner, name, lastModified = 0, path: relPath = '', content = [], related = [] }: MemoInit) {
        this.owner = owner;
        this.name = name;
        this.lastModified = lastModified;
        this.path = relPath;
        this.content = [...content];
        this.related = [...related];
    }
}

/** One memo entry in the in-memory buffer. */
export interface BufferEntry {
    /** The module (or sidecar) name. */
    name: string;
    /** The memo text or a rich-memo shape entry. */
    content: MemoContent;
    /** Project-relative path of the owning module. */
    modulePath: string;
    /** Timestamp of the memo. */
    lastModified?: number;
    /** Storage-order tiebreaker. */
    idx?: number;
}

/** A memo entry with its timestamp, as read from a sidecar. */
export interface TimestampedEntry {
    /** The memo text. */
    content: string;
    /** Timestamp of the memo. */
    lastModified: number;
    /** Storage-order index. */
    idx: number;
}

/** A memoised module as returned by `loadAllMemos`. */
export interface AllMemoEntry {
    /** The owning module. */
    module: Module;
    /** The memo texts. */
    memos: string[];
    /** Timestamp of the sidecar. */
    lastModified: number;
}

/** A related (memoised) import in the DAG view. */
export interface RelatedEntry {
    /** Project-relative path of the import. */
    path: string;
    /** True for a genuine back-edge. */
    cycle: boolean;
}

/** One node of the memo DAG. */
export interface MemoGroup {
    /** The owning module's name. */
    owner: string;
    /** Project-relative path of the owning module. */
    path: string;
    /** The memo texts (strings and/or rich shape entries). */
    memos: MemoContent[];
    /** Timestamp of the sidecar. */
    lastModified: number;
    /** Memoised imports (for display). */
    related: RelatedEntry[];
    /** Number of genuine back-edges at this node. */
    cycles: number;
    /**
     * Reference-chain depth: how many layers of modules transitively
     * import this one (longest importer chain; top-level modules = 0).
     * The PRIMARY key of the DAG print ordering (deepest first).
     */
    depth: number;
}

/** The memo DAG: its groups plus cycle metadata. */
export interface MemoDag extends Array<MemoGroup> {
    /** Total number of cycles found. */
    totalCycles: number;
    /** Cycle descriptions. */
    cycles: Array<{ path: string[] }>;
}

// ---------------------------------------------------------------------------
// Rich memos — pre-definable, reusable memo shapes.
//
// A sidecar's `content` array holds BOTH human read-writeable string
// memos AND structured shape entries, interleaved. A shape entry is
// `{ shape: <id>, ...fields }` authored compactly as
// `@<id>(<arg>, <arg>, ...)` — e.g. `@see-line(42, race in flush
// ordering)`. Shapes are data: the registry maps an id to its ordered
// fields and a renderer, so scaffolding a new shape extends every
// consumer (DAG print, --oldest, snapshots) at once — the same
// philosophy as the language-support framework.
//
// Backward compatible: plain strings pass through untouched; an
// `@<unknown-shape>(...)` or arity/type-mismatched authoring keeps the
// authored text verbatim. (Per docs/KNOWN_ISSUES.md §0b: per-shape
// aging/expiry rules are pinned for later.)
// ---------------------------------------------------------------------------

/** Field type of a memo shape; positional args bind in order. */
export type MemoShapeFieldType = 'int' | 'float' | 'string';

export interface MemoShapeField {
    name: string;
    type: MemoShapeFieldType;
    description?: string;
}

/** A structured shape entry as stored in a sidecar content array. */
export interface ShapeEntry {
    shape: string;
    [field: string]: unknown;
}

/**
 * One memo content entry: a human read-writeable string memo or a rich
 * shape entry. The consumer-side type for anything that reads/writes a
 * sidecar `content` array.
 */
export type MemoContent = string | ShapeEntry;

export interface MemoShape {
    id: string;
    description: string;
    fields: readonly MemoShapeField[];
    render: (entry: ShapeEntry) => string;
}

/** The reusable memo-shape registry. Data, not behaviour: extend by adding entries. */
export const memoShapes: Record<string, MemoShape> = {
    'see-line': {
        id: 'see-line',
        description: 'Anchor an issue to a source line: @see-line(<line>, <issue>)',
        fields: [
            { name: 'line', type: 'int', description: '1-indexed source line' },
            { name: 'issue', type: 'string', description: 'the issue — consumes the remaining args verbatim' }
        ],
        render: (e) => `line ${e.line}: ${e.issue}`
    },
    smell: {
        id: 'smell',
        description: 'Anchor a code smell to a source line: @smell(<line>, <smell>)',
        fields: [
            { name: 'line', type: 'int', description: '1-indexed source line' },
            { name: 'smell', type: 'string', description: 'the smell — consumes the remaining args verbatim' }
        ],
        render: (e) => `smell @ line ${e.line}: ${e.smell}`
    }
};

/**
 * Split a shape's argument list on unquoted commas; double quotes protect
 * embedded commas in text fields.
 */
function splitShapeArgs(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (const ch of s) {
        if (ch === '"') {
            quoted = !quoted;
            continue;
        }
        if (ch === ',' && !quoted) {
            out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur.trim());
    return out;
}

/**
 * Author a memo entry. `@<shape>(args)` becomes a ShapeEntry when the
 * shape is known and the args bind cleanly; everything else (plain
 * strings, unknown shapes, mismatched args) is kept verbatim.
 */
export function parseMemoContent(raw: string): MemoContent {
    const m = /^@([\w-]+)\s*\((.*)\)\s*$/.exec(raw.trim());
    if (!m) return raw;
    const shape = memoShapes[m[1]];
    if (!shape) return raw;
    const args = splitShapeArgs(m[2]);
    const entry: ShapeEntry = { shape: shape.id };
    let argIdx = 0;
    for (let f = 0; f < shape.fields.length; f++) {
        const field = shape.fields[f];
        // A final string field consumes the remaining args verbatim (the
        // comma separators are re-joined; quoted commas survive inside).
        if (field.type === 'string' && f === shape.fields.length - 1) {
            entry[field.name] = args.slice(argIdx).join(', ').trim();
            argIdx = args.length;
            break;
        }
        const value = args[argIdx++];
        if (value === undefined) return raw;
        if (field.type === 'int') {
            const n = parseInt(value, 10);
            if (isNaN(n)) return raw;
            entry[field.name] = n;
        } else if (field.type === 'float') {
            const n = parseFloat(value);
            if (isNaN(n)) return raw;
            entry[field.name] = n;
        } else {
            entry[field.name] = value;
        }
    }
    if (argIdx < args.length) return raw;
    return entry;
}

/** Render any memo entry for display: shape → its formatter, object → JSON, string → itself. */
export function renderMemoEntry(entry: unknown): string {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
        const e = entry as ShapeEntry;
        if (typeof e.shape === 'string') {
            const shape = memoShapes[e.shape];
            if (shape) {
                try {
                    return shape.render(e);
                } catch {
                    /* fall through to JSON */
                }
            }
        }
        return JSON.stringify(e);
    }
    return String(entry);
}

/**
 * Canonical dedup key for a content entry: objects get a stable JSON form
 * (sorted keys), strings pass through. Two authorings of the same shape
 * with the same fields are one memo.
 */
export function memoEntryKey(entry: unknown): string {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(e).sort()) sorted[k] = e[k];
        return JSON.stringify(sorted);
    }
    return String(entry);
}

/**
 * In-memory buffer + persistence manager for the cascading memo subsystem.
 * Previously named `Memo`; renamed so `Memo` can describe a loaded sidecar.
 */
class Memory {
    /** The in-memory memo buffer. */
    buffer: BufferEntry[];
    /** Whether the buffer has already been flushed. */
    flushed: boolean;
    /** Cached module list. */
    modulesCache: Module[] | null;
    /** The running script's whole ref (set by loadForRun). */
    runScript: Script | null;
    /** Per-extension Language cache, warmed by ensureLanguages(). */
    private langCache: Map<string, Language | null>;
    /** The in-flight warm-up promise (ensureLanguages is idempotent). */
    private langWarm: Promise<void> | null;
    /** Extensions already warned about (one warning per missing support). */
    private warnedExt: Set<string>;

    constructor() {
        this.buffer = [];
        this.flushed = false;
        this.modulesCache = null;
        this.runScript = null;
        this.langCache = new Map();
        this.langWarm = null;
        this.warnedExt = new Set();
    }

    modules(): Module[] {
        if (!this.modulesCache) this.modulesCache = listAllModules();
        return this.modulesCache;
    }

    /**
     * Preload the Language parser for every module extension in the
     * project. MUST be awaited before any synchronous traversal
     * (_allImports / walkAll / flush) so the import graph is built by the
     * language-variadic extractors instead of a regex guess. Non-fatal:
     * an extension with no support module caches null and its modules
     * simply contribute no import edges.
     */
    async ensureLanguages(): Promise<void> {
        if (!this.langWarm) this.langWarm = this._warmLanguages();
        await this.langWarm;
    }

    private async _warmLanguages(): Promise<void> {
        const exts = new Set(this.modules().map((m) => path.extname(m.abs).toLowerCase()));
        await Promise.all(
            [...exts].map(async (ext) => {
                if (this.langCache.has(ext)) return;
                try {
                    this.langCache.set(ext, await Languages.loadLanguage(ext));
                } catch {
                    this.langCache.set(ext, null);
                }
            })
        );
    }

    /** The cached Language for a file's extension (null when absent/unwarmed). */
    private languageFor(absPath: string): Language | null {
        return this.langCache.get(path.extname(absPath).toLowerCase()) ?? null;
    }

    /** Load a module's Memo sidecar value object (null when none). */
    loadMemoFor(modPath: string): Memo | null {
        const own = this.loadMemos(modPath);
        return own.length > 0 ? own[0] : null;
    }

    memoFilePathFor(moduleRef: string): string | null {
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

    remember(moduleRef: string, content: string): void {
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

        // Rich memos: @shape(...) authoring becomes a structured entry at
        // the single write choke point; everything else stays a string.
        const entry = parseMemoContent(content);

        if (this.buffer.some((m) => m.name === name && memoEntryKey(m.content) === memoEntryKey(entry))) return;

        // Only surface the memo in the flush trail when it belongs to the
        // running module or one of its imports. A memo added to an
        // unrelated target during a command (e.g. `memo --add
        // scripts/edit.ts ...` run from memo.ts) is persisted to its
        // sidecar but should not pollute the running module's reminder
        // trail, and in particular must not outrank the running module's
        // own memos (which it would, since remember() stamps Date.now()).
        if (this._isTrailRelevant(modulePath)) {
            this.buffer.push({ name, content: entry, modulePath, lastModified: Date.now() });
        }

        if (!file) {
            console.error(`memo: no module path resolved for "${name}"; not persisted`);
            return;
        }

        const existing = this.loadMemos(moduleRef).flatMap((m) => m.content);
        // Canonical dedup: same-shape authorings collapse; key order is
        // irrelevant for structured entries.
        const seen = new Map(existing.map((e) => [memoEntryKey(e), e]));
        if (!seen.has(memoEntryKey(entry))) seen.set(memoEntryKey(entry), entry);
        fs.writeFileSync(
            file,
            JSON.stringify({ name, content: [...seen.values()], lastModified: Date.now() }, null, 2) +
            '\n'
        );
    }

    forgetAll(): void {
        for (const m of this.modules()) {
            // TODO(whole-object): pass the Module (m has abs + memoFile()) instead of m.path — see §lib-classes
            this.forgetByPath(m.path);
        }
    }

    forgetByPath(moduleRelPath: string): void {
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

    /**
     * Find the "most-forgotten" memo: the one that would be printed first
     * by the DAG print — the first row of the spec ordering (reference-
     * chain depth deepest-first, then memo age oldest-first) and, within
     * it, the oldest memo (first in the sidecar's content order — entries
     * share the sidecar's lastModified, so insertion order is the age
     * order).
     * Returns { rel, module, content, lastModified } or null.
     */
    findOldestMemo(): {
        rel: string;
        module: Module | null;
        content: MemoContent;
        lastModified: number;
    } | null {
        const groups = [...this.walkAll()].sort(compareDagGroups);
        if (groups.length === 0) return null;
        const first = groups[0];
        const content = first.memos[0];
        if (content === undefined) return null;
        const mod = this.modules().find((m) => m.path === first.path) || null;
        return {
            rel: first.path,
            module: mod,
            content,
            lastModified: first.lastModified || 0
        };
    }

    /** Drop the single most-forgotten memo (see findOldestMemo). */
    forgetOldest(): ReturnType<Memory['findOldestMemo']> {
        const oldest = this.findOldestMemo();
        if (!oldest) return null;
        const resolved = {
            module: oldest.module,
            rel: oldest.rel,
            sidecar: oldest.module
                ? oldest.module.memoFile()
                : rarebert.absPath(oldest.rel) + SUFFIX
        };
        // TODO(whole-object): pass a ResolvedModule (or the Module) instead of this hand-built {module, rel, sidecar} triple — see §lib-classes
        applyDrop(resolved, [oldest.content]);
        return oldest;
    }
    loadMemos(moduleRef: string): Memo[] {
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
            const data = JSON.parse(fs.readFileSync(file!, 'utf-8'));
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

    _relatedMemos(mod: Module | null | undefined): string[] {
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
        const oldestToNewestByKey = (key: string) => (a: any, b: any): number => {
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
     * Parsed through the module extension's Language support (comment-safe,
     * structured) — never regex-guessed. Used by walkAll() to traverse the
     * full import graph so transitive dependencies through non-memoised
     * intermediaries are discovered. Requires ensureLanguages() to have
     * warmed the cache; unwarmed/unsupported extensions yield no edges.
     */
    _allImports(mod: { abs: string } | null | undefined): string[] {
        if (!mod) return [];
        const ext = path.extname(mod.abs).toLowerCase();
        const lang = this.languageFor(mod.abs);
        if (!lang) {
            // Warn only for extensions that SHOULD have support (a lang*.js
            // module exists but failed to load). Extensions with no support
            // module at all (.md, .json) are silently edge-less by design.
            if (Languages.isSupported(ext) && !this.warnedExt.has(ext)) {
                this.warnedExt.add(ext);
                console.error(
                    `memo: no language support loaded for ${ext} — import edges unavailable (call ensureLanguages() first)`
                );
            }
            return [];
        }
        return parseModuleImports(mod.abs, lang).map((absSource) => rarebert.relPath(absSource));
    }

    /**
     * Decide whether a memo added to `modulePath` should appear in the
     * running module's flush trail. Returns true when `modulePath` is
     * the running script itself or a (transitive) import of it. A memo
     * written to an unrelated target during a command is persisted but
     * kept out of the trail so it can't outrank the running module's
     * own memos.
     */
    _isTrailRelevant(modulePath: string): boolean {
        if (!this.runScript) return true; // no run context: keep legacy behaviour
        const byPath = new Map(this.modules().map((m) => [m.path, m]));
        // TODO(whole-object): resolve the running Module from the whole runScript instead of runScript.path/runScript.name pairs — see §lib-classes
        const running =
            byPath.get(this.runScript.path) ||
            this.modules().find((m) => m.name === this.runScript!.name);
        if (!running) return true;
        if (running.path === modulePath) return true;

        // BFS over the running module's transitive imports.
        const seen = new Set();
        const queue = [running.path];
        while (queue.length) {
            const cur = queue.shift();
            if (cur === undefined) continue;
            if (seen.has(cur)) continue;
            seen.add(cur);
            if (cur === modulePath) return true;
            const mod = byPath.get(cur);
            if (mod) queue.push(...this._allImports(mod));
        }
        return false;
    }

    loadMemosWithTimestamps(moduleRef: string): TimestampedEntry[] {
        const file = this.memoFilePathFor(moduleRef);
        if (!file) return [];
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const entries: TimestampedEntry[] = (data.content || []).map(
                (c: any, i: number) => ({
                    content: c,
                    lastModified:
                        typeof data.lastModified === 'number'
                            ? data.lastModified
                            : typeof c === 'object' && c !== null
                                ? c.lastModified || 0
                                : 0,
                    idx: i
                })
            );
            return entries;
        } catch {
            return [];
        }
    }

    loadAllMemos(): AllMemoEntry[] {
        const entries = [];
        for (const m of this.modules()) {
            const file = m.abs + SUFFIX;
            let memos: string[] = [];
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

    loadMemosByPath(modulePath: string): {
        name: string;
        memos: TimestampedEntry[];
        modulePath: string;
    } {
        const rel = path.isAbsolute(modulePath) ? rarebert.relPath(modulePath) : modulePath;
        const file = rarebert.absPath(rel) + SUFFIX;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const entries: TimestampedEntry[] = (data.content || []).map(
                (c: any, i: number) => ({
                    content: c,
                    lastModified:
                        typeof data.lastModified === 'number'
                            ? data.lastModified
                            : typeof c === 'object' && c !== null
                                ? c.lastModified || 0
                                : 0,
                    idx: i
                })
            );
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

    recallImports(callerRef: string): BufferEntry[] {
        const callerPath = callerRef.startsWith('file://') ? fileURLToPath(callerRef) : callerRef;
        // TODO(whole-object): pass the running Script/Module instead of the hand-built { abs: callerPath } stub — see §lib-classes
        const imports = this._allImports({ abs: callerPath });
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

    async loadForRun(script: Script): Promise<void> {
        this.runScript = script;
        // Warm the language parsers first — recallImports' transitive
        // cascade and flush()'s depth ordering both need real import edges.
        await this.ensureLanguages();
        // If the running script has no memos of its own, don't load
        // import memos or install flush handlers — the cascading buffer
        // would only print dependency memos, which is confusing when
        // the command's own output already covered them.
        // TODO(whole-object): pass the whole script (Script) instead of script.name — see §lib-classes
        const ownMemos = this.loadMemosWithTimestamps(script.name);
        if (ownMemos.length === 0) return;

        // TODO(whole-object): pass the whole script (Script) instead of script.abs — see §lib-classes
        this.recallImports(script.abs);
        // TODO(whole-object): resolve the running Module from the whole script instead of script.path/script.name pairs — see §lib-classes
        const mod =
            this.modules().find((m) => m.path === script.path) ||
            this.modules().find((m) => m.name === script.name);
        const modulePath = mod?.path ?? script.path;
        for (const entry of ownMemos) {
            if (!this.buffer.some((m) => m.name === script.name && m.content === entry.content)) {
                this.buffer.push({
                    name: script.name,
                    content: entry.content,
                    modulePath: modulePath || '',
                    lastModified: entry.lastModified,
                    idx: entry.idx ?? 0
                });
            }
        }
        this.installFlushHandlers();
    }

    flush(): void {
        if (this.flushed || this.buffer.length === 0) return;
        this.flushed = true;

        // Spec ordering (the shared comparator): reference-chain depth
        // deepest-first, then memo age oldest-first — dependencies print
        // before dependents, and the least-referenced (depth 0) entries
        // land last. Depths come from the shared depgraph primitive over
        // the full module graph (importer chains above each node).
        const allModules = this.modules();
        const importersOf = new Map<string, string[]>(allModules.map((m) => [m.path, []]));
        for (const m of allModules) {
            for (const rel of this._allImports(m)) {
                importersOf.get(rel)?.push(m.path);
            }
        }
        const depths = computeChainDepths(
            allModules.map((m) => m.path),
            importersOf
        );

        const sorted = [...this.buffer].sort((a, b) =>
            compareDagGroups(
                { depth: depths.get(a.modulePath) ?? 0, lastModified: a.lastModified },
                { depth: depths.get(b.modulePath) ?? 0, lastModified: b.lastModified }
            )
        );
        process.stderr.write('\n');
        const runLabel = this.runScript?.name || 'this module';
        process.stderr.write(`${YELLOW_TICK} Reminder for ${runLabel}, memos exist:\n`);
        for (const entry of sorted) {
            const display = entry.modulePath || entry.name;
            process.stderr.write(`${BOLD_DIM}${display}:${RESET} ${renderMemoEntry(entry.content)}\n`);
        }
    }

    clearBuffer(): void {
        this.buffer.length = 0;
    }

    installFlushHandlers(): void {
        process.on('exit', () => this.flush());
        onAbort(() => this.flush());
    }

    snapshot(label = 'memo snapshot'): boolean {
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

    /**
     * Prompt-free commit orchestration (the lib-purity inversion of the
     * former cmdCommit): snapshot to git notes, optionally clear working
     * sidecars (--fresh), then clear the in-memory buffer. Confirmation
     * prompting lives in scripts/memo.ts; callers invoke this after their
     * own confirm. Returns false when there are no memos to commit.
     */
    commitMemos({ label = 'memo snapshot', fresh = false }: { label?: string; fresh?: boolean } = {}): boolean {
        if (this.loadAllMemos().length === 0) return false;
        this.snapshot(label);
        if (fresh) {
            this.forgetAll();
            console.log('Fresh slate (working sidecars cleared).');
        }
        this.clearBuffer();
        return true;
    }

    showSnapshot(ref = 'HEAD'): { legacy: boolean; entries: unknown } | null {
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

    log(limit = -1): Array<{ hash: string; date: string; subject: string; modules: string[] }> {
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
    logEntries(limit = -1): Array<{ hash: string; date: string; subject: string; modules: string[] }> {
        const raw = git.notesLog('refs/notes/memos', limit);
        const entries = raw.map((e) => ({
            hash: e.hash,
            date: e.date,
            subject: e.subject ?? '',
            modules: (e.subject ?? '')
                .split(',')
                .map((s: string) => s.trim())
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
    restore(ref = 'HEAD', files: string[] | null = null): boolean {
        const snapshot = this.showSnapshot(ref);
        if (!snapshot) return false;

        const wanted = files && files.length ? new Set(files) : null;
        const { legacy, entries } = snapshot;
        const restored: Array<{ path: string; count: number; added: number }> = [];

        // Normalise legacy plain-line snapshots into the {module, memos} shape.
        // Legacy lines are "<modulePath>: <memo>" or bare "<memo>" lines.
        const normalised: Array<{
            module: { path: string; name: string };
            memos: string[];
            lastModified?: number;
        }> = legacy
            ? this._normaliseLegacySnapshot(entries as string[])
            : (entries as Array<{
                  module: { path: string; name: string };
                  memos: string[];
                  lastModified?: number;
              }>);

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
    _normaliseLegacySnapshot(lines: string[]): Array<{
        module: { path: string; name: string };
        memos: string[];
        lastModified?: number;
    }> {
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

    _readSidecarContent(file: string): string[] {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return Array.isArray(data.content) ? data.content : [];
        } catch {
            return [];
        }
    }

    _readSidecarLastModified(file: string): number {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return typeof data.lastModified === 'number' ? data.lastModified : 0;
        } catch {
            return 0;
        }
    }

    _oldestTimestampInSnapshot(
        normalised: Array<{ module: { path: string }; lastModified?: number }>,
        modPath: string
    ): number {
        const entry = normalised.find((e) => e.module.path === modPath);
        if (!entry) return 0;
        const ts = typeof entry.lastModified === 'number' ? entry.lastModified : 0;
        return ts;
    }

    /**
     * Build a flat, unique-element DAG view of all memoised modules.
     *
     * Graph math lives in lib/depgraph.ts (language-variadic, reusable):
     * the full import graph (including non-memoised intermediaries) is
     * built there, reference-chain depths are computed there, and
     * genuine cycles are detected as strongly-connected components there.
     * Only memoised modules produce rows; walk order is the stable final
     * tiebreaker of the print (see compareDagGroups).
     *
     * Returns groups of:
     *   { owner, path, memos: string[], related: RelatedEntry[], cycles: number, depth: number }
     *
     * where RelatedEntry is { path, cycle: boolean }. `related` lists
     * only the memoised direct imports (for display, oldest memo first);
     * cycle is true only for edges inside a genuine SCC.
     */
    walkAll(): MemoDag {
        const allModules = this.modules();

        // Full import graph over every project module (memoised or not) —
        // transitive dependencies through non-memoised intermediaries count.
        const graph = buildImportGraph(allModules, this.langCache);
        for (const ext of graph.unsupported) {
            // Only extensions that SHOULD have support warn; .md/.json-style
            // modules are edge-less by design.
            if (Languages.isSupported(ext) && !this.warnedExt.has(ext)) {
                this.warnedExt.add(ext);
                console.error(
                    `memo: no language support loaded for ${ext} — modules of this type contribute no import edges`
                );
            }
        }

        const depths = computeChainDepths(
            allModules.map((m) => m.path),
            graph.importersOf
        );

        // Cycle membership: an import edge u → v is cyclic iff u and v sit
        // in the same strongly-connected component. Warnings follow the
        // memo policy: only cycles whose endpoints are ALL memoised.
        const sccs = stronglyConnectedComponents(
            allModules.map((m) => m.path),
            graph.importsOf
        );
        const sccIndexOf = new Map<string, number>();
        for (let i = 0; i < sccs.length; i++) {
            for (const member of sccs[i]) sccIndexOf.set(member, i);
        }
        const cycles: Array<{ path: string[] }> = [];
        for (const scc of sccs) {
            if (scc.every((member) => !!this.loadMemoFor(member))) {
                cycles.push({ path: [...scc, scc[0]] });
            }
        }

        const groups: MemoGroup[] = [];
        for (const mod of allModules) {
            // TODO(whole-object): pass the Module (mod) instead of mod.path — see §lib-classes
            const ownerMemo = this.loadMemoFor(mod.path);
            if (!ownerMemo) continue;

            const sccIndex = sccIndexOf.get(mod.path);
            const related: RelatedEntry[] = [];
            let nodeCycles = 0;
            for (const relPath of this._relatedMemos(mod)) {
                const relMod = allModules.find((m) => m.path === relPath);
                // TODO(whole-object): pass the Module (relMod, found one line above) instead of relPath — see §lib-classes
                const bothMemoised = !!relMod && !!this.loadMemoFor(relPath);
                const cyclic = sccIndex !== undefined && sccIndexOf.get(relPath) === sccIndex && bothMemoised;
                if (cyclic) nodeCycles++;
                related.push({ path: relPath, cycle: cyclic });
            }

            groups.push({
                owner: ownerMemo.owner,
                path: ownerMemo.path,
                memos: ownerMemo.content,
                lastModified: ownerMemo.lastModified || 0,
                related,
                cycles: nodeCycles,
                depth: depths.get(mod.path) ?? 0
            });
        }

        const dag = groups as MemoDag;
        dag.totalCycles = cycles.length;
        dag.cycles = cycles;
        return dag;
    }

    _moduleLastModified(modulePath: string): number {
        const file = rarebert.absPath(modulePath) + SUFFIX;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return typeof data.lastModified === 'number' ? data.lastModified : 0;
        } catch {
            return 0;
        }
    }
}

const memo = new Memory();

// ---------------------------------------------------------------------------
// Memo CLI command helpers (merged from lib/memo-cmd.ts)
// ---------------------------------------------------------------------------

export function printMemoAdded(rel: string): void {
    console.log(`${YELLOW_TICK} Memo added to ${rel}`);
}

/**
 * Split argv into a list of { flags: string[], positional: string[] } groups,
 * where each `--flag` starts a new group that consumes following positionals
 * until the next `--flag`. Non-flag positionals before any flag form a leading
 * group with an empty flags array.
 */
export function groupArgs(argv: string[]): Array<{ flags: string[]; positional: string[] }> {
    const groups: Array<{ flags: string[]; positional: string[] }> = [];
    let current: { flags: string[]; positional: string[] } = { flags: [], positional: [] };
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

export function printFlatMemos(entries: AllMemoEntry[]): boolean {
    if (entries.length === 0) {
        console.log('No memos found.');
        return false;
    }
    const flat: Array<{ path: string; content: string; lastModified: number }> = [];
    for (const { module, memos: contents, lastModified } of entries) {
        for (const content of contents) {
            flat.push({ path: module.path, content, lastModified });
        }
    }
    flat.sort((a, b) => a.lastModified - b.lastModified);
    for (const { path: p, content } of flat) {
        console.log(`${p} memos:`);
        console.log(`\t${renderMemoEntry(content)}`);
    }
    return true;
}

/**
 * Print the memo DAG, optionally filtered to a set of resolved module
 * descriptors. Rows are ordered by the spec comparator (reference-chain
 * depth deepest-first, then memo age oldest-first), so the last row
 * printed is always the youngest, least-referenced memo. When a set is
 * given, ancestors are emitted before the members that reference them.
 */
export function printDagForSet(resolvedSet: Array<{ rel: string }> | null): boolean {
    const groups = memo.walkAll();
    if (groups.length === 0) {
        console.log('No memos found.');
        return false;
    }

    const totalCycles = groups.totalCycles ?? 0;
    const cyclePaths = groups.cycles ?? [];
    // Empty array is NOT "no filter" — only null/undefined is. (An empty
    // set arg must not silently suppress every row.)
    const wanted = resolvedSet && resolvedSet.length ? new Set(resolvedSet.map((r) => r.rel)) : null;
    const byPath = new Map(groups.map((g) => [g.path, g]));
    const emitted = new Set<string>();
    let shown = 0;

    // Spec order: depth desc, then oldest first. `groups` (walk order)
    // is the stable final tiebreaker.
    const ordered = [...groups].sort(compareDagGroups);

    const emitGroup = (groupPath: string, indent: boolean): void => {
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
        const tsLabel = ts
            ? new Date(ts)
                .toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, 'Z')
            : 'unknown';
        console.log(`${prefix}  timestamp: ${tsLabel}`);
        console.log(`${prefix}  depth: ${g.depth}`);

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
            console.log(`${prefix}  ${DIM}└${g.path}${RESET} memo: ${renderMemoEntry(content)}`);
        }
    };

    if (wanted) {
        for (const { path } of ordered) {
            if (wanted.has(path)) emitGroup(path, false);
        }
    } else {
        for (const { path } of ordered) emitGroup(path, false);
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
export function parseIndices(arg: string, count: number): number[] | null {
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

    const indices: number[] = [];
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

export function applyDrop(
    resolved: { module: Module | null; rel: string; sidecar: string },
    selected: MemoContent[]
): void {
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
                {
                    name: resolved.module?.name ?? path.basename(resolved.rel),
                    content: remaining,
                    lastModified: Date.now()
                },
                null,
                2
            ) + '\n'
        );
    }
    console.log(`Dropped ${selected.length} memo(s) from ${resolved.rel}`);
}

export function cmdPrintSet(resolvedSet: Array<{ rel: string }>, withAncestors: boolean): boolean {
    if (withAncestors) {
        return printDagForSet(resolvedSet);
    }
    const setPaths = new Set(resolvedSet.map((r) => r.rel));
    const all = memo.loadAllMemos().filter((e) => setPaths.has(e.module.path));
    return printFlatMemos(all);
}

export function cmdPrintAll(withAncestors = false): boolean {
    if (withAncestors) {
        // null = no filter (an empty array would suppress every row).
        return printDagForSet(null);
    }
    return printFlatMemos(memo.loadAllMemos());
}

export async function cmdAdd(
    groups: Array<{ flags: string[]; positional: string[] }>,
    modules: Module[]
): Promise<void> {
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
        // TODO(whole-object): pass the ResolvedModule (resolved) instead of resolved.rel — see §lib-classes
        memo.remember(resolved.rel, content);
        printMemoAdded(resolved.rel);
    }
}

export function cmdLog(nonFlag: string[] = []): void {
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

export function cmdRecall(ref: string | undefined, nonFlag: string[] = []): void {
    if (!ref) {
        console.error('memo --recall: missing ref argument');
        return;
    }
    memo.restore(ref, nonFlag.length ? nonFlag : null);
    memo.clearBuffer();
}

export function cmdForget(moduleArgs: string[], modules: Module[]): void {
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
        // TODO(whole-object): pass the ResolvedModule (r) instead of r.rel — see §lib-classes
        memo.forgetByPath(r.rel);
        console.log(`${YELLOW_TICK} Forgot all memos for ${r.rel}`);
    }
}

/**
 * --oldest: print the most-forgotten memo — the one that would be printed
 * first by the DAG print (most deeply included module in the walk order,
 * oldest memo within it). Non-mutating.
 */
export function cmdOldest(): void {
    const oldest = memo.findOldestMemo();
    if (!oldest) {
        console.log('No memos found.');
        return;
    }
    const ts = oldest.lastModified
        ? new Date(oldest.lastModified)
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d+Z$/, 'Z')
        : 'unknown';
    console.log(`${BOLD}oldest memo — most deeply included module, first-printed:${RESET}`);
    console.log(`${DIM}  ${oldest.rel}  (timestamp: ${ts})${RESET}`);
    console.log(`  memo: ${renderMemoEntry(oldest.content)}`);
}

/**
 * --forget oldest: compute the whole-project DAG (same walk as --oldest)
 * and drop just the one memo that would be printed first. No module
 * reference required.
 */
export function cmdForgetOldest(): void {
    const oldest = memo.forgetOldest();
    if (!oldest) {
        console.log('No memos found.');
        return;
    }
    console.log(`${YELLOW_TICK} Forgot the oldest memo from ${oldest.rel}:`);
    console.log(`  ${renderMemoEntry(oldest.content)}`);
}

export { Memo, Memory, memo };
export default memo;
