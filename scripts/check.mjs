#!/usr/bin/env node

import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules, CLI } from '../lib/module.mjs';
import { memo } from '../lib/memo.mjs';
import {
    runNodeCheck,
    buildBindingGraph,
    runIntegrityChecks,
    traceBinding,
    formatStruct,
    formatTrace
} from '../lib/check.mjs';

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

export { meta };

export default new CLI('check.mjs', async (opts = {}, positional = []) => {
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
        console.log(JSON.stringify({
            checked: modules.length,
            syntaxFailures: report.syntax.length,
            integrityIssues: report.integrity.length,
            report
        }, null, 2));
    }

    const totalFailures = failures + integrityIssues.length;
    console.log(
        `\nchecked ${modules.length} module${modules.length === 1 ? '' : 's'}, ${failures} syntax failure${failures === 1 ? '' : 's'}, ${integrityIssues.length} integrity issue${integrityIssues.length === 1 ? '' : 's'}`
    );
    return exit(totalFailures === 0 ? 0 : 1);
}, meta).supportsDirectRunning(import.meta.url);