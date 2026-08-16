/**
 * lib/introspect.mjs — the canonical introspection layer.
 *
 * Consolidates import resolution, binding extraction, dependency-graph
 * construction, per-declaration one-step resolution, whole-chain tracing,
 * and condensed source-map rendering into a single module. All language-
 * specific parsing is delegated through lib/languages.mjs; this module
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
import { languages } from './languages.mjs';
import { rarebert } from './projects.mjs';
import { listAllModules } from './module.mjs';
import { store } from './core.mjs';

// ─── Path Resolution ──────────────────────────────────────────

/**
 * Resolve a module spec from the perspective of `importerAbs` to an
 * absolute path on disk. Returns null for bare/external package specs
 * or unresolvable paths. Hoisted from bindings.mjs.
 */
function resolveImportPath(importerAbs, spec) {
    if (!spec.includes('/') && !spec.startsWith('.')) return null;

    const importerDir = path.dirname(importerAbs);
    const candidates = [
        spec,
        spec + '.mjs',
        spec + '.js',
        spec + '.py',
        path.join(spec, 'index.mjs'),
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

function extOf(filePath) {
    return path.extname(filePath).slice(1);
}

function readSource(absPath) {
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
async function invokePrimitive(primitive, ctx) {
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
async function runTool(manifest, ctx) {
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
            console.error(`introspect: ${toolName} requires() probe failed: ${err.message}`);
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
        console.error(`introspect: ${toolName} parser failed: ${err.message}`);
        store.setIntrospectCache(toolName, cacheKey, ctx.absPath, stdout, null);
        return null;
    }

    const parsedJson = parsed ? JSON.stringify(parsed) : null;
    store.setIntrospectCache(toolName, cacheKey, ctx.absPath, stdout, parsedJson);

    return parsed;
}

function defaultCacheKey(manifest, ctx) {
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
async function introspectFile(absPath) {
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
    let bindings = { exports: {}, imports: [] };
    if (lang) {
        try {
            const result = await invokePrimitive(lang.extractBindings, ctx);
            if (result) {
                bindings = result;
            }
        } catch (err) {
            issues.push({ kind: 'extract-bindings-failed', message: err.message });
        }
    }

    // Extract all top-level declarations (exported or not)
    let members = [];
    if (lang) {
        try {
            const result = await invokePrimitive(lang.extractTopLevelMembers, ctx);
            if (result && Array.isArray(result)) {
                members = result;
            }
        } catch (err) {
            issues.push({ kind: 'extract-members-failed', message: err.message });
        }
    }

    // Build import refs with resolved paths
    const importRefs = (bindings.imports || []).map((imp) => {
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
            line: imp.line,
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
    const exportRefs = Object.entries(bindings.exports || {}).map(([name, info]) => ({
        name,
        type: info.type || 'named',
        line: info.line || 0,
        reexportSource: info.source || null
    }));

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
async function buildGraph(seeds, opts = {}) {
    const codebaseScope = opts.codebaseScope || false;

    let modules;
    if (codebaseScope) {
        modules = listAllModules();
    } else {
        const allModules = listAllModules();
        const allByPath = new Map(allModules.map((m) => [m.path, m]));
        const seedSet = new Set(
            seeds.map((s) => (path.isAbsolute(s) ? rarebert.relPath(s) : s))
        );
        // BFS import closure
        const closure = new Set();
        const queue = [];
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

    const byPath = new Map(modules.map((m) => [m.path, m]));
    const files = new Map();
    const bindings = new Map();
    const byExport = new Map();
    const langCache = new Map();

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

        let b = null;
        if (lang && typeof lang.extractBindings === 'function') {
            try {
                b = lang.extractBindings(content);
            } catch {
                b = null;
            }
        }
        if (!b) {
            b = { exports: {}, imports: [] };
        }
        b.content = content;
        bindings.set(mod.path, b);

        for (const [name, info] of Object.entries(b.exports || {})) {
            if (!byExport.has(name)) byExport.set(name, []);
            byExport.get(name).push({
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
 * Back-comat with check.mjs resolveImportClosure.
 */
async function resolveClosure(seeds, modules) {
    const byPath = new Map(modules.map((m) => [m.path, m]));
    const closure = new Set();
    const queue = [];
    const langCache = new Map();

    for (const seed of seeds) {
        const mod = byPath.get(seed.path) || byPath.get(seed.rel);
        if (mod) {
            closure.add(mod.path);
            queue.push(mod);
        }
    }

    while (queue.length) {
        const mod = queue.shift();
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
async function resolveOneStep(decl, file, graph) {
    if (!decl || !decl.lines) return { fromImports: [], fromDecls: [], unresolved: [] };

    // Build the set of known names: imports + sibling declarations
    const importNames = file.imports.map((imp) => imp.localName).filter(Boolean);
    const declNames = file.declarations.map((d) => d.name).filter((n) => n && n !== decl.name);
    const knownNames = [...new Set([...importNames, ...declNames])];

    if (knownNames.length === 0) {
        return { fromImports: [], fromDecls: [], unresolved: [] };
    }

    // Use the language's extractDeclarationReferences if available
    let referenced = [];
    try {
        referenced = await languages.extractDeclarationReferences(
            decl,
            file.imports.length > 0 ? readSource(file.path) : '',
            knownNames,
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
 * Handles short names like "languages" → "lib/languages.mjs", bare
 * filenames like "languages.mjs" → "lib/languages.mjs", and full paths.
 */
function resolveModulePathInGraph(modPath, modules) {
    if (modules.has(modPath)) return modPath;
    for (const key of modules.keys()) {
        const base = key.replace(/^.*\//, '');
        const stem = base.replace(/\.(mjs|js|ts|py)$/, '');
        if (modPath === base || modPath === stem || modPath === key.replace(/\.(mjs|js|ts|py)$/, '')) {
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
async function traceBinding(graph, qualifiedName) {
    const { modules, bindings, byExport, files } = graph;
    const issues = [];
    const chain = [];

    let targetModule = null;
    const parts = qualifiedName.split('::');
    const namePath = parts.slice(1);
    const targetName = namePath.length > 0 ? namePath[0] : qualifiedName;

    if (qualifiedName.includes('::')) {
        const modPath = parts[0];
        // Try to resolve the module path — it might be a short name like
        // "languages" rather than the full "lib/languages.mjs" path.
        targetModule = resolveModulePathInGraph(modPath, modules);
    }

    // If no module specified, find first module that exports this name
    if (!targetModule) {
        const producers = byExport.get(targetName) || [];
        if (producers.length > 0) {
            targetModule = producers[0].module;
        } else {
            // Search all files' declarations
            for (const [relPath, file] of files) {
                const decl = file.declarations.find((d) => d.name === targetName);
                if (decl) {
                    targetModule = relPath;
                    break;
                }
            }
        }
    }

    if (!targetModule) {
        issues.push({
            kind: 'unresolved-name',
            message: `"${targetName}" not found in any module`
        });
        return { chain, issues };
    }

    // Walk the chain
    const visited = new Set();
    const walk = async (modPath, name, depth) => {
        const key = `${modPath}::${name}`;
        if (visited.has(key)) {
            issues.push({
                kind: 'cycle',
                file: modPath,
                message: `cycle detected: ${key} already visited`
            });
            return;
        }
        visited.add(key);

        const b = bindings.get(modPath);
        const file = files.get(modPath);
        const mod = modules.get(modPath);

        if (!b && !file) {
            issues.push({
                kind: 'missing-module',
                file: modPath,
                message: `module "${modPath}" not in graph`
            });
            return;
        }

        // Check for syntax issues in this file
        if (file && file.issues && file.issues.length > 0) {
            for (const iss of file.issues) {
                issues.push({
                    kind: iss.kind,
                    file: modPath,
                    message: iss.message
                });
            }
        }

        // Check if this name is exported from this module
        if (b && b.exports && b.exports[name]) {
            const exportInfo = b.exports[name];
            chain.push({
                file: modPath,
                name,
                kind: 'export',
                line: exportInfo.line,
                type: exportInfo.type,
                depth
            });

            // If re-export, follow the source
            if (exportInfo.type === 'reexport' && exportInfo.source) {
                if (mod) {
                    const targetAbs = resolveImportPath(mod.abs, exportInfo.source);
                    if (targetAbs) {
                        const targetRel = rarebert.relPath(targetAbs);
                        await walk(targetRel, name, depth + 1);
                    } else {
                        issues.push({
                            kind: 'broken-import',
                            file: modPath,
                            message: `cannot resolve re-export source "${exportInfo.source}"`
                        });
                    }
                }
                return;
            }
        }

        // Check if this name is a declaration in this file
        if (file) {
            const decl = file.declarations.find((d) => d.name === name);
            if (decl) {
                chain.push({
                    file: modPath,
                    name,
                    kind: 'declaration',
                    line: decl.startLine,
                    declKind: decl.kind,
                    depth
                });

                // Resolve one step: what does this declaration depend on?
                const step = await resolveOneStep(decl, file, graph);

                // Follow imports
                for (const imp of step.fromImports) {
                    chain.push({
                        file: modPath,
                        name: imp.localName,
                        kind: 'import',
                        line: imp.line,
                        source: imp.source,
                        resolvedPath: imp.resolvedPath,
                        depth: depth + 1
                    });

                    if (imp.resolvedPath) {
                        await walk(imp.resolvedPath, imp.binding || imp.localName, depth + 2);
                    } else if (imp.source && (imp.source.includes('/') || imp.source.startsWith('.'))) {
                        issues.push({
                            kind: 'broken-import',
                            file: modPath,
                            line: imp.line,
                            message: `cannot resolve import "${imp.source}"`
                        });
                    }
                }

                // Follow sibling declarations (one level only to avoid deep recursion)
                for (const siblingDecl of step.fromDecls) {
                    chain.push({
                        file: modPath,
                        name: siblingDecl.name,
                        kind: 'declaration',
                        line: siblingDecl.startLine,
                        declKind: siblingDecl.kind,
                        depth: depth + 1
                    });
                    // Resolve one more step for siblings
                    const siblingStep = await resolveOneStep(siblingDecl, file, graph);
                    for (const imp of siblingStep.fromImports) {
                        chain.push({
                            file: modPath,
                            name: imp.localName,
                            kind: 'import',
                            line: imp.line,
                            source: imp.source,
                            resolvedPath: imp.resolvedPath,
                            depth: depth + 2
                        });
                        if (imp.resolvedPath) {
                            await walk(imp.resolvedPath, imp.binding || imp.localName, depth + 3);
                        }
                    }
                }

                // Flag unresolved names
                for (const unresolved of step.unresolved) {
                    issues.push({
                        kind: 'unresolved-name',
                        file: modPath,
                        line: decl.startLine,
                        message: `"${unresolved}" referenced in ${name} but not found in imports or declarations`
                    });
                }

                return;
            }

            // Fallback: if we found the name as a local export but
            // extractPublicMembers didn't capture the declaration (e.g.
            // `class Foo {}` exported via `export { Foo }` at the bottom),
            // scan the file content for the declaration pattern.
            if (b && b.exports && b.exports[name] && b.exports[name].type !== 'reexport') {
                const content = readSource(file.path);
                if (content) {
                    const declMatch = content.match(
                        new RegExp(`^(?:export\\s+)?(?:class|function|const|let|var)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm')
                    );
                    if (declMatch) {
                        const lineNum = content.slice(0, content.indexOf(declMatch[0])).split('\n').length;
                        chain.push({
                            file: modPath,
                            name,
                            kind: 'declaration',
                            line: lineNum,
                            declKind: declMatch[0].match(/class/) ? 'class' :
                                       declMatch[0].match(/function/) ? 'function' : 'const',
                            depth
                        });
                        // We can't easily resolve one-step dependencies without
                        // the full declaration lines from extractPublicMembers.
                        // Mark as a local definition — the chain ends here.
                        return;
                    }
                }
                // Export exists but declaration not found in content —
                // it's a local definition we can't trace further.
                chain.push({
                    file: modPath,
                    name,
                    kind: 'local-definition',
                    line: b.exports[name].line,
                    depth
                });
                return;
            }
        }

        // Not an export and not a declaration — check if it's imported
        if (b && b.imports) {
            const imp = b.imports.find((i) => i.localName === name || i.binding === name);
            if (imp) {
                chain.push({
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
                        await walk(targetRel, imp.binding || name, depth + 1);
                    } else if (imp.source && (imp.source.includes('/') || imp.source.startsWith('.'))) {
                        issues.push({
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

        // Not found in this module
        issues.push({
            kind: 'unresolved-name',
            file: modPath,
            message: `"${name}" not found in "${modPath}"`
        });
    };

    const walkLocal = async (modPath, parentDecl, innerNames, depth, content) => {
        const file = files.get(modPath);
        const name = innerNames[0];
        const isLast = innerNames.length === 1;

        let lang;
        try {
            lang = await languages.loadLanguage(file.ext);
        } catch {
            lang = null;
        }
        if (!lang || typeof lang.extractLocalMembers !== 'function') {
            issues.push({
                kind: 'no-local-trace',
                file: modPath,
                message: `language "${file.ext}" does not support local member tracing`
            });
            return;
        }

        const locals = lang.extractLocalMembers(parentDecl, content);
        const local = locals.find((l) => l.name === name);
        if (!local) {
            issues.push({
                kind: 'unresolved-name',
                file: modPath,
                line: parentDecl.startLine,
                message: `"${name}" not found as a local declaration in "${parentDecl.name}" (${modPath}:${parentDecl.startLine})`
            });
            return;
        }

        const key = `${modPath}::${parentDecl.name}::${name}`;
        if (visited.has(key)) {
            issues.push({
                kind: 'cycle',
                file: modPath,
                message: `cycle detected: ${key} already visited`
            });
            return;
        }
        visited.add(key);

        chain.push({
            file: modPath,
            name,
            kind: 'local-declaration',
            declKind: local.kind,
            line: local.startLine,
            depth
        });

        if (!isLast) {
            await walkLocal(modPath, local, innerNames.slice(1), depth + 1, content);
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
                chain.push({
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
                chain.push({
                    file: modPath,
                    name: refName,
                    kind: 'import',
                    line: imp.line,
                    source: imp.source,
                    resolvedPath: imp.resolvedPath,
                    depth: depth + 1
                });
                if (imp.resolvedPath) {
                    const walkKey = `${imp.resolvedPath}::${imp.binding || imp.localName}`;
                    if (!visited.has(walkKey)) {
                        visited.add(walkKey);
                        await walk(imp.resolvedPath, imp.binding || imp.localName, depth + 2);
                    }
                }
                continue;
            }
            const topDecl = file.declarations.find((d) => d.name === refName);
            if (topDecl) {
                chain.push({
                    file: modPath,
                    name: refName,
                    kind: 'declaration',
                    line: topDecl.startLine,
                    declKind: topDecl.kind,
                    depth: depth + 1
                });
                const walkKey = `${modPath}::${refName}`;
                if (!visited.has(walkKey)) {
                    visited.add(walkKey);
                    await walk(modPath, refName, depth + 2);
                }
                continue;
            }
            issues.push({
                kind: 'unresolved-name',
                file: modPath,
                line: local.startLine,
                message: `"${refName}" referenced in local "${name}" but not found in locals, imports, or declarations`
            });
        }
    };

    if (namePath.length <= 1) {
        await walk(targetModule, targetName, 0);
        return { chain, issues };
    }

    const file = files.get(targetModule);
    if (!file) {
        issues.push({
            kind: 'missing-module',
            file: targetModule,
            message: `module "${targetModule}" not in graph`
        });
        return { chain, issues };
    }

    const outerDecl = file.declarations.find((d) => d.name === namePath[0]);
    if (!outerDecl) {
        issues.push({
            kind: 'unresolved-name',
            file: targetModule,
            message: `"${namePath[0]}" not found as a declaration in "${targetModule}"`
        });
        return { chain, issues };
    }

    visited.add(`${targetModule}::${namePath[0]}`);
    chain.push({
        file: targetModule,
        name: namePath[0],
        kind: 'declaration',
        line: outerDecl.startLine,
        declKind: outerDecl.kind,
        depth: 0
    });

    const content = readSource(file.path);
    await walkLocal(targetModule, outerDecl, namePath.slice(1), 1, content);
    return { chain, issues };
}

// ─── Formatting ────────────────────────────────────────────────

/**
 * Format a file introspection as a condensed source map.
 *
 * Default (multi-line) format:
 *   module abc (lib/abc.mjs):
 *     imports:
 *       {a}<-test                  L2  (named, ./test.mjs)
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
function formatFileSummary(file, opts = {}) {
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
            const lineRange = decl.endLine > decl.startLine ? `L${decl.startLine}-${decl.endLine}` : `L${decl.startLine}`;
            const scopeTag = decl.exported === false ? ', local' : '';
            lines.push(`    ${decl.name} (${decl.kind}${scopeTag}, ${lineRange})`.padEnd(36) + ` <- ${fromStr}`);
        }
    }

    // Exports
    lines.push(`  exports:`);
    if (file.exports.length === 0) {
        lines.push(`    (none)`);
    } else {
        for (const exp of file.exports) {
            const decl = file.declarations.find((d) => d.name === exp.name);
            const imp = file.imports.find((i) => (i.localName || i.binding || '') === exp.name);
            let info = '';
            if (imp) {
                info = ` <- {${imp.localName || imp.binding}}<-${imp.source}`;
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

function formatFileSummaryOneline(file, oneStepResults = {}) {
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

function formatImportRef(imp) {
    if (imp.kind === 'namespace' || imp.kind === 'star') {
        return imp.localName === imp.source
            ? `${imp.source}`
            : `${imp.localName}<-${imp.source}`;
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

function formatOneStep(step) {
    const impStrs = step.fromImports.map((imp) => `{${imp.localName}}`);
    const declStrs = step.fromDecls.map((d) => d.name);
    const all = [...impStrs, ...declStrs];
    if (step.unresolved.length > 0) {
        all.push(`?${step.unresolved.join(',?')}`);
    }
    return all.length > 0 ? `{${all.join(',')}}` : '(literal)';
}

function formatOneStepShort(step) {
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
function formatTrace(trace) {
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
 * Back-compat wrapper for check.mjs buildBindingGraph.
 * Takes an array of modules, returns { modules, bindings, byExport }.
 */
async function buildBindingGraph(modules) {
    const graph = await buildGraph(modules.map((m) => m.path), { codebaseScope: false });
    // Adjust the modules map shape for back-compat: check.mjs expects
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
    formatFileSummary,
    formatTrace,
    invokePrimitive,
    runTool,
    buildBindingGraph,
    resolveClosure as resolveImportClosure
};