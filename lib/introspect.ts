/**
 * lib/introspect.ts — the canonical introspection layer.
 *
 * Consolidates import resolution, binding extraction, dependency-graph
 * construction, per-declaration one-step resolution, whole-chain tracing,
 * and condensed source-map rendering into a single module. All language-
 * specific parsing is delegated through lib/languages.ts; this module
 * never branches on language name.
 *
 * JS-first: all rendering and default semantics assume ESM/JS declaration
 * shapes (const/function/class/export {}). Python and other languages
 * work to the extent their lang*.js primitives provide data; they are
 * never special-cased.
 *
 * Tool-manifest dispatch: language primitives can be functions (regex-
 * based, current shape) or tool-manifest objects describing an external
 * tool invocation (e.g. clang -ast-dump, rust-analyzer). invokePrimitive()
 * routes accordingly; runTool() handles spawning, caching (via the SQLite
 * store), and failure degradation.
 *
 * Public API:
 *   resolveImportPath(importerAbs, spec)
 *   introspectFile(absPath) -> Promise<FileIntrospection>
 *   buildGraph(seeds, opts) -> Promise<Graph>
 *   resolveClosure(seeds, opts) -> Promise<Set>
 *   resolveOneStep(decl, file, graph) -> { fromImports, fromDecls, unresolved }
 *   traceBinding(graph, qualifiedName) -> { chain, issues }
 *   formatFileSummary(file, { oneline }) -> string
 *   formatTrace(trace) -> string
 *   invokePrimitive(primitive, ctx) -> Promise<any>
 *   runTool(manifest, ctx) -> Promise<any>
 *
 * Back-comat re-exports:
 *   buildBindingGraph, resolveImportClosure, traceBinding (old shapes)
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { languages } from './runtime/Language.ts';
import { rarebert } from './runtime/Project.ts';
import { listAllModules } from './runtime/discovery.ts';
import type { Module } from './runtime/Module.ts';
import { store } from './runtime/core.ts';


// ─── Shared Types ─────────────────────────────────────────────

/** An import binding extracted from a file. */
export interface ImportRef {
    /** The imported binding name. */
    name: string;
    /** Local alias (same as `name` when not aliased). */
    localName: string;
    /** The import source specifier. */
    source: string;
    /** 1-indexed line number. */
    line: number;
    /** named | default | namespace | reexport | dynamic | sideeffect | star | relative */
    kind: string;
    /** Project-relative path of the resolved target, or null. */
    resolvedPath: string | null;
    /** The export name at the target, when resolvable. */
    resolvedExport: string | null;
}

/** A top-level declaration extracted from a file. */
export interface Declaration {
    /** Declaration name. */
    name: string;
    /** const | let | function | class | ... */
    kind: string;
    /** 1-indexed start line. */
    startLine: number;
    /** 1-indexed end line. */
    endLine: number;
    /** Source lines of the declaration. */
    lines: string[];
    /** Names this declaration references (1-step). */
    computedFrom: string[] | null;
    /** Whether the declaration is exported. */
    exported: boolean;
}

/** An export entry extracted from a file. */
export interface ExportRef {
    /** Export name. */
    name: string;
    /** named | default | reexport | type */
    type: string;
    /** 1-indexed line number. */
    line: number;
    /** Source specifier when this is a re-export. */
    reexportSource: string | null;
}

/** An issue found during introspection or tracing. */
export interface IntrospectionIssue {
    /** Issue category. */
    kind: string;
    /** File the issue belongs to, when known. */
    file?: string;
    /** Line the issue belongs to, when known. */
    line?: number | null;
    /** Human-readable description. */
    message: string;
}

/** The introspection result for one file. */
export interface FileIntrospection {
    /** Absolute path of the file. */
    path: string;
    /** Project-relative path. */
    relPath: string;
    /** File extension (without the leading dot). */
    ext: string;
    /** Imports found in the file. */
    imports: ImportRef[];
    /** Top-level declarations found in the file. */
    declarations: Declaration[];
    /** Exports found in the file. */
    exports: ExportRef[];
    /** Issues found during introspection. */
    issues: IntrospectionIssue[];
}

/** Export metadata as reported by a language primitive. */
export interface ExportInfo {
    /** Export name. */
    name?: string;
    /** named | default | reexport | type */
    type?: string;
    /** 1-indexed line number. */
    line?: number;
    /** Source specifier when this is a re-export. */
    source?: string;
}

/** Import metadata as reported by a language primitive. */
export interface ImportInfo {
    /** The imported binding name. */
    binding?: string;
    /** Local alias. */
    localName?: string;
    /** The import source specifier. */
    source: string;
    /** 1-indexed line number. */
    line?: number;
    /** Import kind. */
    kind?: string;
}

/** The bindings of one file: its exports, imports and source content. */
export interface FileBindings {
    /** Exports keyed by name. */
    exports: Record<string, ExportInfo>;
    /** Imports found in the file. */
    imports: ImportInfo[];
    /** The file's source content. */
    content?: string;
}

/** A module in the dependency graph (the runtime `Module` shape). */
export type GraphModule = Module;

/** The dependency graph of a project. */
export interface Graph {
    /** relPath -> module. */
    modules: Map<string, GraphModule>;
    /** relPath -> file introspection. */
    files: Map<string, FileIntrospection>;
    /** relPath -> bindings. */
    bindings: Map<string, FileBindings>;
    /** exportName -> producers. */
    byExport: Map<string, Array<{ module: string; type?: string; line?: number; source?: string }>>;
}

/** Context passed to a language primitive. */
export interface ToolContext {
    /** Absolute path of the file being introspected. */
    absPath: string;
    /** The file's source content. */
    content: string;
    /** Absolute path of the project root. */
    projectRoot: string;
    /** File extension (without the leading dot). */
    ext: string;
}

/** A tool manifest describing an external tool invocation. */
export interface ToolManifest {
    /** Cache namespace for this tool. */
    tool?: string;
    /** 'file' | 'project'. */
    scope?: string;
    /** Builds the full argv array. */
    command?: (ctx: ToolContext) => string[];
    /** Maps raw stdout to the rarebert binding/declaration shape. */
    parser?: (stdout: string, ctx: ToolContext) => unknown;
    /** Probe — false degrades to an empty result. */
    requires?: (ctx: ToolContext) => boolean;
    /** Cache invalidation key. */
    cacheKey?: (ctx: ToolContext) => string;
    /** Timeout in seconds (default 30). */
    timeout?: number;
    /** Optional stdin content. */
    stdin?: (ctx: ToolContext) => string | null;
}

/** A language primitive: either a function or a tool manifest. */
export type Primitive = ((content: string, absPath: string) => unknown) | ToolManifest;

/** One step of a dependency chain. */
export interface ChainStep {
    /** Project-relative path of the file. */
    file: string;
    /** The binding name at this step. */
    name: string;
    /** export | declaration | import | local-declaration | local-definition */
    kind: string;
    /** 1-indexed line number. */
    line?: number;
    /** Declaration kind, when known. */
    declKind?: string;
    /** Export type, when known. */
    type?: string;
    /** Import source specifier, when known. */
    source?: string;
    /** Resolved target path, when known. */
    resolvedPath?: string | null;
    /** Depth in the chain. */
    depth?: number;
}

/** The result of a one-step dependency resolution. */
export interface OneStepResult {
    /** Imports the declaration depends on. */
    fromImports: ImportRef[];
    /** Sibling declarations the declaration depends on. */
    fromDecls: Declaration[];
    /** Names referenced but not resolvable. */
    unresolved: string[];
}

/** The result of tracing a binding across the codebase. */
export interface TraceResult {
    /** The chain of steps. */
    chain: ChainStep[];
    /** Issues found along the way. */
    issues: IntrospectionIssue[];
}

// ─── Path Resolution ──────────────────────────────────────────

/**
 * Resolve a module spec from the perspective of `importerAbs` to an
 * absolute path on disk. Returns null for bare/external package specs
 * or unresolvable paths. Hoisted from bindings.ts.
 */
function resolveImportPath(importerAbs: string, spec: string): string | null {
    if (!spec.includes('/') && !spec.startsWith('.')) return null;

    const importerDir = path.dirname(importerAbs);
    const candidates = [
        spec,
        spec + '.ts',
        spec + '.mjs',
        spec + '.js',
        spec + '.py',
        path.join(spec, 'index.ts'),
        path.join(spec, 'index.js'),
        path.join(spec, 'index.py')
    ];

    for (const c of candidates) {
        const resolved = path.resolve(importerDir, c);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }
    }
    return null;
}

function extOf(filePath: string): string {
    return path.extname(filePath).slice(1);
}

function readSource(absPath: string): string | null {
    try {
        return fs.readFileSync(absPath, 'utf-8');
    } catch {
        return null;
    }
}

// ─── Tool Manifest Dispatch ────────────────────────────────────

/**
 * Context object passed to tool-manifest functions.
 * @typedef {Object} ToolContext
 * @property {string} absPath - absolute path to the file being introspected
 * @property {string} content - file source content
 * @property {string} projectRoot - absolute path to the project root
 * @property {string} ext - file extension (without leading dot)
 */

/**
 * Invoke a language primitive, whether it's a function or a tool manifest.
 * Returns the primitive's result, or null/empty if not provided.
 */
async function invokePrimitive(primitive: Primitive, ctx: ToolContext): Promise<any> {
    if (typeof primitive === 'function') {
        return primitive(ctx.content, ctx.absPath);
    }
    if (primitive && typeof primitive === 'object' && primitive.tool) {
        return runTool(primitive, ctx);
    }
    return null;
}

/**
 * Run an external tool per a tool manifest and return its parsed result.
 *
 * Manifest shape:
 *   { tool, scope, command, parser, requires, cacheKey, timeout, stdin }
 *
 * - `tool` (string): namespace for the cache table.
 * - `scope` ('file' | 'project'): file-scoped tools run once per file;
 *   project-scoped tools require explicit project mode (multiple files
 *   or buildGraph). Single-file analyze on a project-scoped manifest
 *   degrades with a stderr hint.
 * - `command(ctx) -> string[]`: returns the full argv array (first element
 *   is the binary). Never shell-interpolated; args are passed as an array.
 * - `parser(stdout, ctx) -> any`: custom function that maps raw stdout to
 *   the rarebert binding/declaration shape. Always custom (no built-in
 *   adapters shipped).
 * - `requires(ctx) -> boolean`: probe; false → degrade (empty result +
 *   stderr warning).
 * - `cacheKey(ctx) -> string`: invalidation key; if not provided, a default
 *   hash of command + absPath + mtime is used.
 * - `timeout` (number): seconds; default 30.
 * - `stdin(ctx) -> string | null`: optional stdin content.
 *
 * Failure semantics: tool failure never crashes analyze. On failure,
 * returns null and logs to stderr.
 */
async function runTool(manifest: ToolManifest, ctx: ToolContext): Promise<any> {
    const toolName = manifest.tool || 'unknown';
    const scope = manifest.scope || 'file';
    const timeoutMs = (manifest.timeout || 30) * 1000;

    if (scope === 'project') {
        console.error(
            `introspect: ${toolName} is project-scoped; ` +
            `run with multiple files or --graph for project-scoped tools.`
        );
        return null;
    }

    if (typeof manifest.requires === 'function') {
        try {
            if (!manifest.requires(ctx)) {
                console.error(
                    `introspect: ${toolName} unavailable for ${ctx.absPath}; ` +
                    `returning empty result.`
                );
                return null;
            }
        } catch (err) {
            console.error(
                `introspect: ${toolName} requires() probe failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return null;
        }
    }

    const cacheKey =
        typeof manifest.cacheKey === 'function'
            ? manifest.cacheKey(ctx)
            : defaultCacheKey(manifest, ctx);

    const cached = store.getIntrospectCache(toolName, cacheKey);
    if (cached && cached.parsed) {
        try {
            return JSON.parse(cached.parsed);
        } catch {
            // Cache entry corrupt — fall through and re-run.
        }
    }

    const command = typeof manifest.command === 'function' ? manifest.command(ctx) : null;
    if (!command || !Array.isArray(command) || command.length === 0) {
        console.error(`introspect: ${toolName} manifest has no valid command`);
        return null;
    }

    const [bin, ...args] = command;
    const stdinContent = typeof manifest.stdin === 'function' ? manifest.stdin(ctx) : null;
    const result = spawnSync(bin, args, {
        cwd: path.dirname(ctx.absPath),
        encoding: 'utf-8',
        stdio: [stdinContent ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        input: stdinContent || undefined,
        timeout: timeoutMs
    });

    if (result.error) {
        console.error(`introspect: ${toolName} failed to launch: ${result.error.message}`);
        return null;
    }
    if (result.status !== 0) {
        console.error(
            `introspect: ${toolName} exited with status ${result.status}` +
            (result.stderr ? `: ${result.stderr.slice(0, 200)}` : '')
        );
        return null;
    }
    if (result.signal === 'SIGTERM') {
        console.error(`introspect: ${toolName} timed out after ${timeoutMs / 1000}s`);
        return null;
    }

    const stdout = result.stdout || '';
    let parsed;
    try {
        parsed = typeof manifest.parser === 'function' ? manifest.parser(stdout, ctx) : null;
    } catch (err) {
        console.error(
            `introspect: ${toolName} parser failed: ${err instanceof Error ? err.message : String(err)}`
        );
        store.setIntrospectCache(toolName, cacheKey, ctx.absPath, stdout, null);
        return null;
    }

    const parsedJson = parsed ? JSON.stringify(parsed) : null;
    store.setIntrospectCache(toolName, cacheKey, ctx.absPath, stdout, parsedJson);

    return parsed;
}

function defaultCacheKey(manifest: ToolManifest, ctx: ToolContext): string {
    let mtime = '';
    try {
        mtime = fs.statSync(ctx.absPath).mtimeMs.toString();
    } catch {
        /* ignore */
    }
    const cmd = typeof manifest.command === 'function' ? manifest.command(ctx).join(' ') : '';
    return `${cmd}:${ctx.absPath}:${mtime}`;
}

// ─── Single-File Introspection ─────────────────────────────────

/**
 * @typedef {Object} ImportRef
 * @property {string} name - the imported binding name
 * @property {string} localName - local alias (same as name if not aliased)
 * @property {string} source - import source spec
 * @property {number} line - line number (1-indexed)
 * @property {string} kind - named | default | namespace | reexport | dynamic | sideeffect | star | relative
 * @property {string|null} resolvedPath - rarebert-relative path of target, or null
 * @property {string|null} resolvedExport - the export name at the target, if resolvable
 */

/**
 * @typedef {Object} Declaration
 * @property {string} name - declaration name
 * @property {string} kind - const | let | function | class | etc.
 * @property {number} startLine - 1-indexed
 * @property {number} endLine - 1-indexed
 * @property {string[]} lines - source lines of the declaration
 * @property {string[]|null} computedFrom - names this declaration references (1-step)
 * @property {boolean} exported - whether this declaration is exported (has an `export` prefix)
 */

/**
 * @typedef {Object} ExportRef
 * @property {string} name - export name
 * @property {string} type - named | default | reexport | type
 * @property {number} line - 1-indexed
 * @property {string|null} reexportSource - source if re-export
 */

/**
 * @typedef {Object} FileIntrospection
 * @property {string} path - absolute path
 * @property {string} relPath - rarebert-relative path
 * @property {string} ext - file extension
 * @property {ImportRef[]} imports
 * @property {Declaration[]} declarations
 * @property {ExportRef[]} exports
 * @property {Object[]} issues - any issues found during introspection
 */

/**
 * Introspect a single file: extract imports, declarations, and exports
 * using the language's primitives. Resolves import paths to rarebert-
 * relative paths. JS-first: assumes ESM/JS shapes; other languages
 * produce best-effort output from their primitives.
 *
 * @param {string} absPath - absolute path to the file
 * @returns {Promise<FileIntrospection>}
 */
async function introspectFile(absPath: string): Promise<FileIntrospection> {
    const ext = extOf(absPath);
    const content = readSource(absPath);
    const relPath = rarebert.relPath(absPath);
    const issues = [];

    if (content === null) {
        return {
            path: absPath,
            relPath,
            ext,
            imports: [],
            declarations: [],
            exports: [],
            issues: [{ kind: 'read-failed', message: 'could not read file' }]
        };
    }

    let lang;
    try {
        lang = await languages.loadLanguage(ext);
    } catch {
        lang = null;
    }

    const ctx = { absPath, content, projectRoot: rarebert.root, ext };

    // Extract bindings (exports + imports)
    let bindings: FileBindings = { exports: {}, imports: [] };
    if (lang) {
        try {
            const result = await invokePrimitive(lang.extractBindings, ctx);
            if (result) {
                bindings = result as FileBindings;
            }
        } catch (err) {
            issues.push({
                kind: 'extract-bindings-failed',
                message: err instanceof Error ? err.message : String(err)
            });
        }
    }

    // Extract all top-level declarations (exported or not)
    let members: Declaration[] = [];
    if (lang) {
        try {
            const result = await invokePrimitive(lang.extractTopLevelMembers, ctx);
            if (result && Array.isArray(result)) {
                members = result as Declaration[];
            }
        } catch (err) {
            issues.push({
                kind: 'extract-members-failed',
                message: err instanceof Error ? err.message : String(err)
            });
        }
    }

    // Build import refs with resolved paths
    const importRefs: ImportRef[] = (bindings.imports || []).map((imp: ImportInfo) => {
        const resolvedAbs = resolveImportPath(absPath, imp.source);
        const resolvedPath = resolvedAbs ? rarebert.relPath(resolvedAbs) : null;
        let resolvedExport = null;
        if (resolvedPath && imp.binding) {
            // We don't have the target's bindings here (that requires a graph);
            // resolvedExport is filled in buildGraph. For single-file introspect,
            // leave it null.
            resolvedExport = null;
        }
        return {
            name: imp.binding || imp.localName || '',
            localName: imp.localName || imp.binding || '',
            source: imp.source,
            line: imp.line ?? 0,
            kind: imp.kind || 'named',
            resolvedPath,
            resolvedExport
        };
    });

    // Build declarations from top-level members
    const declarations = members.map((m) => ({
        name: m.name,
        kind: m.kind || 'unknown',
        startLine: m.startLine,
        endLine: m.endLine,
        lines: m.lines || [],
        computedFrom: null,
        exported: m.exported ?? false
    }));

    // Build exports
    const exportRefs: ExportRef[] = Object.entries(bindings.exports || {}).map(
        ([name, info]: [string, ExportInfo]) => ({
            name,
            type: info.type || 'named',
            line: info.line || 0,
            reexportSource: info.source || null
        })
    );

    return {
        path: absPath,
        relPath,
        ext,
        imports: importRefs,
        declarations,
        exports: exportRefs,
        issues
    };
}

// ─── Graph Construction ─────────────────────────────────────────

/**
 * @typedef {Object} Graph
 * @property {Map<string, Object>} modules - relPath -> module object
 * @property {Map<string, FileIntrospection>} files - relPath -> FileIntrospection
 * @property {Map<string, Object>} bindings - relPath -> { exports, imports, content }
 * @property {Map<string, Array>} byExport - exportName -> [{ module, type, line, source }]
 */

/**
 * Build a dependency graph from seed modules. If codebaseScope is true,
 * resolves all modules in the project. Otherwise, walks the import tree
 * from the seeds.
 *
 * @param {Array} seeds - array of module paths (relPath or absPath)
 * @param {Object} opts - { codebaseScope: boolean }
 * @returns {Promise<Graph>}
 */
async function buildGraph(
    seeds: string[],
    opts: { codebaseScope?: boolean } = {}
): Promise<Graph> {
    const codebaseScope = opts.codebaseScope || false;

    let modules;
    if (codebaseScope) {
        modules = listAllModules();
    } else {
        const allModules = listAllModules();
        const allByPath = new Map(allModules.map((m) => [m.path, m]));
        const seedSet = new Set(seeds.map((s) => (path.isAbsolute(s) ? rarebert.relPath(s) : s)));
        // BFS import closure
        const closure = new Set<string>();
        const queue: GraphModule[] = [];
        for (const seed of seedSet) {
            const mod = allByPath.get(seed);
            if (mod) {
                closure.add(mod.path);
                queue.push(mod);
            }
        }
        const langCache = new Map();
        while (queue.length) {
            const mod = queue.shift();
            if (!mod) continue;
            const ext = path.extname(mod.abs).toLowerCase();
            let lang = langCache.get(ext);
            if (lang === undefined) {
                try {
                    lang = await languages.loadLanguage(ext);
                } catch {
                    lang = null;
                }
                langCache.set(ext, lang);
            }
            if (!lang) continue;
            let content;
            try {
                content = fs.readFileSync(mod.abs, 'utf-8');
            } catch {
                continue;
            }
            let b;
            try {
                b = lang.extractBindings(content);
            } catch {
                continue;
            }
            if (!b || !b.imports) continue;
            for (const imp of b.imports) {
                const targetAbs = resolveImportPath(mod.abs, imp.source);
                if (!targetAbs) continue;
                const targetRel = rarebert.relPath(targetAbs);
                if (closure.has(targetRel)) continue;
                const targetMod = allByPath.get(targetRel);
                if (targetMod) {
                    closure.add(targetRel);
                    queue.push(targetMod);
                }
            }
        }
        modules = allModules.filter((m) => closure.has(m.path));
    }

    const byPath = new Map<string, GraphModule>(modules.map((m) => [m.path, m]));
    const files = new Map<string, FileIntrospection>();
    const bindings = new Map<string, FileBindings>();
    const byExport = new Map<
        string,
        Array<{ module: string; type?: string; line?: number; source?: string }>
    >();
    const langCache = new Map<string, Awaited<ReturnType<typeof languages.loadLanguage>> | null>();

    for (const mod of modules) {
        const ext = path.extname(mod.abs).toLowerCase();
        let lang = langCache.get(ext);
        if (lang === undefined) {
            try {
                lang = await languages.loadLanguage(ext);
            } catch {
                lang = null;
            }
            langCache.set(ext, lang);
        }

        const fileIntrospection = await introspectFile(mod.abs);
        files.set(mod.path, fileIntrospection);

        let content;
        try {
            content = fs.readFileSync(mod.abs, 'utf-8');
        } catch {
            content = '';
        }

        let b: FileBindings | null = null;
        if (lang && typeof lang.extractBindings === 'function') {
            try {
                b = lang.extractBindings(content) as FileBindings;
            } catch {
                b = null;
            }
        }
        if (!b) {
            b = { exports: {}, imports: [] };
        }
        b.content = content;
        bindings.set(mod.path, b);

        for (const [name, info] of Object.entries(b.exports || {}) as Array<[string, ExportInfo]>) {
            if (!byExport.has(name)) byExport.set(name, []);
            byExport.get(name)!.push({
                module: mod.path,
                type: info.type,
                line: info.line,
                source: info.source
            });
        }
    }

    return { modules: byPath, files, bindings, byExport };
}

/**
 * Compute the transitive import closure from seed modules.
 * Back-comat with check.ts resolveImportClosure.
 */
async function resolveClosure(
    seeds: Array<{ path: string; rel: string }>,
    modules: GraphModule[]
): Promise<Set<string>> {
    const byPath = new Map<string, GraphModule>(modules.map((m) => [m.path, m]));
    const closure = new Set<string>();
    const queue: GraphModule[] = [];
    const langCache = new Map<string, Awaited<ReturnType<typeof languages.loadLanguage>> | null>();

    for (const seed of seeds) {
        const mod = byPath.get(seed.path) || byPath.get(seed.rel);
        if (mod) {
            closure.add(mod.path);
            queue.push(mod);
        }
    }

    while (queue.length) {
        const mod = queue.shift();
        if (!mod) continue;
        const ext = path.extname(mod.abs).toLowerCase();
        let lang = langCache.get(ext);
        if (lang === undefined) {
            try {
                lang = await languages.loadLanguage(ext);
            } catch {
                lang = null;
            }
            langCache.set(ext, lang);
        }
        if (!lang) continue;
        let content;
        try {
            content = fs.readFileSync(mod.abs, 'utf-8');
        } catch {
            continue;
        }
        let b;
        try {
            b = lang.extractBindings(content);
        } catch {
            continue;
        }
        if (!b || !b.imports) continue;
        for (const imp of b.imports) {
            const targetAbs = resolveImportPath(mod.abs, imp.source);
            if (!targetAbs) continue;
            const targetRel = rarebert.relPath(targetAbs);
            if (closure.has(targetRel)) continue;
            closure.add(targetRel);
            const target = byPath.get(targetRel);
            if (target) queue.push(target);
        }
    }
    return closure;
}

// ─── One-Step Resolution ──────────────────────────────────────

/**
 * Resolve one step of dependency: which imports and sibling declarations
 * a given declaration is computed from.
 *
 * @param {Declaration} decl
 * @param {FileIntrospection} file
 * @param {Graph} graph
 * @returns {{ fromImports: ImportRef[], fromDecls: Declaration[], unresolved: string[] }}
 */
async function resolveOneStep(
    decl: Declaration,
    file: FileIntrospection,
    graph: Graph
): Promise<OneStepResult> {
    if (!decl || !decl.lines) return { fromImports: [], fromDecls: [], unresolved: [] };

    // Build the set of known names: imports + sibling declarations
    const importNames = file.imports.map((imp) => imp.localName).filter(Boolean);
    const declNames = file.declarations.map((d) => d.name).filter((n) => n && n !== decl.name);
    const knownNames = [...new Set([...importNames, ...declNames])];

    if (knownNames.length === 0) {
        return { fromImports: [], fromDecls: [], unresolved: [] };
    }

    // Use the language's extractDeclarationReferences if available
    let referenced: string[] = [];
    try {
        referenced = await languages.extractDeclarationReferences(
            decl,
            file.imports.length > 0 ? (readSource(file.path) ?? '') : '',
            new Set(knownNames),
            file.ext
        );
    } catch {
        // Fallback: simple regex scan
        const body = decl.lines.join('\n');
        referenced = knownNames.filter((name) => {
            const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            return re.test(body);
        });
    }

    const fromImports = [];
    const fromDecls = [];
    const unresolved = [];

    for (const name of referenced) {
        const imp = file.imports.find((i) => i.localName === name);
        if (imp) {
            fromImports.push(imp);
            continue;
        }
        const siblingDecl = file.declarations.find((d) => d.name === name);
        if (siblingDecl) {
            fromDecls.push(siblingDecl);
            continue;
        }
        unresolved.push(name);
    }

    return { fromImports, fromDecls, unresolved };
}

// ─── Tracing ──────────────────────────────────────────────────

/**
 * Resolve a user-supplied module path against the graph's module map.
 * Handles short names like "languages" → "lib/languages.ts", bare
 * filenames like "languages.ts" → "lib/languages.ts", and full paths.
 */
function resolveModulePathInGraph(modPath: string, modules: Map<string, GraphModule>): string | null {
    if (modules.has(modPath)) return modPath;
    for (const key of modules.keys()) {
        const base = key.replace(/^.*\//, '');
        const stem = base.replace(/\.(mjs|js|ts|py)$/, '');
        if (
            modPath === base ||
            modPath === stem ||
            modPath === key.replace(/\.(mjs|js|ts|py)$/, '')
        ) {
            return key;
        }
    }
    return null;
}

/**
 * Trace a binding's full dependency chain across the codebase.
 * Walks imports AND assignment chains. Returns the chain and any issues
 * found along the way.
 *
 * @param {Graph} graph
 * @param {string} qualifiedName - "module::name" or just "name"
 * @returns {{ chain: Array, issues: Array }}
 */
async function traceBinding(graph: Graph, qualifiedName: string): Promise<TraceResult> {
    const t = new Trace(graph, qualifiedName);
    return t.forward();
}

class Trace {
    /** The graph being traced. */
    graph: Graph;
    /** relPath -> module. */
    modules: Map<string, GraphModule>;
    /** relPath -> bindings. */
    bindings: Map<string, FileBindings>;
    /** exportName -> producers. */
    byExport: Graph['byExport'];
    /** relPath -> file introspection. */
    files: Map<string, FileIntrospection>;
    /** The qualified name being traced. */
    qualifiedName: string;
    /** Issues found while tracing. */
    issues: IntrospectionIssue[];
    /** The chain of steps. */
    chain: ChainStep[];
    /** Visited keys, for cycle detection. */
    visited: Set<string>;
    /** The name path after the module qualifier. */
    namePath: string[];
    /** The binding name being traced. */
    targetName: string;
    /** The module the binding lives in. */
    targetModule: string | null;

    constructor(graph: Graph, qualifiedName: string) {
        this.graph = graph;
        this.modules = graph.modules;
        this.bindings = graph.bindings;
        this.byExport = graph.byExport;
        this.files = graph.files;
        this.qualifiedName = qualifiedName;
        this.issues = [];
        this.chain = [];
        this.visited = new Set();

        const parts = qualifiedName.split('::');
        this.namePath = parts.slice(1);
        this.targetName = this.namePath.length > 0 ? this.namePath[0] : qualifiedName;
        this.targetModule = null;

        if (qualifiedName.includes('::')) {
            this.targetModule = resolveModulePathInGraph(parts[0], this.modules);
        }
    }

    resolveTarget(): string | null {
        if (this.targetModule) return this.targetModule;
        const producers = this.byExport.get(this.targetName) || [];
        if (producers.length > 0) {
            this.targetModule = producers[0].module;
            return this.targetModule;
        }
        for (const [relPath, file] of this.files) {
            const decl = file.declarations.find((d) => d.name === this.targetName);
            if (decl) {
                this.targetModule = relPath;
                return this.targetModule;
            }
        }
        return null;
    }

    async forward(): Promise<TraceResult> {
        if (!this.targetModule) {
            this.targetModule = this.resolveTarget();
        }
        if (!this.targetModule) {
            this.issues.push({
                kind: 'unresolved-name',
                message: `"${this.targetName}" not found in any module`
            });
            return { chain: this.chain, issues: this.issues };
        }

        if (this.namePath.length <= 1) {
            await this._walk(this.targetModule, this.targetName, 0);
            return { chain: this.chain, issues: this.issues };
        }

        const targetModule = this.targetModule;
        const file = targetModule ? this.files.get(targetModule) : undefined;
        if (!file || !targetModule) {
            this.issues.push({
                kind: 'missing-module',
                file: targetModule ?? undefined,
                message: `module "${targetModule}" not in graph`
            });
            return { chain: this.chain, issues: this.issues };
        }

        const outerDecl = file.declarations.find((d) => d.name === this.namePath[0]);
        if (!outerDecl) {
            this.issues.push({
                kind: 'unresolved-name',
                file: targetModule,
                message: `"${this.namePath[0]}" not found as a declaration in "${targetModule}"`
            });
            return { chain: this.chain, issues: this.issues };
        }

        this.visited.add(`${targetModule}::${this.namePath[0]}`);
        this.chain.push({
            file: targetModule,
            name: this.namePath[0],
            kind: 'declaration',
            line: outerDecl.startLine,
            declKind: outerDecl.kind,
            depth: 0
        });

        const content = readSource(file.path);
        await this._walkLocal(targetModule, outerDecl, this.namePath.slice(1), 1, content);
        return { chain: this.chain, issues: this.issues };
    }

    async _walk(modPath: string, name: string, depth: number): Promise<void> {
        const key = `${modPath}::${name}`;
        if (this.visited.has(key)) {
            this.issues.push({
                kind: 'cycle',
                file: modPath,
                message: `cycle detected: ${key} already visited`
            });
            return;
        }
        this.visited.add(key);

        const b = this.bindings.get(modPath);
        const file = this.files.get(modPath);
        const mod = this.modules.get(modPath);

        if (!b && !file) {
            this.issues.push({
                kind: 'missing-module',
                file: modPath,
                message: `module "${modPath}" not in graph`
            });
            return;
        }

        if (file && file.issues && file.issues.length > 0) {
            for (const iss of file.issues) {
                this.issues.push({
                    kind: iss.kind,
                    file: modPath,
                    message: iss.message
                });
            }
        }

        if (b && b.exports && b.exports[name]) {
            const exportInfo = b.exports[name];
            this.chain.push({
                file: modPath,
                name,
                kind: 'export',
                line: exportInfo.line,
                type: exportInfo.type,
                depth
            });

            if (exportInfo.type === 'reexport' && exportInfo.source) {
                if (mod) {
                    const targetAbs = resolveImportPath(mod.abs, exportInfo.source);
                    if (targetAbs) {
                        const targetRel = rarebert.relPath(targetAbs);
                        await this._walk(targetRel, name, depth + 1);
                    } else {
                        this.issues.push({
                            kind: 'broken-import',
                            file: modPath,
                            message: `cannot resolve re-export source "${exportInfo.source}"`
                        });
                    }
                }
                return;
            }
        }

        if (file) {
            const decl = file.declarations.find((d) => d.name === name);
            if (decl) {
                this.chain.push({
                    file: modPath,
                    name,
                    kind: 'declaration',
                    line: decl.startLine,
                    declKind: decl.kind,
                    depth
                });

                const step = await resolveOneStep(decl, file, this.graph);

                for (const imp of step.fromImports) {
                    this.chain.push({
                        file: modPath,
                        name: imp.localName,
                        kind: 'import',
                        line: imp.line,
                        source: imp.source,
                        resolvedPath: imp.resolvedPath,
                        depth: depth + 1
                    });
                    if (imp.resolvedPath) {
                        await this._walk(imp.resolvedPath, imp.localName, depth + 2);
                    } else if (
                        imp.source &&
                        (imp.source.includes('/') || imp.source.startsWith('.'))
                    ) {
                        this.issues.push({
                            kind: 'broken-import',
                            file: modPath,
                            line: imp.line,
                            message: `cannot resolve import "${imp.source}"`
                        });
                    }
                }

                for (const siblingDecl of step.fromDecls) {
                    this.chain.push({
                        file: modPath,
                        name: siblingDecl.name,
                        kind: 'declaration',
                        line: siblingDecl.startLine,
                        declKind: siblingDecl.kind,
                        depth: depth + 1
                    });
                    const siblingStep = await resolveOneStep(siblingDecl, file, this.graph);
                    for (const imp of siblingStep.fromImports) {
                        this.chain.push({
                            file: modPath,
                            name: imp.localName,
                            kind: 'import',
                            line: imp.line,
                            source: imp.source,
                            resolvedPath: imp.resolvedPath,
                            depth: depth + 2
                        });
                        if (imp.resolvedPath) {
                            await this._walk(imp.resolvedPath, imp.localName, depth + 3);
                        }
                    }
                }

                for (const unresolved of step.unresolved) {
                    this.issues.push({
                        kind: 'unresolved-name',
                        file: modPath,
                        line: decl.startLine,
                        message: `"${unresolved}" referenced in ${name} but not found in imports or declarations`
                    });
                }
                return;
            }

            if (b && b.exports && b.exports[name] && b.exports[name].type !== 'reexport') {
                const content = readSource(file.path);
                if (content) {
                    const declMatch = content.match(
                        new RegExp(
                            `^(?:export\\s+)?(?:class|function|const|let|var)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
                            'm'
                        )
                    );
                    if (declMatch) {
                        const lineNum = content
                            .slice(0, content.indexOf(declMatch[0]))
                            .split('\n').length;
                        this.chain.push({
                            file: modPath,
                            name,
                            kind: 'declaration',
                            line: lineNum,
                            declKind: declMatch[0].match(/class/)
                                ? 'class'
                                : declMatch[0].match(/function/)
                                    ? 'function'
                                    : 'const',
                            depth
                        });
                        return;
                    }
                }
                this.chain.push({
                    file: modPath,
                    name,
                    kind: 'local-definition',
                    line: b.exports[name].line,
                    depth
                });
                return;
            }
        }

        if (b && b.imports) {
            const imp = b.imports.find((i) => i.localName === name || i.binding === name);
            if (imp) {
                this.chain.push({
                    file: modPath,
                    name,
                    kind: 'import',
                    line: imp.line,
                    source: imp.source,
                    depth
                });
                if (mod) {
                    const targetAbs = resolveImportPath(mod.abs, imp.source);
                    if (targetAbs) {
                        const targetRel = rarebert.relPath(targetAbs);
                        await this._walk(targetRel, imp.binding || name, depth + 1);
                    } else if (
                        imp.source &&
                        (imp.source.includes('/') || imp.source.startsWith('.'))
                    ) {
                        this.issues.push({
                            kind: 'broken-import',
                            file: modPath,
                            line: imp.line,
                            message: `cannot resolve "${imp.source}"`
                        });
                    }
                }
                return;
            }
        }

        this.issues.push({
            kind: 'unresolved-name',
            file: modPath,
            message: `"${name}" not found in "${modPath}"`
        });
    }

    async _walkLocal(
        modPath: string,
        parentDecl: Declaration,
        innerNames: string[],
        depth: number,
        content: string | null
    ): Promise<void> {
        const file = this.files.get(modPath);
        const name = innerNames[0];
        const isLast = innerNames.length === 1;

        if (!file) {
            this.issues.push({
                kind: 'missing-module',
                file: modPath,
                message: `module "${modPath}" not in graph`
            });
            return;
        }

        let lang;
        try {
            lang = await languages.loadLanguage(file.ext);
        } catch {
            lang = null;
        }
        if (!lang || typeof lang.extractLocalMembers !== 'function') {
            this.issues.push({
                kind: 'no-local-trace',
                file: modPath,
                message: `language "${file.ext}" does not support local member tracing`
            });
            return;
        }

        const locals = lang.extractLocalMembers(parentDecl, content ?? '');
        const local = locals.find((l) => l.name === name);
        if (!local) {
            this.issues.push({
                kind: 'unresolved-name',
                file: modPath,
                line: parentDecl.startLine,
                message: `"${name}" not found as a local declaration in "${parentDecl.name}" (${modPath}:${parentDecl.startLine})`
            });
            return;
        }

        const key = `${modPath}::${parentDecl.name}::${name}`;
        if (this.visited.has(key)) {
            this.issues.push({
                kind: 'cycle',
                file: modPath,
                message: `cycle detected: ${key} already visited`
            });
            return;
        }
        this.visited.add(key);

        this.chain.push({
            file: modPath,
            name,
            kind: 'local-declaration',
            declKind: local.kind,
            line: local.startLine,
            depth
        });

        if (!isLast) {
            await this._walkLocal(modPath, local, innerNames.slice(1), depth + 1, content);
            return;
        }

        const siblingLocals = locals.filter((l) => l.name !== name);
        const siblingNames = siblingLocals.map((l) => l.name);
        const importNames = file.imports.map((imp) => imp.localName).filter(Boolean);
        const topDeclNames = file.declarations
            .map((d) => d.name)
            .filter((n) => n && n !== parentDecl.name && n !== name);
        const knownNames = [...new Set([...siblingNames, ...importNames, ...topDeclNames])];

        const body = local.lines.join('\n');
        const referenced = knownNames.filter((nm) => {
            const re = new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            return re.test(body);
        });

        for (const refName of referenced) {
            const sibling = siblingLocals.find((l) => l.name === refName);
            if (sibling) {
                this.chain.push({
                    file: modPath,
                    name: refName,
                    kind: 'local-declaration',
                    declKind: sibling.kind,
                    line: sibling.startLine,
                    depth: depth + 1
                });
                continue;
            }
            const imp = file.imports.find((i) => i.localName === refName);
            if (imp) {
                this.chain.push({
                    file: modPath,
                    name: refName,
                    kind: 'import',
                    line: imp.line,
                    source: imp.source,
                    resolvedPath: imp.resolvedPath,
                    depth: depth + 1
                });
                if (imp.resolvedPath) {
                    const walkKey = `${imp.resolvedPath}::${imp.localName}`;
                    if (!this.visited.has(walkKey)) {
                        this.visited.add(walkKey);
                        await this._walk(imp.resolvedPath, imp.localName, depth + 2);
                    }
                }
                continue;
            }
            const topDecl = file.declarations.find((d) => d.name === refName);
            if (topDecl) {
                this.chain.push({
                    file: modPath,
                    name: refName,
                    kind: 'declaration',
                    line: topDecl.startLine,
                    declKind: topDecl.kind,
                    depth: depth + 1
                });
                const walkKey = `${modPath}::${refName}`;
                if (!this.visited.has(walkKey)) {
                    this.visited.add(walkKey);
                    await this._walk(modPath, refName, depth + 2);
                }
                continue;
            }
            this.issues.push({
                kind: 'unresolved-name',
                file: modPath,
                line: local.startLine,
                message: `"${refName}" referenced in local "${name}" but not found in locals, imports, or declarations`
            });
        }
    }

    usage(): {
        producers: Array<{ module: string; line?: number; type?: string; source?: string }>;
        consumers: Array<{ module: string; line?: number; via: string }>;
        reExportChains: Array<{ from: string; to: string; binding: string }>;
        references: Array<Record<string, unknown>>;
    } {
        const name = this.targetName;
        const producers: Array<{ module: string; line?: number; type?: string; source?: string }> = [];
        const consumers: Array<{ module: string; line?: number; via: string }> = [];
        const reExportChains: Array<{ from: string; to: string; binding: string }> = [];

        const visited = new Set<string>();
        const resolveProducer = (relPath: string, info: ExportInfo) => {
            const key = `${relPath}:${name}`;
            if (visited.has(key)) return;
            visited.add(key);
            if (info.type === 'reexport' && info.source) {
                const mod = this.modules.get(relPath);
                const targetRel = this._resolveImportSource(mod, info.source);
                if (!targetRel) {
                    producers.push({
                        module: relPath,
                        line: info.line,
                        type: 'reexport-orphan',
                        source: info.source
                    });
                    return;
                }
                reExportChains.push({ from: relPath, to: targetRel, binding: name });
                const target = this.bindings.get(targetRel);
                if (target && target.exports[name]) {
                    resolveProducer(targetRel, target.exports[name]);
                } else {
                    producers.push({
                        module: targetRel,
                        line: info.line,
                        type: 'unresolved-reexport'
                    });
                }
                return;
            }
            producers.push({ module: relPath, line: info.line, type: info.type });
        };

        const decls = this.byExport.get(name) || [];
        for (const decl of decls) {
            const b = this.bindings.get(decl.module);
            if (!b) continue;
            resolveProducer(decl.module, b.exports[name]);
        }

        const producerSet = new Set(producers.map((p) => p.module));
        const reachableCache = new Set();
        const isReachable = (relPath: string): boolean => {
            if (producerSet.has(relPath)) return true;
            if (reachableCache.has(relPath)) return false;
            reachableCache.add(relPath);
            for (const chain of reExportChains) {
                if (chain.from === relPath) {
                    if (isReachable(chain.to)) return true;
                }
            }
            return false;
        };

        for (const [relPath, b] of this.bindings) {
            const mod = this.modules.get(relPath);
            if (!mod) continue;
            for (const imp of b.imports) {
                const targetRel = this._resolveImportSource(mod, imp.source);
                if (!targetRel) continue;
                if (this.targetModule && targetRel !== this.targetModule) continue;
                if (imp.kind === 'named' && imp.binding === name) {
                    if (isReachable(targetRel)) {
                        consumers.push({ module: relPath, line: imp.line, via: imp.source });
                    }
                } else if (imp.kind === 'namespace' && imp.localName) {
                    const target = this.bindings.get(targetRel);
                    if (
                        target &&
                        (target.exports[name] ||
                            this.byExport.get(name)?.some((d) => d.module === targetRel))
                    ) {
                        consumers.push({
                            module: relPath,
                            line: imp.line,
                            via: `${imp.source} (as ${imp.localName}.${name})`
                        });
                    }
                }
            }
        }

        const references = [
            ...producers.map((p) => ({
                file: p.module,
                line: p.line,
                kind: 'producer',
                type: p.type
            })),
            ...consumers.map((c) => ({
                file: c.module,
                line: c.line,
                kind: 'consumer',
                via: c.via
            })),
            ...reExportChains.map((c) => ({ file: c.from, line: null, kind: 'reexport', to: c.to }))
        ];

        return { producers, consumers, reExportChains, references };
    }

    _resolveImportSource(mod: GraphModule | undefined, source: string): string | null {
        if (!mod) return null;
        const abs = resolveImportPath(mod.abs, source);
        if (!abs) return null;
        return rarebert.relPath(abs);
    }
}

// ─── Formatting ────────────────────────────────────────────────

/**
 * Format a file introspection as a condensed source map.
 *
 * Default (multi-line) format:
 *   module abc (lib/abc.ts):
 *     imports:
 *       {a}<-test                  L2  (named, ./test.ts)
 *     declarations (in source order, 1-step resolution):
 *       obj (const, L4-6)          <- {a}
 *     additional exports:
 *       obj                        L8  (named)
 *     summary: 1 import; 1 declaration; 1 export
 *
 * One-line (--oneline) format:
 *   module abc: {a}<-test;obj<-{a};1 import;1 declaration;1 export
 *
 * @param {FileIntrospection} file
 * @param {Object} opts - { oneline: boolean, oneStep: { fromImports, fromDecls } }
 * @returns {string}
 */
function formatFileSummary(
    file: FileIntrospection,
    opts: { oneline?: boolean; oneStepResults?: Record<string, OneStepResult> } = {}
): string {
    const { oneline = false, oneStepResults = {} } = opts;

    if (oneline) {
        return formatFileSummaryOneline(file, oneStepResults);
    }

    const lines = [];
    lines.push(`module ${file.relPath.replace(/\.(mjs|js|ts|py)$/, '')} (${file.relPath}):`);

    // Imports
    lines.push(`  imports:`);
    if (file.imports.length === 0) {
        lines.push(`    (none)`);
    } else {
        for (const imp of file.imports) {
            const resolved = imp.resolvedPath ? `  → ${imp.resolvedPath}` : '';
            lines.push(
                `    ${formatImportRef(imp).padEnd(28)} L${imp.line}  (${imp.kind}, ${imp.source})${resolved}`
            );
        }
    }

    // Declarations with 1-step resolution
    lines.push(`  declarations (in source order, 1-step resolution):`);
    if (file.declarations.length === 0) {
        lines.push(`    (none)`);
    } else {
        for (const decl of file.declarations) {
            const step = oneStepResults[decl.name];
            const fromStr = step ? formatOneStep(step) : '(unresolved)';
            const lineRange =
                decl.endLine > decl.startLine
                    ? `L${decl.startLine}-${decl.endLine}`
                    : `L${decl.startLine}`;
            const scopeTag = decl.exported === false ? ', local' : '';
            lines.push(
                `    ${decl.name} (${decl.kind}${scopeTag}, ${lineRange})`.padEnd(36) +
                ` <- ${fromStr}`
            );
        }
    }

    // Exports
    lines.push(`  exports:`);
    if (file.exports.length === 0) {
        lines.push(`    (none)`);
    } else {
        for (const exp of file.exports) {
            const decl = file.declarations.find((d) => d.name === exp.name);
            const imp = file.imports.find((i) => (i.localName || i.name || '') === exp.name);
            let info = '';
            if (imp) {
                info = ` <- {${imp.localName || imp.name}}<-${imp.source}`;
            } else if (decl) {
                const step = oneStepResults[decl.name];
                const fromStr = step ? formatOneStep(step) : '(literal)';
                info = ` <- ${fromStr}`;
            } else {
                info = ' <- (literal)';
            }
            lines.push(`    ${exp.name.padEnd(28)} L${exp.line}  (${exp.type})${info}`);
        }
    }

    // Summary
    const summaryParts = [
        `${file.imports.length} import${file.imports.length === 1 ? '' : 's'}`,
        `${file.declarations.length} declaration${file.declarations.length === 1 ? '' : 's'}`,
        `${file.exports.length} export${file.exports.length === 1 ? '' : 's'}`
    ];
    lines.push(`  summary: ${summaryParts.join('; ')}`);

    return lines.join('\n');
}

function formatFileSummaryOneline(
    file: FileIntrospection,
    oneStepResults: Record<string, OneStepResult> = {}
): string {
    const parts = [`module ${file.relPath.replace(/\.(mjs|js|ts|py)$/, '')}:`];

    // Import notation: {a}<-test
    const importStrs = file.imports.map((imp) => formatImportRef(imp));
    if (importStrs.length > 0) parts.push(importStrs.join(','));

    // Declaration notation: obj<-{a}
    const declStrs = file.declarations.map((decl) => {
        const step = oneStepResults[decl.name];
        const from = step ? formatOneStepShort(step) : '';
        return from ? `${decl.name}<-${from}` : decl.name;
    });
    if (declStrs.length > 0) parts.push(declStrs.join(';'));

    // Counts
    parts.push(`${file.imports.length} import`);
    parts.push(`${file.declarations.length} declaration`);
    parts.push(`${file.exports.length} export`);

    return parts.join(';');
}

function formatImportRef(imp: ImportRef): string {
    if (imp.kind === 'namespace' || imp.kind === 'star') {
        return imp.localName === imp.source ? `${imp.source}` : `${imp.localName}<-${imp.source}`;
    }
    if (imp.kind === 'default') {
        return `${imp.localName}<-${imp.source}`;
    }
    if (imp.kind === 'sideeffect') {
        return `${imp.source} (side-effect)`;
    }
    // named, relative, etc.
    return `{${imp.name}}<-${imp.source}`;
}

function formatOneStep(step: OneStepResult): string {
    const impStrs = step.fromImports.map((imp) => `{${imp.localName}}`);
    const declStrs = step.fromDecls.map((d) => d.name);
    const all = [...impStrs, ...declStrs];
    if (step.unresolved.length > 0) {
        all.push(`?${step.unresolved.join(',?')}`);
    }
    return all.length > 0 ? `{${all.join(',')}}` : '(literal)';
}

function formatOneStepShort(step: OneStepResult): string {
    const impStrs = step.fromImports.map((imp) => `{${imp.localName}}`);
    const declStrs = step.fromDecls.map((d) => d.name);
    const all = [...impStrs, ...declStrs];
    return all.length > 0 ? `{${all.join(',')}}` : '';
}

/**
 * Format a trace result as a human-readable chain printout.
 *
 * @param {{ chain: Array, issues: Array }} trace
 * @returns {string}
 */
function formatTrace(trace: TraceResult): string {
    const { chain, issues } = trace;
    const lines = [];

    if (chain.length === 0) {
        lines.push('(empty chain)');
    } else {
        for (const step of chain) {
            const indent = '  '.repeat(step.depth || 0);
            const fileStr = step.file.replace(/\.(mjs|js|ts|py)$/, '');
            let stepStr;
            if (step.kind === 'declaration') {
                stepStr = `${fileStr}::${step.name} (${step.declKind}, ${step.file}:${step.line})`;
            } else if (step.kind === 'local-declaration') {
                stepStr = `${fileStr}::${step.name} (local ${step.declKind}, ${step.file}:${step.line})`;
            } else if (step.kind === 'import') {
                stepStr = `${fileStr}::${step.name} (import, L${step.line}, from ${step.source})`;
                if (step.resolvedPath) {
                    stepStr += ` → ${step.resolvedPath}`;
                }
            } else if (step.kind === 'export') {
                stepStr = `${fileStr}::${step.name} (export, ${step.type}, L${step.line})`;
            } else {
                stepStr = `${fileStr}::${step.name} (${step.kind})`;
            }
            lines.push(`${indent}${stepStr}`);
        }
    }

    if (issues.length > 0) {
        lines.push('');
        lines.push(`issues (${issues.length}):`);
        for (const iss of issues) {
            const fileStr = iss.file ? `${iss.file}: ` : '';
            const lineStr = iss.line ? `L${iss.line}: ` : '';
            lines.push(`  [${iss.kind}] ${fileStr}${lineStr}${iss.message}`);
        }
    } else {
        lines.push('');
        lines.push('issues: 0');
    }

    return lines.join('\n');
}

// ─── Back-Compat Re-exports ────────────────────────────────────

/**
 * Back-compat wrapper for check.ts buildBindingGraph.
 * Takes an array of modules, returns { modules, bindings, byExport }.
 */
async function buildBindingGraph(modules: GraphModule[]): Promise<{
    modules: Map<string, GraphModule>;
    bindings: Map<string, FileBindings>;
    byExport: Graph['byExport'];
}> {
    const graph = await buildGraph(
        modules.map((m) => m.path),
        { codebaseScope: false }
    );
    // Adjust the modules map shape for back-compat: check.ts expects
    // modules as a Map of relPath -> module object (same shape).
    return {
        modules: graph.modules,
        bindings: graph.bindings,
        byExport: graph.byExport
    };
}

export {
    resolveImportPath,
    introspectFile,
    buildGraph,
    resolveClosure,
    resolveOneStep,
    traceBinding,
    Trace,
    formatFileSummary,
    formatTrace,
    invokePrimitive,
    runTool,
    buildBindingGraph,
    resolveClosure as resolveImportClosure
};
