#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules } from '../lib/modules.mjs';
import { memo } from '../lib/memo.mjs';
import { languages } from '../lib/languages.mjs';
import { Module } from '../lib/modules.mjs';

const meta = {
    name: 'check',
    description:
        'Run `node --check` on every library and script, then verify cross-module binding integrity. Opt-in: --struct dumps exports/imports, --trace NAME walks the binding graph, --json emits machine-readable output.',
    usage: 'node index.js check [--struct] [--trace <name> [--json]] [--no-integrity]',
    options: [
        { flag: '--struct', description: 'print the full exports/imports table per module' },
        { flag: '--trace <name>', description: 'trace producers/consumers of a binding name' },
        { flag: '--skip-integrity', description: 'skip cross-module binding integrity checks' },
        { flag: '--json', description: 'emit JSON (for --trace or full report) instead of text' }
    ]
};

const JS_CHECKABLE = new Set(['.mjs', '.js']);

function runNodeCheck(filePath) {
    // `node --check` only parses JS; skip non-JS extensions (docs/.md,
    // src/.py) that are still discovered as modules. Bindings extraction
    // already guards these via lang.extractBindings; mirror that here.
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
    return { ok: false, locations };
}

/**
 * Read a module's source and run the language's extractBindings on it.
 * Returns { exports, imports, content, ext } or null when the language
 * has no binding extractor (e.g. JSON-template languages). The language
 * instance must already be loaded (use `await languages.loadLanguage(ext)`
 * once per extension to warm the registry's cache).
 */
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

/**
 * Resolve an import `source` (as recorded by extractBindings) from the
 * perspective of `mod` to a project-relative module path. Returns null
 * when the source is external (bare specifier like 'fs', 'enquirer') or
 * doesn't resolve to an existing project file.
 */
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

/**
 * Build the project-wide binding graph used by integrity checks and
 * tracing. Returns:
 *   modules:  Map<relPath, Module>
 *   bindings: Map<relPath, { exports, imports, content, ext }>
 *   byExport: Map<name, Array<{ module: relPath, type, line, source? }>>
 *
 * `byExport` collapses re-exports so a tracer can start from any name
 * and find every module that makes it available.
 */
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
            byExport
                .get(name)
                .push({ module: mod.path, type: info.type, line: info.line, source: info.source });
        }
    }
    return { modules: byPath, bindings, byExport };
}

/**
 * Cross-module integrity checks. Returns an array of issue objects:
 *   { kind, module, line?, binding?, detail }
 *
 * Kinds:
 *   broken-import      — named import not exported by resolved source
 *   missing-source     — import specifier resolves to no project file
 *   duplicate-export   — same name exported twice in one module
 *   default-mismatch   — default import but no default export (or vice versa)
 *   unused-import      — named binding imported but not referenced in body
 */
function runIntegrityChecks(graph) {
    const issues = [];
    const { modules, bindings } = graph;

    for (const [relPath, b] of bindings) {
        const mod = modules.get(relPath);
        if (!mod) continue;

        // duplicate-export
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

        // import checks
        const referenced = b.content;
        for (const imp of b.imports) {
            const targetRel = resolveImportSource(mod, imp.source);

            if (
                imp.source &&
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

            if (!targetRel) continue; // external or unresolvable: skip
            const target = bindings.get(targetRel);
            if (!target) continue; // not a JS module we parsed

            // broken-import (named): source module must export this binding
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

            // default-mismatch
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

            // unused-import: cheap text scan for the local name
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

    return issues;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Trace producers and consumers of a binding name across the full
 * import graph, chasing re-exports transitively. Cycle-aware.
 *
 * Returns:
 *   producers: [{ module, line, type }]  — modules that declare the binding
 *   consumers: [{ module, line, via }]   — modules that import it (final link)
 *   reExportChains: [{ from, to, binding }] — re-export edges traversed
 */
function traceBinding(graph, name) {
    const { modules, bindings, byExport } = graph;
    const producers = [];
    const consumers = [];
    const reExportChains = [];

    // Producers: declarations (named/default), not re-exports.
    // Re-exports are followed transitively to their origin.
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

    // Consumers: walk every module's imports; if a named import's binding
    // matches `name` and its source is a producer (directly or via
    // re-export chain), record it. Follow namespace imports too.
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
    for (const p of result.producers) {
        lines.push(`  ${p.module}:${p.line}  [${p.type}]`);
    }
    lines.push(`\nconsumers (${result.consumers.length}):`);
    for (const c of result.consumers) {
        lines.push(`  ${c.module}:${c.line}  via ${c.via}`);
    }
    if (result.reExportChains.length) {
        lines.push(`\nre-export chains:`);
        for (const c of result.reExportChains) {
            lines.push(`  ${c.from} -> ${c.to}  (${c.binding})`);
        }
    }
    return lines.join('\n');
}

async function main(opts = {}, positional = []) {
    const args = Array.isArray(positional) ? positional : [];
    const struct = !!opts.struct;
    const traceName = opts.trace;
    const noIntegrity = !!opts.skipIntegrity;
    const asJson = !!opts.json;

    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found in lib/ or scripts/.');
        return exit(1);
    }

    if (traceName) {
        const graph = await buildBindingGraph(modules);
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

    for (const mod of modules) {
        const rel = rarebert.relPath(mod.abs);
        const { ok, skipped, locations } = runNodeCheck(mod.abs);

        if (skipped) {
            console.log(`skip ${rel}`);
        } else if (ok) {
            console.log(`ok   ${rel}`);
        } else {
            failures++;
            report.syntax.push({ module: rel, locations });
            console.log(`FAIL ${rel}`);
            for (const loc of locations) {
                const content = `line ${loc.line}: ${loc.message}`;
                memo.remember(mod.path, content);
                console.log(`     ${content}`);
            }
        }

        const prior = memo.loadMemos(mod.abs);
        for (const m of prior) {
            for (const content of m.content) {
                console.log(`     memo ${rel}: ${content}`);
            }
        }
    }

    let integrityIssues = [];
    if (!noIntegrity) {
        const graph = await buildBindingGraph(modules);
        integrityIssues = runIntegrityChecks(graph);
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
                    checked: modules.length,
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
    console.log(
        `\nchecked ${modules.length} module${modules.length === 1 ? '' : 's'}, ${failures} syntax failure${failures === 1 ? '' : 's'}, ${integrityIssues.length} integrity issue${integrityIssues.length === 1 ? '' : 's'}`
    );
    return exit(totalFailures === 0 ? 0 : 1);
}

export { runNodeCheck, buildBindingGraph, runIntegrityChecks, traceBinding, main };

const module = new Module('check.mjs', main, meta);
export default module;
module.supportsDirectRunning(import.meta.url);
