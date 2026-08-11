#!/usr/bin/env node
import { Module } from '../lib/modules.mjs';
import * as languages from '../lib/languages.mjs';
import * as memo from '../lib/memo.mjs';
import { home as projects } from '../lib/projects.mjs';

const meta = {
    name: 'refactor',
    description:
        'Resolve bindings across import trees, detect damage after edits, emit LLM-ready repair job specs',
    usage: 'node index.js refactor <subcommand> [options]',
    options: [
        {
            flag: '--entry <file>',
            description: 'Entry point for import-tree walk (defaults to project root module)'
        },
        {
            flag: '--snapshot <path>',
            description: 'Path to save/load binding baseline (defaults to .refactor-snapshot.json)'
        },
        {
            flag: '--format <type>',
            description: 'Output format: json | markdown | prompt (default: json)'
        },
        {
            flag: '--select <vars>',
            description: 'Comma-separated bindings to simulate moving/renaming (what-if mode)'
        },
        {
            flag: '--from <file>',
            description: 'Source file for selected bindings (used with --select)'
        },
        {
            flag: '--to <file>',
            description: 'Target file for selected bindings (used with --select)'
        },
        {
            flag: '--op <type>',
            description: 'Operation type for what-if: move | rename | extract (used with --select)'
        },
        {
            flag: '--verbose',
            description: 'Include resolved-but-healthy bindings in output, not just damaged ones'
        }
    ]
};

// ─── Subcommands ──────────────────────────────────────────────

const subcommands = {
    snapshot: 'Capture the current binding state as a healthy baseline',
    damage: 'Compare current state against last snapshot — emit damage report',
    select: 'What-if analysis: simulate a refactor and report blast radius',
    resolve: 'Walk the import tree and print all resolved bindings (no snapshot, no diff)'
};

// ─── Core: Binding Resolution ─────────────────────────────────

/**
 * Walks the import tree starting from `entryFile` and resolves every
 * binding (named exports, default exports, namespace imports).
 *
 * This is the "leveled up" version of memo's import walker — instead of
 * "does this file have a companion memo?", it asks "what does this file
 * export, and who imports it?"
 *
 * Returns a binding registry:
 *   {
 *     "config.js": {
 *       exports: {
 *         "parseConfig": { line: 5, type: "named", exported: true },
 *         "default":     { line: 12, type: "default", exported: true }
 *       },
 *       imports: {
 *         "app.js": [
 *           { binding: "parseConfig", source: "./config", line: 3, type: "named" }
 *         ]
 *       }
 *     }
 *   }
 *
 * Reuses memo.mjs's import-walking infrastructure for tree traversal,
 * but adds AST-level binding resolution via languages.mjs.
 */
async function resolveBindings(entryFile) {
    // TODO: Use memo.mjs's walk logic to enumerate the import tree.
    //       memo already knows how to traverse includes — we hook into
    //       that traversal and, for each visited file, parse it with
    //       languages.mjs to extract export/import declarations.
    //
    // For each file in the tree:
    //   1. Parse with languages.mjs → AST
    //   2. Extract all ExportNamedDeclaration, ExportDefaultDeclaration,
    //      ImportDeclaration (and re-exports, dynamic imports)
    //   3. Record: file → { exports: {...}, importedFrom: {...} }
    //
    // Then invert: build a reverse map of
    //   binding → { definedIn, importedBy: [...] }

    const visited = new Set();
    const registry = {};

    async function visit(filePath) {
        if (visited.has(filePath)) return;
        visited.add(filePath);

        // Use languages.mjs to parse the file
        const ast = await languages.parse(filePath); // TODO: verify API
        const { exports, imports } = extractBindings(ast, filePath);

        registry[filePath] = { exports, imports };

        // Walk children — reuse memo's resolution to find import targets
        for (const imp of imports) {
            const target = memo.resolveImport(filePath, imp.source); // TODO: verify API
            if (target) await visit(target);
        }
    }

    await visit(entryFile);
    return registry;
}

/**
 * Extracts export and import binding declarations from an AST.
 * Handles: named, default, namespace, re-exports.
 */
function extractBindings(ast, filePath) {
    const exports = {};
    const imports = [];

    // TODO: Walk AST body for:
    //   ExportNamedDeclaration → record each exported name + line
    //   ExportDefaultDeclaration → record "default" + line
    //   ExportAllDeclaration → re-export (record namespace)
    //   ImportDeclaration → record each imported name, source, line
    //   CallExpression with Import() → dynamic import (best-effort)

    return { exports, imports };
}

// ─── Core: Snapshot ───────────────────────────────────────────

/**
 * Captures the current binding registry as a JSON file.
 * This is the "healthy baseline" — the state before the developer
 * starts refactoring.
 *
 * The developer runs `refactor snapshot` before making changes,
 * then `refactor damage` after.
 */
async function saveSnapshot(entryFile, snapshotPath) {
    const registry = await resolveBindings(entryFile);
    const snapshot = {
        entry: entryFile,
        timestamp: Date.now(),
        registry
    };
    // TODO: write to snapshotPath (default: .refactor-snapshot.json at project root)
    // Could use projects.mjs to resolve the project root.
    return snapshot;
}

async function loadSnapshot(snapshotPath) {
    // TODO: read and parse snapshotPath
    // Return null if file doesn't exist (no baseline captured yet)
}

// ─── Core: Damage Detection ───────────────────────────────────

/**
 * Compares the current binding state against the saved snapshot.
 *
 * The developer has already edited the code (moved/renamed/extracted
 * bindings). This function re-resolves the import tree and finds
 * everything that was healthy in the snapshot but is now broken.
 *
 * "Broken" = an import statement that previously resolved to a real
 * export, but no longer does.
 *
 * The damage report is the LLM's job spec — it's not "refactor this
 * module" but "these specific imports are now dangling, fix them."
 */
async function detectDamage(entryFile, snapshotPath) {
    const snapshot = await loadSnapshot(snapshotPath);
    if (!snapshot) {
        throw new Error('No snapshot found. Run `refactor snapshot` before editing.');
    }

    const currentRegistry = await resolveBindings(entryFile);
    const baseline = snapshot.registry;
    const damage = [];

    // For each file in the baseline, compare its imports against the
    // current registry to find dangling bindings.
    for (const [file, info] of Object.entries(baseline)) {
        for (const imp of info.imports) {
            const wasResolvable = isResolvable(imp, baseline);
            const isStillResolvable = isResolvable(imp, currentRegistry);

            if (wasResolvable && !isStillResolvable) {
                // This import was healthy before, now it's broken.
                // Try to figure out where the binding went.
                const relocated = findRelocation(imp.binding, baseline, currentRegistry);

                damage.push({
                    file: file,
                    line: imp.line,
                    binding: imp.binding,
                    source: imp.source,
                    issue: `import { ${imp.binding} } from '${imp.source}' — no longer exported`,
                    relocatedTo: relocated // null if truly removed, or { file, export } if found elsewhere
                });
            }
        }
    }

    return {
        entry: entryFile,
        snapshotTimestamp: snapshot.timestamp,
        damagedFiles: [...new Set(damage.map((d) => d.file))],
        damage: damage
    };
}

/**
 * Checks whether a given import resolves to a real export in the registry.
 */
function isResolvable(imp, registry) {
    // TODO: resolve the import's source path relative to the importing file,
    //       then check if the target file's exports include the binding.
    return false; // scaffold
}

/**
 * After the developer moves a binding, the old export disappears but a
 * new export appears elsewhere. This function tries to find it by
 * searching the current registry for a binding with the same name
 * that wasn't in the baseline (or was in a different file).
 */
function findRelocation(bindingName, baseline, current) {
    // TODO: search current registry for an export matching bindingName
    //       that either didn't exist in baseline or existed in a different file.
    return null; // scaffold
}

// ─── Core: What-If / Select ────────────────────────────────────

/**
 * Simulates a refactor without actually editing any files.
 *
 * The developer specifies: "I want to move `parseConfig` from
 * `config.js` to `config/parser.js`." This function computes which
 * files would have broken imports if that were done — the blast radius.
 *
 * This is a read-only preview. The developer uses it to decide
 * whether the refactor is worth it, or to batch multiple refactors.
 */
async function whatIf(entryFile, selection) {
    // selection = { op: "move", bindings: ["parseConfig"], from: "config.js", to: "config/parser.js" }
    const registry = await resolveBindings(entryFile);
    const blastRadius = [];

    for (const [file, info] of Object.entries(registry)) {
        for (const imp of info.imports) {
            if (selection.bindings.includes(imp.binding) && isResolvable(imp, registry)) {
                blastRadius.push({
                    file: file,
                    line: imp.line,
                    binding: imp.binding,
                    currentSource: imp.source,
                    wouldBreak: true,
                    suggestedFix: suggestFix(imp, selection)
                });
            }
        }
    }

    return {
        selection: selection,
        affectedFiles: [...new Set(blastRadius.map((b) => b.file))],
        blastRadius: blastRadius
    };
}

function suggestFix(imp, selection) {
    // TODO: based on the operation type, suggest the new import path
    //   move   → update source path
    //   rename → update binding name
    //   extract → update source path + possibly binding name
    return null; // scaffold
}

// ─── Core: Report Formatting ──────────────────────────────────

/**
 * Formats the damage report for LLM consumption.
 *
 * The output is the LLM's job spec. It should be constrained and
 * specific — not "refactor this" but "fix these broken imports."
 *
 * Formats:
 *   json     → structured data (for programmatic use or agent APIs)
 *   markdown → human-readable table (for review)
 *   prompt   → ready-to-paste LLM prompt with the damage report embedded
 */
function formatReport(damageReport, format) {
    if (format === 'json') {
        return JSON.stringify(damageReport, null, 2);
    }

    if (format === 'markdown') {
        const lines = [
            `# Refactor Damage Report`,
            ``,
            `Entry: ${damageReport.entry}`,
            `Snapshot: ${new Date(damageReport.snapshotTimestamp).toISOString()}`,
            `Damaged files: ${damageReport.damagedFiles.length}`,
            ``,
            `| File | Line | Binding | Issue | Relocated To |`,
            `|------|------|---------|-------|--------------|`
        ];
        for (const d of damageReport.damage) {
            lines.push(
                `| ${d.file} | ${d.line} | ${d.binding} | ${d.issue} | ${d.relocatedTo || '—'} |`
            );
        }
        return lines.join('\n');
    }

    if (format === 'prompt') {
        const lines = [
            `The following imports are broken after a refactor.`,
            `Fix each one by updating the import statement to point to the correct source.`,
            `Do not change any logic — only repair the import declarations.`,
            ``
        ];
        for (const d of damageReport.damage) {
            lines.push(`File: ${d.file}:${d.line}`);
            lines.push(`  Problem: ${d.issue}`);
            if (d.relocatedTo) {
                lines.push(`  Binding moved to: ${d.relocatedTo.file}`);
            }
            lines.push(``);
        }
        return lines.join('\n');
    }
}

// ─── Main ─────────────────────────────────────────────────────

async function main(opts, positional) {
    const sub = positional[0] || '';

    const entryFile = opts.entry || projects.scriptsDir;
    const snapshotPath = opts.snapshot || '.refactor-snapshot.json';
    const format = opts.format || 'json';

    switch (sub) {
        case 'snapshot': {
            const snap = await saveSnapshot(entryFile, snapshotPath);
            console.log(
                `Snapshot saved: ${snapshotPath} (${Object.keys(snap.registry).length} files resolved)`
            );
            break;
        }

        case 'damage': {
            const report = await detectDamage(entryFile, snapshotPath);
            if (report.damage.length === 0) {
                console.log('No damage detected — all bindings still resolve.');
            } else {
                console.log(formatReport(report, format));
            }
            break;
        }

        case 'select': {
            if (!opts.select || !opts.from) {
                console.error(
                    'Usage: refactor select --select <bindings> --from <file> [--to <file>] [--op <type>]'
                );
                process.exit(1);
            }
            const selection = {
                op: opts.op || 'move',
                bindings: opts.select.split(',').map((s) => s.trim()),
                from: opts.from,
                to: opts.to
            };
            const result = await whatIf(entryFile, selection);
            console.log(JSON.stringify(result, null, 2));
            break;
        }

        case 'resolve': {
            const registry = await resolveBindings(entryFile);
            if (opts.verbose) {
                console.log(JSON.stringify(registry, null, 2));
            } else {
                // Summary: file count, total bindings, any unresolved
                const totalExports = Object.values(registry).reduce(
                    (n, f) => n + Object.keys(f.exports).length,
                    0
                );
                const totalImports = Object.values(registry).reduce(
                    (n, f) => n + f.imports.length,
                    0
                );
                console.log(
                    `Resolved ${Object.keys(registry).length} files, ${totalExports} exports, ${totalImports} imports`
                );
            }
            break;
        }

        default:
            console.log(`Usage: ${meta.usage}\n`);
            console.log('Subcommands:');
            for (const [name, desc] of Object.entries(subcommands)) {
                console.log(`  ${name.padEnd(10)} ${desc}`);
            }
            console.log(`\nOptions:`);
            for (const opt of meta.options) {
                console.log(`  ${opt.flag.padEnd(22)} ${opt.description}`);
            }
    }
}

export { main };

const module = new Module('refactor.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
