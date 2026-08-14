#!/usr/bin/env node

import { current } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules, CLI, resolveModuleSet } from '../lib/module.mjs';
import { memo, printDagForSet } from '../lib/memo.mjs';
import { YELLOW_STAR, YELLOW, BOLD, RESET } from './symbols.mjs';
import {
    runNodeCheck,
    buildBindingGraph,
    runIntegrityChecks,
    traceBinding,
    formatStruct,
    formatTrace,
    resolveImportClosure
} from '../lib/check.mjs';

const meta = {
    name: 'check',
    description:
        'Run `node --check` and verify cross-module binding integrity. Memos are skipped by default; use --memos to print the memo DAG, or --all to run syntax + integrity + memos together. With no file args, checks all modules. With file args, scopes syntax + integrity to the specified files and their import trees. Opt-in: --struct dumps exports/imports, --trace NAME walks the binding graph, --json emits machine-readable output.',
    usage:
        'node index.js check [files...] [--struct] [--trace <name> [--json]] [--skip-integrity] [--memos] [--all]',
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
            scopeClosure = await resolveImportClosure(resolvedSet, allModules);
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
                const rel = current.relPath(mod.abs);
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
