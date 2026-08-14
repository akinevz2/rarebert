/**
 * lib/bindings.mjs — the refactor binding-resolution engine.
 *
 * Walks the import tree starting from an entry point, resolves every
 * export/import binding via language-specific `extractBindings` impls
 * (delegated through lib/languages.mjs), and builds a binding registry
 * that can be snapshotted, diffed for damage, and queried for what-if
 * blast-radius analysis.
 *
 * All language-specific parsing is delegated — this module never branches
 * on language name. Adding a new language only requires a lang{ext}.js
 * support module that implements `extractBindings`; see the memo in
 * scripts/refactor.mjs on new-language scope.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { languages } from './languages.mjs';
import { current } from './projects.mjs';
import { listAllModules } from './module.mjs';
import { git } from './git.mjs';
import { memo } from './memo.mjs';
import { opencode } from './opencode.mjs';

const REFACTOR_NOTES_REF = 'refs/notes/refactor';

/**
 * Resolve a module spec (`./foo`, `../bar/baz`, `mod`) from the
 * perspective of `importerAbs` to an absolute path on disk.
 *
 * Returns the absolute path string if the spec is a relative project
 * import that can be resolved, or null if the spec is external (a
 * package name like `fs`, `enquirer`) or cannot be resolved.
 *
 * Tries the spec as-is, then with extensions `.mjs`, `.js`, `.py`,
 * and as a directory with `/index`.
 */
function resolveImportPath(importerAbs, spec) {
    // External / bare package spec — not a project file.
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

/**
 * Get the language extension (without leading dot) for a file path.
 */
function extOf(filePath) {
    return path.extname(filePath).slice(1);
}

/**
 * Read a file's source safely. Returns null if the file cannot be read.
 */
function readSource(absPath) {
    try {
        return fs.readFileSync(absPath, 'utf-8');
    } catch {
        return null;
    }
}

/**
 * Extract bindings for a single file using its language's extractBindings
 * implementation. Returns { exports, imports } or empty structures if the
 * language has no parser or the file can't be read.
 *
 * @param {string} absPath — absolute path to the module file
 * @returns {Promise<{exports: object, imports: object[]}>}
 */
async function extractBindingsForFile(absPath) {
    const ext = extOf(absPath);
    if (!ext) return { exports: {}, imports: [] };
    const content = readSource(absPath);
    if (content === null) return { exports: {}, imports: [] };
    try {
        return await languages.extractBindings(content, ext);
    } catch {
        // Language has no extractBindings impl — return empty.
        return { exports: {}, imports: [] };
    }
}

/**
 * Walk the import tree starting from `entryFile` and resolve every
 * binding (named exports, default exports, namespace imports, re-exports).
 *
 * Returns a binding registry keyed by rarebert-relative file path:
 *   {
 *     "scripts/refactor.mjs": {
 *       exports: { main: { line, type }, ... },
 *       imports: [ { binding, localName, source, line, kind, resolvedPath }, ... ]
 *     },
 *     ...
 *   }
 *
 * `resolvedPath` on each import is the rarebert-relative path of the
 * target file, or null if the import is external/unresolvable.
 *
 * @param {string} entryFile — absolute or rarebert-relative path to the entry module
 * @returns {Promise<object>} binding registry
 */
async function resolveBindings(entryFile) {
    const entryAbs = path.isAbsolute(entryFile)
        ? entryFile
        : current.absPath(entryFile);

    // If the entry is a directory, resolve bindings for ALL modules
    // discovered under it (via projects.mjs folder discovery).
    if (fs.existsSync(entryAbs) && fs.statSync(entryAbs).isDirectory()) {
        return resolveAllBindings();
    }

    const visited = new Set();
    const registry = {};

    async function visit(absPath) {
        const rel = current.relPath(absPath);
        if (visited.has(rel)) return;
        visited.add(rel);

        const { exports, imports } = await extractBindingsForFile(absPath);

        // Resolve import sources to absolute paths and add resolvedPath.
        const importRecords = imports.map((imp) => {
            const resolvedAbs = resolveImportPath(absPath, imp.source);
            return {
                ...imp,
                resolvedPath: resolvedAbs ? current.relPath(resolvedAbs) : null
            };
        });

        registry[rel] = { exports, imports: importRecords };

        // Recurse into resolvable project imports.
        for (const imp of importRecords) {
            if (imp.resolvedPath && !visited.has(imp.resolvedPath)) {
                const targetAbs = current.absPath(imp.resolvedPath);
                await visit(targetAbs);
            }
        }
    }

    await visit(entryAbs);
    return registry;
}

/**
 * Check whether a given import resolves to a real export in the registry.
 *
 * @param {object} imp — import record with { binding, kind, resolvedPath }
 * @param {object} registry — binding registry from resolveBindings
 * @returns {boolean}
 */
function isResolvable(imp, registry) {
    if (!imp.resolvedPath) return false;
    const target = registry[imp.resolvedPath];
    if (!target) return false;

    // Side-effect imports and dynamic imports are always "resolvable"
    // if the file exists (which it does, since it's in the registry).
    if (imp.kind === 'sideeffect' || imp.kind === 'dynamic') return true;

    // Default import: target must have a 'default' export.
    if (imp.kind === 'default') {
        return 'default' in target.exports;
    }

    // Namespace import: target must exist (any exports at all).
    if (imp.kind === 'namespace') {
        return Object.keys(target.exports).length > 0;
    }

    // Named import: target must export a binding with this name.
    if (imp.kind === 'named') {
        return imp.binding in target.exports;
    }

    return false;
}

/**
 * After the developer moves a binding, the old export disappears but a
 * new export appears elsewhere. This function searches the current
 * registry for an export matching `bindingName` that either didn't exist
 * in the baseline or existed in a different file.
 *
 * @param {string} bindingName — the binding to search for
 * @param {object} baseline — baseline registry (from snapshot)
 * @param {object} current — current registry
 * @returns {{ file: string, type: string } | null}
 */
function findRelocation(bindingName, baseline, current) {
    for (const [file, info] of Object.entries(current)) {
        if (bindingName in info.exports) {
            // Check if this binding was in the baseline at a different file.
            const inBaseline = Object.entries(baseline).some(
                ([bf, bi]) =>
                    bf !== file &&
                    bindingName in bi.exports
            );
            // Also check if it's a new file not in baseline at all.
            const isFileNew = !(file in baseline);
            if (inBaseline || isFileNew) {
                return { file, type: info.exports[bindingName].type };
            }
            // Binding exists in the same file in both — not a relocation.
            // But if it's missing from the baseline version of this file
            // (file existed but didn't have this binding), it's new here.
            if (file in baseline && !(bindingName in baseline[file].exports)) {
                return { file, type: info.exports[bindingName].type };
            }
        }
    }
    return null;
}

/**
 * Compute which files would have broken imports if the given selection
 * of bindings were moved/renamed/extracted. Read-only — does not edit files.
 *
 * @param {object} registry — current binding registry
 * @param {object} selection — { op, bindings, from, to }
 *   op: 'move' | 'rename' | 'extract'
 *   bindings: string[] — binding names affected
 *   from: string — source file (rarebert-relative)
 *   to: string — target file (rarebert-relative, optional for rename)
 * @returns {{ selection, affectedFiles, blastRadius }}
 */
function whatIf(registry, selection) {
    const blastRadius = [];

    for (const [file, info] of Object.entries(registry)) {
        for (const imp of info.imports) {
            // Does this import reference one of the selected bindings?
            const bindingMatches = selection.bindings.includes(imp.binding);
            const sourceMatches = imp.resolvedPath === selection.from;

            if (!bindingMatches && !sourceMatches) continue;
            if (!isResolvable(imp, registry)) continue;

            blastRadius.push({
                file,
                line: imp.line,
                binding: imp.binding,
                currentSource: imp.source,
                currentResolvedPath: imp.resolvedPath,
                wouldBreak: true,
                suggestedFix: suggestFix(imp, selection)
            });
        }
    }

    return {
        selection,
        affectedFiles: [...new Set(blastRadius.map((b) => b.file))],
        blastRadius
    };
}

/**
 * Suggest the new import statement for a binding after a move/rename/extract.
 *
 * @param {object} imp — import record
 * @param {object} selection — { op, bindings, from, to }
 * @returns {object|null} — { newSource, newBinding } or null
 */
function suggestFix(imp, selection) {
    if (selection.op === 'move' || selection.op === 'extract') {
        if (!selection.to) return null;
        // The binding moves to a new file; update the import source.
        return {
            newSource: selection.to,
            newBinding: imp.binding
        };
    }

    if (selection.op === 'rename') {
        // The binding is renamed; update the binding name in the import.
        // `selection.to` holds the new name for rename operations.
        const newName = selection.to;
        if (!newName) return null;
        return {
            newSource: imp.source,
            newBinding: newName
        };
    }

    return null;
}

/**
 * Compare the current binding state against a saved baseline (stored
 * as a git note on the baseline commit) and find all imports that were
 * healthy before but are now broken.
 *
 * @param {string} entryFile — entry point for re-resolution
 * @param {string} baselineRef — git ref whose refactor note holds the baseline (default: HEAD)
 * @returns {Promise<object>} damage report
 */
async function detectDamage(entryFile, baselineRef = 'HEAD') {
    const snapshot = loadSnapshot(baselineRef);
    if (!snapshot) {
        throw new Error(
            `No refactor snapshot found on ${baselineRef}. Run \`refactor snapshot\` on a clean commit before editing.`
        );
    }

    const currentRegistry = await resolveBindings(entryFile);
    const baseline = snapshot.registry;
    const damage = [];

    for (const [file, info] of Object.entries(baseline)) {
        for (const imp of info.imports) {
            const wasResolvable = isResolvable(imp, baseline);
            const isStillResolvable = isResolvable(imp, currentRegistry);

            if (wasResolvable && !isStillResolvable) {
                const relocated = findRelocation(imp.binding, baseline, currentRegistry);
                damage.push({
                    file,
                    line: imp.line,
                    binding: imp.binding,
                    source: imp.source,
                    issue: `import { ${imp.binding} } from '${imp.source}' — no longer exported`,
                    relocatedTo: relocated
                });
            }
        }
    }

    return {
        entry: entryFile,
        baselineRef: snapshot.baselineRef,
        snapshotTimestamp: snapshot.timestamp,
        damagedFiles: [...new Set(damage.map((d) => d.file))],
        damage
    };
}

/**
 * Capture the current memo state across all modules that have memo
 * sidecars. Returns a map of modulePath → memo content array.
 *
 * This is stored in the baseline note so that post-commit cleanup can
 * identify which pre-snapshot memos are stale (and should be --drop'd)
 * versus which are still relevant.
 */
function captureMemoState() {
    const state = {};
    for (const m of memo.loadAllMemos()) {
        state[m.module.path] = [...m.memos];
    }
    return state;
}

/**
 * Capture the current binding registry as a git note on the given ref
 * (default: HEAD). The note is stored at refs/notes/refactor as a JSON
 * document containing the baseline commit hash, timestamp, the full
 * binding registry, and the pre-existing memo state.
 *
 * The caller (refactor.mjs / Makefile) is responsible for ensuring the
 * working tree is clean and committed before calling this — the note is
 * pinned to a commit, so the baseline is immutable.
 *
 * @param {string} entryFile — entry point for binding resolution
 * @param {string} ref — git ref to attach the note to (default: HEAD)
 * @returns {Promise<object>} the snapshot that was stored
 */
async function saveSnapshot(entryFile, ref = 'HEAD') {
    // Ensure the working tree is clean so the baseline is pinned to a
    // committed state. A snapshot on a dirty tree is meaningless — the
    // note is attached to a commit, but the bindings were resolved from
    // uncommitted source.
    const dirty = git.statusPorcelain();
    if (dirty.length > 0) {
        throw new Error(
            `Working tree is dirty (${dirty.length} changed files).\n` +
                `Run \`make commit\` before \`refactor snapshot\` so the baseline is pinned to a clean commit.`
        );
    }

    const registry = await resolveBindings(entryFile);
    const headSha = git.headRef();
    const snapshot = {
        baselineRef: ref,
        baselineSha: headSha,
        timestamp: Date.now(),
        entry: entryFile,
        registry,
        memoState: captureMemoState()
    };
    const content = JSON.stringify(snapshot);
    git.notesAdd(content, ref, REFACTOR_NOTES_REF);
    return snapshot;
}

/**
 * Load a binding snapshot from a git note on the given ref.
 *
 * @param {string} ref — git ref whose refactor note holds the baseline (default: HEAD)
 * @returns {object|null} the snapshot object, or null if no note exists
 */
function loadSnapshot(ref = 'HEAD') {
    const note = git.notesShow(ref, REFACTOR_NOTES_REF);
    if (!note) return null;
    try {
        const data = JSON.parse(note);
        if (data && data.registry && typeof data.timestamp === 'number') {
            return data;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Check whether a refactor snapshot (git note) exists on the given ref
 * or any of its ancestors. Used by refactor.mjs's no-args path to decide
 * whether to default to `snapshot` (no baseline yet) or `resolve`/`damage`
 * (a refactor session is underway).
 *
 * Walks up to 10 commits from `ref` looking for a refactor note.
 *
 * @param {string} ref — git ref to check (default: HEAD)
 * @returns {boolean} true if a snapshot note exists on ref or an ancestor
 */
function isSnapshotInProgress(ref = 'HEAD') {
    // Check the given ref first.
    if (loadSnapshot(ref)) return true;

    // Walk ancestors: `git log --format=%H -n 10 <ref>`
    const r = git.git('log', ['--format=%H', '-n', '10', ref]);
    if (!r.ok) return false;
    const shas = r.stdout.trim().split('\n').filter(Boolean);
    for (const sha of shas) {
        if (loadSnapshot(sha)) return true;
    }
    return false;
}

/**
 * Resolve bindings across ALL modules in the project (not just one
 * import tree). Useful for full-project refactors.
 *
 * @returns {Promise<object>} binding registry for all project modules
 */
async function resolveAllBindings() {
    const modules = listAllModules();
    const registry = {};

    for (const mod of modules) {
        const rel = mod.path;
        if (rel in registry) continue;
        const { exports, imports } = await extractBindingsForFile(mod.abs);
        const importRecords = imports.map((imp) => {
            const resolvedAbs = resolveImportPath(mod.abs, imp.source);
            return {
                ...imp,
                resolvedPath: resolvedAbs ? current.relPath(resolvedAbs) : null
            };
        });
        registry[rel] = { exports, imports: importRecords };
    }

    return registry;
}

// ─── Memo Automation ───────────────────────────────────────────

/**
 * Run opencode headlessly with a prompt and return the text output.
 * Uses the same `opencode run --auto --format json` pattern as
 * scripts/commit.mjs. Returns an empty string on failure.
 *
 * @param {string} prompt — the prompt to send
 * @param {string} [model] — optional model override
 * @returns {string} opencode's text response
 */
function runOpencode(prompt, model) {
    const bin = opencode.resolve();
    const args = ['run', prompt, '--auto', '--format', 'json'];
    if (model) args.push('-m', model);

    const result = spawnSync(bin, args, {
        cwd: current.root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit']
    });

    if (result.error || result.status !== 0) {
        console.error(
            `opencode ${result.error ? 'failed to launch: ' + result.error.message : 'exited with status ' + result.status}`
        );
        return '';
    }

    // Parse JSON event stream — extract text parts from the response.
    // The format is newline-delimited JSON objects with a "type" field.
    const textParts = [];
    for (const line of (result.stdout || '').split('\n')) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line);
            if (event.type === 'text' && event.content) {
                textParts.push(event.content);
            }
        } catch {
            // Not a JSON line — skip.
        }
    }
    return textParts.join('').trim();
}

/**
 * Given a damage report, generate per-module memo summaries via
 * opencode. Each affected module gets a concise memo describing what
 * broke and where bindings moved (if known).
 *
 * The summaries are added as memos to the affected modules immediately.
 *
 * @param {object} damageReport — from detectDamage()
 * @param {string} [model] — optional model override for opencode
 * @returns {Promise<Array<{module: string, memo: string}>>} generated memos
 */
async function generateDamageMemos(damageReport, model) {
    if (!damageReport.damage || damageReport.damage.length === 0) return [];

    // Group damage by file so we can generate one memo per affected module.
    const byFile = {};
    for (const d of damageReport.damage) {
        if (!byFile[d.file]) byFile[d.file] = [];
        byFile[d.file].push(d);
    }

    const generated = [];

    for (const [file, damages] of Object.entries(byFile)) {
        const damageLines = damages
            .map(
                (d) =>
                    `  line ${d.line}: import { ${d.binding} } from '${d.source}' — no longer exported` +
                    (d.relocatedTo ? ` (relocated to ${d.relocatedTo.file})` : '')
            )
            .join('\n');

        const prompt = [
            `A refactor was performed on this codebase. The following import breakages were detected in the module "${file}":`,
            ``,
            damageLines,
            ``,
            `Write a single concise memo (1-2 sentences, max 200 chars) summarizing what broke in this module and what needs to be fixed.`,
            `This memo will be stored as a reminder for future editing sessions.`,
            `Output ONLY the memo text — no preamble, no labels, no markdown fences.`
        ].join('\n');

        const summary = runOpencode(prompt, model);
        if (summary) {
            memo.remember(file, summary);
            generated.push({ module: file, memo: summary });
            console.log(`  ✓ memo added to ${file}: ${summary.slice(0, 80)}...`);
        }
    }

    return generated;
}

/**
 * Given a what-if blast-radius result, record a memo on the source
 * module (--from) documenting the blast radius of the proposed
 * refactor. This gives future sessions context on what was considered.
 *
 * @param {object} blastRadius — from whatIf()
 * @param {object} selection — the selection that was analyzed
 * @returns {void}
 */
function recordBlastRadiusMemo(blastRadius, selection) {
    if (!blastRadius.blastRadius || blastRadius.blastRadius.length === 0) {
        const memoText = `What-if (${selection.op} ${selection.bindings.join(', ')} from ${selection.from}): no affected files — safe to proceed.`;
        memo.remember(selection.from, memoText);
        console.log(`  ✓ blast-radius memo added to ${selection.from}: no affected files.`);
        return;
    }

    const affectedList = blastRadius.affectedFiles.join(', ');
    const memoText =
        `What-if (${selection.op} ${selection.bindings.join(', ')} from ${selection.from}` +
        (selection.to ? ` to ${selection.to}` : '') +
        `): ${blastRadius.blastRadius.length} imports would break across ` +
        `${blastRadius.affectedFiles.length} files (${affectedList}).`;

    memo.remember(selection.from, memoText);
    console.log(
        `  ✓ blast-radius memo added to ${selection.from}: ${blastRadius.blastRadius.length} imports affected.`
    );
}

/**
 * Post-commit memo cleanup: compare the current memo state against the
 * pre-snapshot memo state stored in the baseline note. For each module
 * that had pre-snapshot memos, identify stale entries (those that
 * existed in the baseline but no longer match the current code state)
 * and drop them by index. Then add the new opencode-generated
 * summaries.
 *
 * This is the final step in the refactor lifecycle:
 *   snapshot → edit → damage → generate memos → commit → cleanup
 *
 * @param {string} baselineRef — git ref with the baseline note (default: HEAD~1, since we just committed)
 * @param {Array<{module: string, memo: string}>} newMemos — memos generated by generateDamageMemos
 * @returns {Promise<Array<{module: string, dropped: number, added: number}>>} cleanup summary
 */
async function cleanupMemos(baselineRef = 'HEAD~1', newMemos = []) {
    const snapshot = loadSnapshot(baselineRef);
    if (!snapshot || !snapshot.memoState) {
        console.error(
            `cleanupMemos: no baseline memo state found on ${baselineRef}. ` +
                `Was the snapshot taken before the refactor?`
        );
        return [];
    }

    const baselineMemos = snapshot.memoState;
    const newMemoModules = new Set(newMemos.map((m) => m.module));
    const summary = [];

    // For each module that had pre-snapshot memos AND is in the new-memo
    // set (i.e. was affected by the refactor), drop the stale entries.
    for (const [modulePath, oldMemos] of Object.entries(baselineMemos)) {
        if (!newMemoModules.has(modulePath)) continue;

        // Load current memos for this module.
        const current = memo.loadMemos(modulePath).flatMap((m) => m.content);

        // Find indices of stale pre-snapshot memos that are still present.
        // A stale memo is one that existed in the baseline AND still exists
        // unchanged in the current sidecar (it hasn't been updated).
        const staleIndices = [];
        for (let i = 0; i < current.length; i++) {
            if (oldMemos.includes(current[i])) {
                staleIndices.push(i);
            }
        }

        if (staleIndices.length > 0) {
            // Drop stale memos by filtering them out and rewriting the sidecar.
            const remaining = current.filter((_, i) => !staleIndices.includes(i));
            const sidecar = current.absPath(modulePath) + '.';
            if (remaining.length === 0) {
                try {
                    fs.unlinkSync(sidecar);
                } catch {
                    /* already absent */
                }
            } else {
                // Re-add the new memos so they're not lost.
                const newForThis = newMemos
                    .filter((m) => m.module === modulePath)
                    .map((m) => m.memo);
                const finalContent = [...remaining, ...newForThis];
                fs.writeFileSync(
                    sidecar,
                    JSON.stringify(
                        {
                            name: path.basename(modulePath, path.extname(modulePath)),
                            content: finalContent,
                            lastModified: Date.now()
                        },
                        null,
                        2
                    ) + '\n'
                );
            }
            console.log(
                `  ✓ cleaned ${modulePath}: dropped ${staleIndices.length} stale, kept ${remaining.length}`
            );
            summary.push({
                module: modulePath,
                dropped: staleIndices.length,
                added: newMemos.filter((m) => m.module === modulePath).length
            });
        }
    }

    return summary;
}

export {
    resolveImportPath,
    extractBindingsForFile,
    resolveBindings,
    resolveAllBindings,
    isResolvable,
    findRelocation,
    whatIf,
    suggestFix,
    detectDamage,
    saveSnapshot,
    loadSnapshot,
    isSnapshotInProgress,
    captureMemoState,
    generateDamageMemos,
    recordBlastRadiusMemo,
    cleanupMemos,
    runOpencode,
    REFACTOR_NOTES_REF
};