#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { rarebert } from '../lib/runtime/Project.ts';
import { exit } from '../lib/runtime/core.ts';
import { listAllModules } from '../lib/runtime/discovery.ts';
import { CLI, defineMeta } from '../lib/runtime/CLI.ts';
import { resolveModuleSet } from '../lib/runtime/discovery.ts';
import { memo, printDagForSet } from '../lib/memo.ts';
import { YELLOW_STAR, YELLOW, BOLD, RESET } from '../lib/supports/symbols.ts';
import { languages } from '../lib/runtime/Language.ts';
import { buildBindingGraph, resolveClosure } from '../lib/introspect.ts';
import type { Graph, ExportInfo, ImportInfo, FileBindings } from '../lib/introspect.ts';
import type { Module } from '../lib/runtime/Module.ts';
import type { Language } from '../lib/runtime/Language.ts';

// REQUEST: check module performs syntax and integrity checks. On ctrl-c:
// - No cleanup needed; just return exit 0 (cancelled)
// Meta suggestion: { retryOnFailure: false, cleanup: 'none' }

const JS_CHECKABLE = new Set(['.ts', '.mjs', '.js']);



/** A producer of a traced binding. */
interface TraceProducer {
    /** The module that exports the binding. */
    module: string;
    /** The 1-indexed line of the export. */
    line?: number;
    /** The export type. */
    type?: string;
    /** The re-export source, when applicable. */
    source?: string;
}

/** A consumer of a traced binding. */
interface TraceConsumer {
    /** The module that imports the binding. */
    module: string;
    /** The 1-indexed line of the import. */
    line?: number;
    /** How the binding is referenced. */
    via: string;
}

/** A re-export chain between two modules. */
interface TraceReExport {
    /** The module the re-export starts at. */
    from: string;
    /** The module the re-export points to. */
    to: string;
    /** The binding being re-exported. */
    binding: string;
}

/** The result of the local traceBinding() implementation. */
interface LocalTraceResult {
    /** The modules that export the binding. */
    producers: TraceProducer[];
    /** The modules that import the binding. */
    consumers: TraceConsumer[];
    /** The re-export chains. */
    reExportChains: TraceReExport[];
}

/** A syntax-check location reported by the transpiler. */
interface CheckLocation {
    /** The 1-indexed line, or '?' when unknown. */
    line: string;
    /** The error message. */
    message: string;
}

/** The result of a syntax check on one file. */
interface CheckResult {
    /** Whether the file passed (or was skipped). */
    ok: boolean;
    /** Whether the check was skipped (unsupported extension). */
    skipped: boolean;
    /** The reported error locations. */
    locations: CheckLocation[];
}

/** A reference to an identifier found in a file's source. */
interface HeadReference {
    /** The identifier. */
    name: string;
    /** The 1-indexed line the reference appears on. */
    line: number;
}

/** An integrity issue found by the checks. */
interface IntegrityIssue {
    /** The issue category. */
    kind: string;
    /** The module the issue was found in. */
    module: string;
    /** The 1-indexed line, when known. */
    line?: number;
    /** The binding the issue concerns, when known. */
    binding?: string;
    /** A human-readable description. */
    detail: string;
}

function runNodeCheck(filePath: string): CheckResult {
    const ext = path.extname(filePath).toLowerCase();
    if (!JS_CHECKABLE.has(ext)) return { ok: true, skipped: true, locations: [] };

    // Syntax-only check via the transpiler — NEVER executes the module.
    // Spawning `bun --check <file>` is not a real syntax check: bun runs
    // the file, supportsDirectRunning fires, and the module's main can
    // execute (e.g. a network probe) — hanging the whole sweep.
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        return {
            ok: false,
            skipped: false,
            locations: [
                {
                    line: '?',
                    message: `cannot read file: ${err instanceof Error ? err.message : String(err)}`
                }
            ]
        };
    }
    const loader = ext === '.ts' ? 'ts' : 'js';
    try {
        new Bun.Transpiler({ loader }).transformSync(content);
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const lineMatch = /:(\d+)(?::\d+)?(?:$|\s)/.exec(raw);
        const message = raw.split(/\r?\n/)[0]?.trim() || 'syntax error';
        return {
            ok: false,
            skipped: false,
            locations: [{ line: lineMatch ? lineMatch[1] : '?', message }]
        };
    }
    return { ok: true, skipped: false, locations: [] };
}

function readBindings(
    mod: Module,
    lang: Language | null
): { exports: Record<string, ExportInfo>; imports: ImportInfo[]; content: string } | null {
    let content;
    try {
        content = fs.readFileSync(mod.abs, 'utf-8');
    } catch {
        return null;
    }
    if (!lang || typeof lang.extractBindings !== 'function') return null;
    let bindings;
    try {
        bindings = lang.extractBindings(content);
    } catch {
        return null;
    }
    if (!bindings) return null;
    return { exports: bindings.exports || {}, imports: bindings.imports || [], content };
}

function resolveImportSource(mod: Module, source: string | undefined): string | null {
    if (!source) return null;
    if (!source.includes('/') && !source.startsWith('.')) return null;
    // node: builtins (including subpaths like node:assert/strict) never
    // resolve to a project file.
    if (source.startsWith('node:')) return null;
    const importerDir = path.dirname(mod.abs);
    let resolved;
    try {
        resolved = path.resolve(importerDir, source);
    } catch {
        return null;
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return rarebert.relPath(resolved);
    }
    for (const candidate of [resolved + '.ts', resolved + '.mjs', resolved + '.js']) {
        if (fs.existsSync(candidate)) return rarebert.relPath(candidate);
    }
    return null;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Undefined-reference detection ─────────────────────────────
//
// `node --check` only validates syntax, so a reference to a name that
// was never declared nor imported (e.g. a refactor that removed a
// singleton but left call sites) passes the syntax pass yet crashes at
// runtime. This pass flags such references for JS-family modules.
//
// Approach (regex-based, best-effort):
//   1. Strip comments, string/template literals AND regex literals
//      (preserving line numbers) via a char-level tokenizer, so
//      identifiers inside them don't count as references. Handling
//      regex literals is essential — `\w`, `\s`, and `['"]` inside a
//      pattern would otherwise leak into the scan.
//   2. Build a coarse per-file set of "bound" names: imports, all
//      top-level declarations, every const/let/var (incl.
//      destructuring), function/class names, function/arrow/method
//      parameters, for/of and catch bindings.
//   3. Scan for identifiers in "head position" — `NAME(` or `NAME.`
//      not preceded by `.` (so property accesses and object-literal
//      keys are excluded). This is the high-signal shape of a value
//      reference; bare-value usage is intentionally not flagged to
//      keep false positives down.
//   4. Any head reference not in bound names ∪ globals whitelist is
//      reported as `undefined-reference`.

const REGEX_KEYWORDS = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'do',
    'else',
    'case',
    'new',
    'delete',
    'void',
    'throw',
    'yield',
    'await',
    'if',
    'for',
    'while',
    'switch',
    'with',
    'try',
    'catch',
    'finally',
    'function',
    'class',
    'extends',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
    'static',
    'let',
    'const',
    'var',
    'export',
    'import',
    'default',
    'async',
    'enum',
    'as',
    'from'
]);

function stripForScan(content: string): string {
    const n = content.length;
    const out: string[] = [];
    let i = 0;
    let prevKind = 'start'; // 'start' | 'value' | 'op' — last significant token
    let currentWord = '';

    const finishWord = () => {
        if (currentWord) {
            prevKind = REGEX_KEYWORDS.has(currentWord) ? 'op' : 'value';
            currentWord = '';
        }
    };

    while (i < n) {
        const ch = content[i];
        const next = content[i + 1];

        if (ch === '/' && next === '/') {
            let j = i + 2;
            while (j < n && content[j] !== '\n') j++;
            for (let k = i; k < j; k++) out.push(' ');
            i = j;
            continue;
        }
        if (ch === '/' && next === '*') {
            let j = i + 2;
            while (j < n && !(content[j] === '*' && content[j + 1] === '/')) j++;
            const end = j < n ? j + 2 : n;
            for (let k = i; k < end; k++) out.push(content[k] === '\n' ? '\n' : ' ');
            i = end;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            finishWord();
            const quote = ch;
            out.push(' ');
            let j = i + 1;
            while (j < n) {
                const c = content[j];
                if (c === '\\' && j + 1 < n) {
                    out.push(content[j + 1] === '\n' ? '\n' : ' ');
                    out.push(' ');
                    j += 2;
                    continue;
                }
                if (c === quote) {
                    out.push(' ');
                    j++;
                    break;
                }
                if (quote !== '`' && c === '\n') break;
                out.push(c === '\n' ? '\n' : ' ');
                j++;
            }
            i = j;
            prevKind = 'value';
            continue;
        }
        if (ch === '/' && next !== '/' && next !== '*') {
            finishWord();
            if (prevKind === 'start' || prevKind === 'op') {
                out.push(' ');
                let j = i + 1;
                let inClass = false;
                while (j < n) {
                    const c = content[j];
                    if (c === '\\' && j + 1 < n) {
                        out.push(content[j + 1] === '\n' ? '\n' : ' ');
                        out.push(' ');
                        j += 2;
                        continue;
                    }
                    if (c === '[') inClass = true;
                    else if (c === ']') inClass = false;
                    else if (c === '/' && !inClass) {
                        out.push(' ');
                        j++;
                        while (j < n && /[A-Za-z]/.test(content[j])) {
                            out.push(' ');
                            j++;
                        }
                        break;
                    }
                    if (c === '\n') break;
                    out.push(' ');
                    j++;
                }
                i = j;
                prevKind = 'value';
                continue;
            }
            // division operator — fall through to default emit
        }

        if (ch === '\n') {
            out.push('\n');
            finishWord();
        } else if (/[A-Za-z0-9_$]/.test(ch)) {
            out.push(ch);
            currentWord += ch;
        } else if (/\s/.test(ch)) {
            out.push(ch);
            finishWord();
        } else {
            finishWord();
            out.push(ch);
            prevKind = ch === ')' || ch === ']' || ch === '}' ? 'value' : 'op';
        }
        i++;
    }
    return out.join('');
}

function stripComments(content: string): string {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, '');
}

function extractImportLocalNames(content: string): Set<string> {
    const names = new Set<string>();
    const src = stripComments(content);
    const esmRe =
        /\bimport\s+(?:([A-Za-z_$][\w$]*)(?:\s*,\s*)?)?(\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\})?\s*from\s*['"][^'"]+['"]/g;
    let m;
    while ((m = esmRe.exec(src)) !== null) {
        if (m[1]) names.add(m[1]);
        if (m[2]) {
            if (m[2].startsWith('*')) {
                names.add(m[2].replace(/\*\s+as\s+/, '').trim());
            } else {
                for (const part of m[2]
                    .replace(/[{}]/g, '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)) {
                    const asM = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                    names.add(asM ? asM[2] : part);
                }
            }
        }
    }
    const cjsRe =
        /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"][^'"]+['"]\s*\)/g;
    while ((m = cjsRe.exec(src)) !== null) {
        const lhs = m[1];
        if (lhs.startsWith('{')) {
            for (const part of lhs
                .replace(/[{}]/g, '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)) {
                const asM = part.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
                names.add(asM ? asM[2] : part);
            }
        } else {
            names.add(lhs);
        }
    }
    return names;
}

function extractIdents(str: string): Set<string> {
    const set = new Set<string>();
    const re = /[A-Za-z_$][\w$]*/g;
    let m;
    while ((m = re.exec(str)) !== null) set.add(m[0]);
    return set;
}

const CONTROL_KEYWORDS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'with',
    'function',
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'await',
    'yield',
    'delete',
    'void'
]);

const GLOBALS = new Set([
    // reserved words / contextual keywords
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'null',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'async',
    'await',
    'of',
    'as',
    'from',
    'enum',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
    'arguments',
    'eval',
    'satisfies',
    'keyof',
    'infer',
    'readonly',
    'type',
    'namespace',
    'declare',
    'abstract',
    'is',
    // JS global functions
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',
    'escape',
    'unescape',
    // JS builtins & Node globals
    'undefined',
    'NaN',
    'Infinity',
    'globalThis',
    'global',
    'process',
    'console',
    'Buffer',
    'Bun',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'setTimeout',
    'setInterval',
    'setImmediate',
    'clearTimeout',
    'clearInterval',
    'clearImmediate',
    'queueMicrotask',
    'performance',
    'fetch',
    'atob',
    'btoa',
    'AbortController',
    'AbortSignal',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'structuredClone',
    'crypto',
    'navigator',
    'Blob',
    'File',
    'FormData',
    'Headers',
    'Request',
    'Response',
    'ReadableStream',
    'WritableStream',
    'TransformStream',
    'MessageChannel',
    'MessagePort',
    'Worker',
    'BroadcastChannel',
    'Event',
    'EventTarget',
    'CustomEvent',
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'EvalError',
    'URIError',
    'AggregateError',
    'Promise',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Symbol',
    'BigInt',
    'Object',
    'Math',
    'JSON',
    'Date',
    'RegExp',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'WeakRef',
    'Iterator',
    'Generator',
    'AsyncGenerator',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'Proxy',
    'Reflect',
    'Function',
    'Intl',
    'WebAssembly',
    'FinalizationRegistry'
]);

function extractBoundNames(
    stripped: string,
    topLevelDecls: Array<{ name?: string }>,
    importLocalNames: string[]
): Set<string> {
    const names = new Set<string>();
    for (const n of importLocalNames) if (n) names.add(n);
    for (const d of topLevelDecls) if (d && d.name) names.add(d.name);

    // const/let/var LHS (incl. destructuring), anywhere in the file
    const declRe = /\b(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = declRe.exec(stripped)) !== null) {
        extractIdents(m[1]).forEach((n) => names.add(n));
    }

    // function NAME / class NAME anywhere
    const fnRe = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
    while ((m = fnRe.exec(stripped)) !== null) names.add(m[1]);
    const clsRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
    while ((m = clsRe.exec(stripped)) !== null) names.add(m[1]);

    // function params: function NAME(params) / function(params)
    const funcParamRe = /\bfunction\s+[A-Za-z_$]?[\w$]*\s*\(([^()]*)\)/g;
    while ((m = funcParamRe.exec(stripped)) !== null) {
        extractIdents(m[1]).forEach((n) => names.add(n));
    }

    // arrow params: (params) =>
    const arrowParamRe = /\(([^()]*)\)\s*=>/g;
    while ((m = arrowParamRe.exec(stripped)) !== null) {
        extractIdents(m[1]).forEach((n) => names.add(n));
    }
    // single-param arrow without parens: NAME =>
    const singleArrowRe = /\b([A-Za-z_$][\w$]*)\s*=>/g;
    while ((m = singleArrowRe.exec(stripped)) !== null) names.add(m[1]);

    // method definitions: NAME(params) {  (NAME not a control keyword).
    // Params may contain one level of nested parens (e.g. default param
    // values like `fallback = this.defaultModel()`).
    const methodRe = /\b([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\{/g;
    while ((m = methodRe.exec(stripped)) !== null) {
        if (!CONTROL_KEYWORDS.has(m[1])) {
            names.add(m[1]);
            extractIdents(m[2]).forEach((n) => names.add(n));
        }
    }

    // for (const|let|var? NAME of|in ...)
    const forRe = /\bfor\s*\((?:const|let|var\s+)?([^;)]+?)\s*(?:of|in)\b/g;
    while ((m = forRe.exec(stripped)) !== null) {
        extractIdents(m[1]).forEach((n) => names.add(n));
    }

    // catch (NAME)
    const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
    while ((m = catchRe.exec(stripped)) !== null) names.add(m[1]);

    return names;
}

function findHeadReferences(stripped: string): HeadReference[] {
    const refs: HeadReference[] = [];
    const lines = stripped.split('\n');
    const identRe = /[A-Za-z_$][\w$]*/g;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*import\b/.test(line)) continue;
        let m;
        identRe.lastIndex = 0;
        while ((m = identRe.exec(line)) !== null) {
            const name = m[0];
            const end = m.index + name.length;
            const nextChar = line[end];
            if (nextChar !== '(' && nextChar !== '.') continue;
            // Skip if the identifier itself is a property access target,
            // i.e. preceded (ignoring whitespace) by '.' (covers `a.b` and
            // the '.' in `a?.b`).
            let j = m.index - 1;
            while (j >= 0 && /\s/.test(line[j])) j--;
            if (line[j] === '.') continue;
            refs.push({ name, line: i + 1 });
        }
    }
    return refs;
}

async function findUndefinedReferences(graph: Graph): Promise<IntegrityIssue[]> {
    const { modules, bindings } = graph;
    const issues: IntegrityIssue[] = [];
    const langCache = new Map<string, Language | null>();

    for (const [relPath, b] of bindings) {
        const mod = modules.get(relPath);
        if (!mod || !b.content) continue;
        const ext = path.extname(mod.abs).toLowerCase().slice(1);
        if (ext !== 'mjs' && ext !== 'js' && ext !== 'ts') continue;

        let lang = langCache.get(ext);
        if (lang === undefined) {
            try {
                lang = await languages.loadLanguage(ext);
            } catch {
                lang = null;
            }
            langCache.set(ext, lang);
        }
        if (!lang || typeof lang.extractTopLevelMembers !== 'function') continue;

        let topLevelDecls: Array<{ name?: string }> = [];
        try {
            topLevelDecls = (lang.extractTopLevelMembers(b.content) as Array<{ name?: string }>) || [];
        } catch {
            continue;
        }

        const importLocalNames = (b.imports || [])
            .map((i: ImportInfo) => i.localName)
            .filter((n: string | undefined): n is string => !!n);
        const stripped = stripForScan(b.content);
        const bound = extractBoundNames(stripped, topLevelDecls, importLocalNames);
        // Supplement imports parsed directly from source: ESM `.js` files
        // (the lang*.js support modules) are parsed by the CommonJS
        // bindings parser, which yields no imports for `import` statements.
        extractImportLocalNames(b.content).forEach((n) => bound.add(n));

        // Class members are DEFINED names too: a method's own definition
        // line reads like a head reference (`remember(...)`), and
        // unqualified-in-class usage is legal. Descend through the
        // language's member explorer (language-variadic).
        for (const decl of topLevelDecls as Array<{ name?: string; kind?: string }>) {
            if (decl.kind !== 'class') continue;
            try {
                const members = (lang.extractLocalMembers(decl, b.content, 'member') as Array<{ name?: string }>) || [];
                for (const member of members) {
                    if (member?.name) bound.add(member.name);
                }
            } catch {
                /* member exploration unavailable for this language */
            }
        }

        const seen = new Set<string>();
        for (const r of findHeadReferences(stripped)) {
            if (bound.has(r.name) || GLOBALS.has(r.name)) continue;
            const key = `${r.name}:${r.line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            issues.push({
                kind: 'undefined-reference',
                module: relPath,
                line: r.line,
                binding: r.name,
                detail: `referenced but not defined or imported`
            });
        }
    }
    return issues;
}

async function runIntegrityChecks(
    graph: Graph,
    runOpts: { strict?: boolean } = {}
): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    const { modules, bindings } = graph;

    // The in-file undefined-reference scan is opt-in (--strict): it has
    // produced only false positives (function parameters, class fields,
    // runtime globals) while the language primitives lack parameter
    // extraction. The default gate stays syntax + cross-module binding
    // integrity — the documented contract. (Gated at the scan's only
    // call site, below.)

    for (const [relPath, b] of bindings) {
        const mod = modules.get(relPath);
        if (!mod) continue;

        const seen = new Map<string, ExportInfo>();
        for (const [name, info] of Object.entries(b.exports) as Array<[string, ExportInfo]>) {
            if (seen.has(name)) {
                issues.push({
                    kind: 'duplicate-export',
                    module: relPath,
                    line: info.line,
                    binding: name,
                    detail: `exported again at line ${info.line} (first at ${seen.get(name)?.line})`
                });
            } else {
                seen.set(name, info);
            }
        }

        const referenced = b.content ?? '';
        for (const imp of b.imports) {
            const targetRel = resolveImportSource(mod, imp.source);

            // node: builtins (including subpaths like node:assert/strict)
            // never resolve to a project file and are never missing.
            const isBuiltin = imp.source && imp.source.startsWith('node:');
            // Scoped packages ("@scope/pkg") contain '/' but are bare
            // specifiers — never project files. A path ref starts with '.'
            // or is absolute; everything else (including '@scope/…') is a
            // package import.
            const isPathRef = imp.source.startsWith('.') || path.isAbsolute(imp.source);
            if (
                imp.source &&
                !isBuiltin &&
                isPathRef &&
                !targetRel
            ) {
                issues.push({
                    kind: 'missing-source',
                    module: relPath,
                    line: imp.line,
                    binding: imp.localName,
                    detail: `cannot resolve "${imp.source}" to a project file`
                });
                continue;
            }

            if (!targetRel) continue;
            const target = bindings.get(targetRel);
            if (!target) continue;

            if (imp.kind === 'named' && imp.binding && imp.binding !== '*') {
                const exported = target.exports[imp.binding];
                if (!exported) {
                    issues.push({
                        kind: 'broken-import',
                        module: relPath,
                        line: imp.line,
                        binding: imp.binding,
                        detail: `"${imp.source}" does not export "${imp.binding}"`
                    });
                }
            }

            if (imp.kind === 'default') {
                if (!target.exports.default) {
                    issues.push({
                        kind: 'default-mismatch',
                        module: relPath,
                        line: imp.line,
                        binding: imp.localName,
                        detail: `default import but "${imp.source}" has no default export`
                    });
                }
            }

            if (imp.localName && imp.kind !== 'sideeffect' && imp.kind !== 'dynamic') {
                const usageRe = new RegExp(`\\b${escapeRegex(imp.localName)}\\b`);
                const stripped = referenced.replace(
                    /^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm,
                    ''
                );
                if (!usageRe.test(stripped)) {
                    issues.push({
                        kind: 'unused-import',
                        module: relPath,
                        line: imp.line,
                        binding: imp.localName,
                        detail: `"${imp.localName}" imported from "${imp.source}" but not referenced`
                    });
                }
            }
        }
    }

    if (runOpts.strict) {
        issues.push(...(await findUndefinedReferences(graph)));
    }
    return issues;
}

function traceBinding(graph: Graph, name: string): LocalTraceResult {
    const { modules, bindings, byExport } = graph;
    const producers: TraceProducer[] = [];
    const consumers: TraceConsumer[] = [];
    const reExportChains: TraceReExport[] = [];

    const visited = new Set<string>();
    const resolveProducer = (
        relPath: string,
        info: ExportInfo,
        stack: string[]
    ): void => {
        const key = `${relPath}:${name}`;
        if (visited.has(key)) return;
        visited.add(key);
        if (info.type === 'reexport' && info.source) {
            const mod = modules.get(relPath);
            if (!mod) return;
            const targetRel = resolveImportSource(mod, info.source);
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
            const target = bindings.get(targetRel);
            if (target && target.exports[name]) {
                resolveProducer(targetRel, target.exports[name], [...stack, relPath]);
            } else {
                producers.push({ module: targetRel, line: info.line, type: 'unresolved-reexport' });
            }
            return;
        }
        producers.push({ module: relPath, line: info.line, type: info.type });
    };

    const decls = byExport.get(name) || [];
    for (const decl of decls) {
        const b = bindings.get(decl.module);
        if (!b) continue;
        resolveProducer(decl.module, b.exports[name], []);
    }

    const producerSet = new Set(producers.map((p) => p.module));
    const reexportSources = new Set(reExportChains.map((c) => c.from));

    const isReachable = (relPath: string, seen: Set<string> = new Set()): boolean => {
        if (producerSet.has(relPath)) return true;
        if (seen.has(relPath)) return false;
        seen.add(relPath);
        for (const chain of reExportChains) {
            if (chain.from === relPath) {
                if (isReachable(chain.to, seen)) return true;
            }
        }
        return false;
    };

    for (const [relPath, b] of bindings) {
        const mod = modules.get(relPath);
        if (!mod) continue;
        for (const imp of b.imports) {
            const targetRel = resolveImportSource(mod, imp.source);
            if (!targetRel) continue;
            if (imp.kind === 'named' && imp.binding === name) {
                if (isReachable(targetRel)) {
                    consumers.push({ module: relPath, line: imp.line, via: imp.source });
                }
            } else if (imp.kind === 'namespace' && imp.localName) {
                const target = bindings.get(targetRel);
                if (
                    target &&
                    (target.exports[name] ||
                        byExport.get(name)?.some((d) => d.module === targetRel))
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
    return { producers, consumers, reExportChains };
}

function formatStruct(bindings: Map<string, FileBindings>): string {
    const lines: string[] = [];
    for (const [relPath, b] of bindings) {
        lines.push(`\n${relPath}`);
        const expNames = Object.keys(b.exports).sort();
        if (expNames.length) {
            lines.push(`  exports:`);
            for (const n of expNames) {
                const e = b.exports[n];
                const src = e.source ? ` <- ${e.source}` : '';
                lines.push(`    ${n.padEnd(24)} ${e.type}${src}  L${e.line}`);
            }
        } else {
            lines.push(`  exports: (none)`);
        }
        if (b.imports.length) {
            lines.push(`  imports:`);
            for (const imp of b.imports) {
                const bind = imp.binding ? `${imp.binding}` : imp.kind;
                lines.push(
                    `    ${(bind || '').padEnd(24)} ${imp.kind}  from ${imp.source}  L${imp.line}`
                );
            }
        } else {
            lines.push(`  imports: (none)`);
        }
    }
    return lines.join('\n');
}

function formatTrace(result: LocalTraceResult, name: string): string {
    const lines = [`trace: ${name}`];
    lines.push(`\nproducers (${result.producers.length}):`);
    for (const p of result.producers) lines.push(`  ${p.module}:${p.line}  [${p.type}]`);
    lines.push(`\nconsumers (${result.consumers.length}):`);
    for (const c of result.consumers) lines.push(`  ${c.module}:${c.line}  via ${c.via}`);
    if (result.reExportChains.length) {
        lines.push(`\nre-export chains:`);
        for (const c of result.reExportChains) lines.push(`  ${c.from} -> ${c.to}  (${c.binding})`);
    }
    return lines.join('\n');
}

const meta = defineMeta({
    name: 'check',
    description:
        'Run `node --check` and verify cross-module binding integrity. Memos are skipped by default; use --memos to print the memo DAG, or --all to run syntax + integrity + memos together. With no file args, checks all modules. With file args, scopes syntax + integrity to the specified files and their import trees. Opt-in: --struct dumps exports/imports, --trace NAME walks the binding graph, --strict also scans for in-file undefined references, --json emits machine-readable output.',
    usage: 'rarebert check [files...] [--struct] [--trace <name> [--json]] [--skip-integrity] [--strict] [--memos] [--all]',
    args: [{ name: 'files', required: false }],
    options: [
        { flag: '--struct', description: 'print the full exports/imports table per module' },
        { flag: '--trace <name>', description: 'trace producers/consumers of a binding name' },
        { flag: '--skip-integrity', description: 'skip cross-module binding integrity checks' },
        { flag: '--strict', description: 'also scan for in-file undefined references (opt-in: noisy while the language primitives lack parameter extraction)' },
        { flag: '--memos', description: 'print the memo DAG (skips syntax + integrity)' },
        { flag: '--all', description: 'run syntax + integrity + memos together' },
        { flag: '--json', description: 'emit JSON (for --trace or full report) instead of text' }
    ]
});

export { meta };

export default new CLI(
    'check.ts',
    async (opts, positional) => {
        const args = Array.isArray(positional) ? positional : [];
        const struct = !!opts.struct;
        const traceName = opts.trace;
        const all = !!opts.all;
        const noIntegrity = !!opts.skipIntegrity || (!!opts.memos && !all);
        const noSyntax = !!opts.memos && !all;
        const noMemos = !opts.memos && !all;
        const asJson = !!opts.json;

        const allModules = listAllModules();
        if (allModules.length === 0) {
            console.error('No modules found in lib/ or scripts/.');
            return exit(1);
        }

        // --- Scope resolution ---
        //
        // No file args  → check all modules, whole-repo memo DAG
        // File args     → check just those files + their transitive import
        //                 tree; memo display scoped to the same set + ancestors
        let scopedModules = allModules;
        let scopeClosure: Set<string> | null = null;
        if (args.length > 0) {
            const resolvedSet = resolveModuleSet(args, allModules);
            if (resolvedSet.length === 0) {
                console.error(`No modules matched: ${args.join(', ')}`);
                return exit(1);
            }
            scopeClosure = await resolveClosure(
                resolvedSet.map((r) => ({ path: r.module.path, rel: r.rel })),
                allModules
            );
            const closure = scopeClosure;
            scopedModules = allModules.filter((m) => closure.has(m.path));
        }

        if (traceName) {
            const graph = (await buildBindingGraph(scopedModules)) as unknown as Graph;
            const result = traceBinding(graph, traceName);
            if (asJson) {
                console.log(JSON.stringify({ trace: traceName, ...result }, null, 2));
            } else {
                console.log(formatTrace(result, traceName));
            }
            return exit(0);
        }

        let failures = 0;
        const report: {
            syntax: Array<{ module: string; locations: CheckLocation[] }>;
            integrity: IntegrityIssue[];
        } = { syntax: [], integrity: [] };

        // Pre-load which modules in the scope have memos so the per-module
        // status line can be decorated with a memo marker.
        const memoedPaths = new Set<string>();
        for (const mod of scopedModules) {
            const memos = memo.loadMemos(mod.abs);
            if (memos.length > 0 && memos.some((m) => m.content.length > 0)) {
                memoedPaths.add(mod.path);
            }
        }

        // When file args are given, mark which modules are the directly
        // requested seeds (vs import-tree ancestors) so the output
        // distinguishes targets from dependencies.
        const seedPaths = new Set();
        if (args.length > 0) {
            const seeds = resolveModuleSet(args, allModules);
            for (const r of seeds) seedPaths.add(r.rel);
        }

        if (!noSyntax) {
            for (const mod of scopedModules) {
                const rel = rarebert.relPath(mod.abs);
                const { ok, skipped, locations } = runNodeCheck(mod.abs);
                const hasMemo = memoedPaths.has(mod.path);
                const marker = hasMemo ? ` ${YELLOW_STAR}` : '';
                const seedTag = seedPaths.has(mod.path) ? ` ${BOLD}(target)${RESET}` : '';

                if (skipped) {
                    console.log(`skip ${rel}${marker}`);
                } else if (ok) {
                    console.log(`ok   ${rel}${marker}${seedTag}`);
                } else {
                    failures++;
                    report.syntax.push({ module: rel, locations });
                    console.log(`FAIL ${rel}${marker}`);
                    for (const loc of locations) {
                        const content = `line ${loc.line}: ${loc.message}`;
                        memo.remember(mod.path, content);
                        console.log(`     ${content}`);
                    }
                }
            }
        }

        let integrityIssues: IntegrityIssue[] = [];
        if (!noIntegrity) {
            const graph = (await buildBindingGraph(scopedModules)) as unknown as Graph;
            integrityIssues = await runIntegrityChecks(graph, { strict: opts.strict });
            if (integrityIssues.length > 0) {
                console.log(`\nintegrity: ${integrityIssues.length} issue(s)`);
                for (const issue of integrityIssues) {
                    const content = `${issue.kind}: ${issue.module}${issue.line ? `:${issue.line}` : ''} ${issue.binding ? `(${issue.binding}) ` : ''}${issue.detail}`;
                    const mod = graph.modules.get(issue.module);
                    if (mod) memo.remember(mod.abs, content);
                    report.integrity.push(issue);
                    console.log(`  ${content}`);
                }
            } else {
                console.log(`\nintegrity: ok`);
            }

            if (struct) {
                if (asJson) {
                    const dump: Record<string, unknown> = {};
                    for (const [relPath, b] of graph.bindings) {
                        dump[relPath] = { exports: b.exports, imports: b.imports };
                    }
                    console.log(JSON.stringify(dump, null, 2));
                } else {
                    console.log(formatStruct(graph.bindings));
                }
            }
        }

        if (asJson && !struct) {
            console.log(
                JSON.stringify(
                    {
                        checked: scopedModules.length,
                        syntaxFailures: report.syntax.length,
                        integrityIssues: report.integrity.length,
                        report
                    },
                    null,
                    2
                )
            );
        }

        const totalFailures = failures + integrityIssues.length;
        const memoCount = [...memoedPaths].reduce((n: number, p: string) => {
            const memos = memo.loadMemos(p);
            return n + memos.reduce((c: number, m) => c + m.content.length, 0);
        }, 0);
        console.log(
            `\nchecked ${scopedModules.length} module${scopedModules.length === 1 ? '' : 's'}, ${failures} syntax failure${failures === 1 ? '' : 's'}, ${integrityIssues.length} integrity issue${integrityIssues.length === 1 ? '' : 's'}, ${YELLOW}${memoCount}${RESET} memo${memoCount === 1 ? '' : 's'}`
        );

        // --- Memo display ---
        //
        // No file args  → whole-repo memo DAG
        // File args     → DAG scoped to the resolved set + their ancestors
        //                 (printDagForSet walks the full import graph and emits
        //                 ancestors before the set members)
        if (!noMemos) {
            console.log();
            if (args.length === 0) {
                printDagForSet([]);
            } else {
                const resolvedSet = resolveModuleSet(args, allModules);
                printDagForSet(resolvedSet);
            }
        }

        return exit(totalFailures === 0 ? 0 : 1);
    },
    meta
).supportsDirectRunning();
