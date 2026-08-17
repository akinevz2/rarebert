#!/usr/bin/env node
import { CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import * as bindings from '../lib/bindings.mjs';
import { home as projects } from '../lib/projects.mjs';
import { formatReport, printUsage } from '../lib/refactor.mjs';

const meta = {
    name: 'refactor',
    description:
        'Resolve bindings across import trees, detect damage after edits, emit LLM-ready repair job specs. Baselines are pinned to commits via git notes (refs/notes/refactor). Damage and what-if automatically generate memos via opencode.',
    usage: 'node index.js refactor <subcommand> [options]',
    options: [
        { flag: '--entry <file>', description: 'Entry point for import-tree walk (defaults to scripts/ directory)' },
        { flag: '--baseline <ref>', description: 'Git ref whose refactor note holds the baseline (default: HEAD)' },
        { flag: '--format <type>', description: 'Output format: json | markdown | prompt (default: json)' },
        { flag: '--select <vars>', description: 'Comma-separated bindings to simulate moving/renaming (what-if mode)' },
        { flag: '--from <file>', description: 'Source file for selected bindings (used with --select)' },
        { flag: '--to <file>', description: 'Target file for selected bindings (used with --select)' },
        { flag: '--op <type>', description: 'Operation type for what-if: move | rename | extract (used with --select)' },
        { flag: '--model <id>', description: 'Model override for opencode memo generation' },
        { flag: '--no-memos', description: 'Skip automatic memo generation (damage/select) and cleanup (cleanup)' },
        { flag: '--verbose', description: 'Include resolved-but-healthy bindings in output, not just damaged ones' }
    ]
};

const subcommands = {
    snapshot: 'Capture binding baseline + memo state as a note on HEAD (run on a clean commit)',
    damage: 'Compare current state against baseline — emit damage report + auto-generate memos via opencode',
    select: 'What-if analysis: simulate a refactor, report blast radius + record memo on source module',
    resolve: 'Walk the import tree and print all resolved bindings (no snapshot, no diff)',
    cleanup: 'Post-commit cleanup: drop stale pre-snapshot memos and confirm new summaries on affected modules'
};

export { meta };

export default new CLI('refactor.mjs', async (opts, positional) => {
    const sub = positional[0] || '';

    const entryFile = opts.entry || projects.scriptsDir;
    const baselineRef = opts.baseline || 'HEAD';
    const format = opts.format || 'json';
    const noMemos = opts['no-memos'] === true;
    const model = opts.model || null;

    let effectiveSub = sub;
    if (!sub) {
        if (bindings.isSnapshotInProgress(baselineRef)) {
            effectiveSub = 'resolve';
            console.error('refactor: baseline note found — defaulting to `resolve`.\n');
        } else {
            effectiveSub = 'snapshot';
            console.error('refactor: no baseline note found — defaulting to `snapshot`.\n');
        }
    }

    switch (effectiveSub) {
        case 'snapshot': {
            const snap = await bindings.saveSnapshot(entryFile, baselineRef);
            const memoCount = snap.memoState ? Object.keys(snap.memoState).length : 0;
            const memoTotal = snap.memoState
                ? Object.values(snap.memoState).reduce((n, m) => n + m.length, 0)
                : 0;
            console.log(
                `Baseline saved on ${baselineRef} (${snap.baselineSha?.slice(0, 8) ?? '?'}) — ` +
                    `${Object.keys(snap.registry).length} files, ` +
                    `${Object.values(snap.registry).reduce((n, f) => n + Object.keys(f.exports).length, 0)} exports resolved.`
            );
            if (memoCount > 0) {
                console.log(`Memo state captured: ${memoCount} modules, ${memoTotal} memos.`);
            }
            return exit(0);
        }

        case 'damage': {
            const report = await bindings.detectDamage(entryFile, baselineRef);
            if (report.damage.length === 0) {
                console.log('No damage detected — all bindings still resolve.');
                return exit(0);
            }
            console.log(formatReport(report, format));

            if (!noMemos) {
                console.error('\n┌─ memo generation ────────────────────────────');
                console.error(`│ Generating damage summaries via opencode${model ? ' (' + model + ')' : ''}...`);
                const generated = await bindings.generateDamageMemos(report, model);
                if (generated.length > 0) {
                    console.error(`│ Generated ${generated.length} memo(s).`);
                    console.error('│ Run `make commit`, then `refactor cleanup` to finalize.');
                } else {
                    console.error('│ No memos generated (opencode may be unavailable).');
                }
                console.error('└───────────────────────────────────────────────\n');
            }
            return exit(0);
        }

        case 'select': {
            if (!opts.select || !opts.from) {
                console.error('Usage: refactor select --select <bindings> --from <file> [--to <file>] [--op <type>]');
                return exit(1);
            }
            const selection = {
                op: opts.op || 'move',
                bindings: opts.select.split(',').map((s) => s.trim()),
                from: opts.from,
                to: opts.to
            };
            const registry = await bindings.resolveBindings(entryFile);
            const result = bindings.whatIf(registry, selection);
            console.log(JSON.stringify(result, null, 2));

            if (!noMemos) {
                console.error('\n┌─ memo recording ──────────────────────────────');
                bindings.recordBlastRadiusMemo(result, selection);
                console.error('└───────────────────────────────────────────────\n');
            }
            return exit(0);
        }

        case 'resolve': {
            const registry = await bindings.resolveBindings(entryFile);
            if (opts.verbose) {
                console.log(JSON.stringify(registry, null, 2));
            } else {
                const totalExports = Object.values(registry).reduce(
                    (n, f) => n + Object.keys(f.exports).length, 0
                );
                const totalImports = Object.values(registry).reduce(
                    (n, f) => n + f.imports.length, 0
                );
                console.log(`Resolved ${Object.keys(registry).length} files, ${totalExports} exports, ${totalImports} imports`);
            }
            return exit(0);
        }

        case 'cleanup': {
            const cleanupRef = opts.baseline || 'HEAD~1';
            console.log(`Cleaning up memos against baseline on ${cleanupRef}...`);
            if (noMemos) {
                console.log('  (--no-memos: skipping cleanup)');
                return exit(0);
            }
            const summary = await bindings.cleanupMemos(cleanupRef, []);
            if (summary.length === 0) {
                console.log('  No stale memos found to clean up.');
            } else {
                const totalDropped = summary.reduce((n, s) => n + s.dropped, 0);
                console.log(`  Done: ${totalDropped} stale memo(s) dropped across ${summary.length} module(s).`);
            }
            return exit(0);
        }

        default:
            printUsage(meta, subcommands);
            return exit(1);
    }
}, meta).supportsDirectRunning(import.meta.url);