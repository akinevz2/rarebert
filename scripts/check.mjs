#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules, CLI, resolveModuleSet } from '../lib/module.mjs';
import { memo, printDagForSet } from '../lib/memo.mjs';
import { YELLOW_STAR, YELLOW, BOLD, RESET } from '../lib/symbols.mjs';
import { languages } from '../lib/languages.mjs';
import { buildBindingGraph, resolveClosure } from '../lib/introspect.mjs';

// REQUEST: check module performs syntax and integrity checks. On ctrl-c:
// - No cleanup needed; just return exit 0 (cancelled)
// Meta suggestion: { retryOnFailure: false, cleanup: 'none' }

const JS_CHECKABLE = new Set(['.mjs', '.js']);

function runNodeCheck(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!JS_CHECKABLE.has(ext)) return { ok: true, skipped: true, locations: [] };

    const result = spawnSync(process.execPath, ['--check', filePath], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.status === 0) return { ok: true, skipped: false, locations: [] };

    const locations = [];
    const lines = output.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/:(\d+)$/);
        if (!m) continue;
        const lineNo = m[1];
        const msgMatch = output.match(/SyntaxError:\s+(.+)/);
        const msg = msgMatch ? msgMatch[1].trim() : (lines[i + 1] ?? '');
        locations.push({ line: lineNo, message: msg });
        break;
    }
    if (locations.length === 0) {
        locations.push({ line: '?', message: output.split(/\r?\n/)[0] ?? 'unknown error' });
    }
    return { ok: false, skipped: false, locations };
}

function readBindings(mod, lang) {
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

function resolveImportSource(mod, source) {
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
    for (const candidate of [resolved + '.mjs', resolved + '.js']) {
        if (fs.existsSync(candidate)) return rarebert.relPath(candidate);
    }
    return null;
}

function escapeRegex(s) {
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

function stripForScan(content) {
    const n = content.length;
    const out = [];
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

function stripComments(content) {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, '');
}

function extractImportLocalNames(content) {
    const names = new Set();
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

function extractIdents(str) {
    const set = new Set();
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

function extractBoundNames(stripped, topLevelDecls, importLocalNames) {
    const names = new Set();
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

function findHeadReferences(stripped) {
    const refs = [];
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

async function findUndefinedReferences(graph) {
    const { modules, bindings } = graph;
    const issues = [];
    const langCache = new Map();

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

        let topLevelDecls = [];
        try {
            topLevelDecls = lang.extractTopLevelMembers(b.content) || [];
        } catch {
            continue;
        }

        const importLocalNames = (b.imports || []).map((i) => i.localName).filter(Boolean);
        const stripped = stripForScan(b.content);
        const bound = extractBoundNames(stripped, topLevelDecls, importLocalNames);
        // Supplement imports parsed directly from source: ESM `.js` files
        // (the lang*.js support modules) are parsed by the CommonJS
        // bindings parser, which yields no imports for `import` statements.
        extractImportLocalNames(b.content).forEach((n) => bound.add(n));

        const seen = new Set();
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

async function runIntegrityChecks(graph) {
    const issues = [];
    const { modules, bindings } = graph;

    for (const [relPath, b] of bindings) {
        const mod = modules.get(relPath);
        if (!mod) continue;

        const seen = new Map();
        for (const [name, info] of Object.entries(b.exports)) {
            if (seen.has(name)) {
                issues.push({
                    kind: 'duplicate-export',
                    module: relPath,
                    line: info.line,
                    binding: name,
                    detail: `exported again at line ${info.line} (first at ${seen.get(name).line})`
                });
            } else {
                seen.set(name, info);
            }
        }

        const referenced = b.content;
        for (const imp of b.imports) {
            const targetRel = resolveImportSource(mod, imp.source);

            // node: builtins (including subpaths like node:assert/strict)
            // never resolve to a project file and are never missing.
            const isBuiltin = imp.source && imp.source.startsWith('node:');
            if (
                imp.source &&
                !isBuiltin &&
                (imp.source.includes('/') || imp.source.startsWith('.')) &&
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

    issues.push(...(await findUndefinedReferences(graph)));
    return issues;
}

function traceBinding(graph, name) {
    const { modules, bindings, byExport } = graph;
    const producers = [];
    const consumers = [];
    const reExportChains = [];

    const visited = new Set();
    const resolveProducer = (relPath, info, stack) => {
        const key = `${relPath}:${name}`;
        if (visited.has(key)) return;
        visited.add(key);
        if (info.type === 'reexport' && info.source) {
            const mod = modules.get(relPath);
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

    const isReachable = (relPath, seen = new Set()) => {
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

function formatStruct(bindings) {
    const lines = [];
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

function formatTrace(result, name) {
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

const meta = {
    name: 'check',
    description:
        'Run `node --check` and verify cross-module binding integrity. Memos are skipped by default; use --memos to print the memo DAG, or --all to run syntax + integrity + memos together. With no file args, checks all modules. With file args, scopes syntax + integrity to the specified files and their import trees. Opt-in: --struct dumps exports/imports, --trace NAME walks the binding graph, --json emits machine-readable output.',
    usage: 'node index.js check [files...] [--struct] [--trace <name> [--json]] [--skip-integrity] [--memos] [--all]',
    args: [{ name: 'files', required: false }],
    options: [
        { flag: '--struct', description: 'print the full exports/imports table per module' },
        { flag: '--trace <name>', description: 'trace producers/consumers of a binding name' },
        { flag: '--skip-integrity', description: 'skip cross-module binding integrity checks' },
        { flag: '--memos', description: 'print the memo DAG (skips syntax + integrity)' },
        { flag: '--all', description: 'run syntax + integrity + memos together' },
        { flag: '--json', description: 'emit JSON (for --trace or full report) instead of text' }
    ]
};

export { meta };

export default new CLI(
    'check.mjs',
    async (opts = {}, positional = []) => {
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
        let scopeClosure = null;
        if (args.length > 0) {
            const resolvedSet = resolveModuleSet(args, allModules);
            if (resolvedSet.length === 0) {
                console.error(`No modules matched: ${args.join(', ')}`);
                return exit(1);
            }
            scopeClosure = await resolveClosure(resolvedSet, allModules);
            scopedModules = allModules.filter((m) => scopeClosure.has(m.path));
        }

        if (traceName) {
            const graph = await buildBindingGraph(scopedModules);
            const result = traceBinding(graph, traceName);
            if (asJson) {
                console.log(JSON.stringify({ trace: traceName, ...result }, null, 2));
            } else {
                console.log(formatTrace(result, traceName));
            }
            return exit(0);
        }

        let failures = 0;
        const report = { syntax: [], integrity: [] };

        // Pre-load which modules in the scope have memos so the per-module
        // status line can be decorated with a memo marker.
        const memoedPaths = new Set();
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

        let integrityIssues = [];
        if (!noIntegrity) {
            const graph = await buildBindingGraph(scopedModules);
            integrityIssues = await runIntegrityChecks(graph);
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
                    const dump = {};
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
        const memoCount = [...memoedPaths].reduce((n, p) => {
            const memos = memo.loadMemos(p);
            return n + memos.reduce((c, m) => c + m.content.length, 0);
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
                printDagForSet(null);
            } else {
                const resolvedSet = resolveModuleSet(args, allModules);
                printDagForSet(resolvedSet);
            }
        }

        return exit(totalFailures === 0 ? 0 : 1);
    },
    meta
).supportsDirectRunning(import.meta.url);
