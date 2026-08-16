import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { rarebert } from './projects.mjs';
import { languages } from './languages.mjs';

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

async function buildBindingGraph(modules) {
    const byPath = new Map(modules.map((m) => [m.path, m]));
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
        const b = readBindings(mod, lang);
        if (!b) continue;
        bindings.set(mod.path, b);
        for (const [name, info] of Object.entries(b.exports)) {
            if (!byExport.has(name)) byExport.set(name, []);
            byExport.get(name).push({ module: mod.path, type: info.type, line: info.line, source: info.source });
        }
    }
    return { modules: byPath, bindings, byExport };
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runIntegrityChecks(graph) {
    const issues = [];
    const { modules, bindings } = graph;

    for (const [relPath, b] of bindings) {
        const mod = modules.get(relPath);
        if (!mod) continue;

        const seen = new Map();
        for (const [name, info] of Object.entries(b.exports)) {
            if (seen.has(name)) {
                issues.push({
                    kind: 'duplicate-export', module: relPath, line: info.line, binding: name,
                    detail: `exported again at line ${info.line} (first at ${seen.get(name).line})`
                });
            } else {
                seen.set(name, info);
            }
        }

        const referenced = b.content;
        for (const imp of b.imports) {
            const targetRel = resolveImportSource(mod, imp.source);

            if (imp.source && (imp.source.includes('/') || imp.source.startsWith('.')) && !targetRel) {
                issues.push({
                    kind: 'missing-source', module: relPath, line: imp.line, binding: imp.localName,
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
                        kind: 'broken-import', module: relPath, line: imp.line, binding: imp.binding,
                        detail: `"${imp.source}" does not export "${imp.binding}"`
                    });
                }
            }

            if (imp.kind === 'default') {
                if (!target.exports.default) {
                    issues.push({
                        kind: 'default-mismatch', module: relPath, line: imp.line, binding: imp.localName,
                        detail: `default import but "${imp.source}" has no default export`
                    });
                }
            }

            if (imp.localName && imp.kind !== 'sideeffect' && imp.kind !== 'dynamic') {
                const usageRe = new RegExp(`\\b${escapeRegex(imp.localName)}\\b`);
                const stripped = referenced.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
                if (!usageRe.test(stripped)) {
                    issues.push({
                        kind: 'unused-import', module: relPath, line: imp.line, binding: imp.localName,
                        detail: `"${imp.localName}" imported from "${imp.source}" but not referenced`
                    });
                }
            }
        }
    }
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
                producers.push({ module: relPath, line: info.line, type: 'reexport-orphan', source: info.source });
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
                if (target && (target.exports[name] || byExport.get(name)?.some((d) => d.module === targetRel))) {
                    consumers.push({ module: relPath, line: imp.line, via: `${imp.source} (as ${imp.localName}.${name})` });
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
                lines.push(`    ${(bind || '').padEnd(24)} ${imp.kind}  from ${imp.source}  L${imp.line}`);
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

/**
 * Compute the transitive import closure from a set of seed modules.
 * Returns a Set of relative paths (the seeds + all files reachable
 * through their import chains). Uses the binding graph's import
 * resolution so it stays consistent with integrity checking.
 */
async function resolveImportClosure(seeds, modules) {
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
        const b = readBindings(mod, lang);
        if (!b) continue;
        for (const imp of b.imports) {
            const targetRel = resolveImportSource(mod, imp.source);
            if (!targetRel || closure.has(targetRel)) continue;
            closure.add(targetRel);
            const target = byPath.get(targetRel);
            if (target) queue.push(target);
        }
    }
    return closure;
}

export {
    runNodeCheck,
    readBindings,
    resolveImportSource,
    resolveImportClosure,
    buildBindingGraph,
    runIntegrityChecks,
    traceBinding,
    formatStruct,
    formatTrace
};
export default { runNodeCheck, buildBindingGraph, runIntegrityChecks, traceBinding };
