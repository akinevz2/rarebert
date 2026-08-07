#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { rarebert } from '../lib/projects.mjs';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { memo } from '../lib/memo.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

const META = {
    name: 'memo',
    description: 'Inspect and mutate memos stored alongside modules',
    usage: 'node index.js memo [files...|--all|--add <path> <memo>...|--commit [--yes] [--fresh]|--log [files...]|--recall <ref> [files...]]',
    options: [
        { flag: '', label: '(no args)', description: 'TUI: select a module to add a memo to' },
        { flag: 'all', label: '--all', description: 'Print all memos (flat, oldest-first)' },
        {
            flag: 'files',
            label: '<files/folders>',
            description: 'Print memos only for modules within the given set'
        },
        {
            flag: 'files --all',
            label: '<files/folders> --all',
            description: 'Ancestor-traversal: print memos for the set and its ancestors'
        },
        {
            flag: 'add',
            label: '--add <path> <memo>',
            description: 'Add a memo non-interactively; repeat --add for multiple'
        },
        {
            flag: 'commit',
            label: '--commit [--yes] [--fresh]',
            description:
                'Snapshot memos to git notes (TUI confirm; --yes skips; --fresh clears after)'
        },
        {
            flag: 'log',
            label: '--log [files...]',
            description: 'Show memo snapshot history, optionally filtered to filenames'
        },
        {
            flag: 'recall',
            label: '--recall <ref> [files...]',
            description: 'Restore memos for filenames from a git notes snapshot ref'
        },
        {
            flag: 'drop',
            label: '--drop <module> [indexes, 1-based]',
            description: 'Remove selected memos for a module (interactive)'
        },
        {
            flag: 'forget',
            label: '--forget <module> [module ...]',
            description: 'Remove all memos (sidecar) for one or more modules'
        }
    ]
};

// ---------------------------------------------------------------------------
// Shared constants & helpers
// ---------------------------------------------------------------------------

const YELLOW_TICK = '\x1b[33m✓\x1b[0m';
const RED_BOLD = '\x1b[1;31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Resolve a single module argument (path, name, or absolute path) to a
 * module object plus its derived relative path and sidecar path.
 *
 * @returns {{ module, rel, sidecar } | null}
 */
function resolveModule(arg, modules) {
    const rel = path.isAbsolute(arg) ? rarebert.relPath(arg) : arg;
    const mod =
        modules.find((m) => m.path === rel) ||
        modules.find((m) => m.path.endsWith(rel)) ||
        modules.find((m) => m.name === arg || m.name === path.basename(rel, path.extname(rel)));
    if (!mod) return null;
    return { module: mod, rel: mod.path, sidecar: mod.memoFile() };
}

function printMemoAdded(rel) {
    console.log(`${YELLOW_TICK} Memo added to ${rel}`);
}

async function promptMemoContent(initial = '') {
    return cli.input('Enter memo content:', {
        initial,
        validate: (v) => (v.trim() ? true : 'required')
    });
}

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split argv into a list of { flags: string[], positional: string[] } groups,
 * where each `--flag` starts a new group that consumes following positionals
 * until the next `--flag`. Non-flag positionals before any flag form a leading
 * group with an empty flags array.
 */
function groupArgs(argv) {
    const groups = [];
    let current = { flags: [], positional: [] };
    groups.push(current);
    for (const arg of argv) {
        if (arg.startsWith('--')) {
            if (current.flags.length || current.positional.length) {
                current = { flags: [arg], positional: [] };
                groups.push(current);
            } else {
                current.flags.push(arg);
            }
        } else {
            current.positional.push(arg);
        }
    }
    return groups.filter((g) => g.flags.length || g.positional.length);
}

/**
 * Resolve a list of file/folder arguments to a set of resolved module
 * descriptors ({ module, rel, sidecar }). Folders expand to all modules
 * under them. Unmatched args print a warning.
 */
function resolveModuleSet(args, modules) {
    const result = [];
    const seen = new Set();
    for (const arg of args) {
        const abs = path.isAbsolute(arg) ? arg : path.resolve(rarebert.root, arg);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            for (const m of modules) {
                if ((m.abs.startsWith(abs + path.sep) || m.abs === abs) && !seen.has(m.path)) {
                    seen.add(m.path);
                    result.push({ module: m, rel: m.path, sidecar: m.memoFile() });
                }
            }
            continue;
        }
        const resolved = resolveModule(arg, modules);
        if (resolved) {
            if (!seen.has(resolved.rel)) {
                seen.add(resolved.rel);
                result.push(resolved);
            }
        } else {
            console.error(`memo: no module matched "${arg}"`);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------

function printFlatMemos(entries) {
    if (entries.length === 0) {
        console.log('No memos found.');
        return false;
    }
    const flat = [];
    for (const { module, memos: contents, lastModified } of entries) {
        for (const content of contents) {
            flat.push({ path: module.path, content, lastModified });
        }
    }
    flat.sort((a, b) => a.lastModified - b.lastModified);
    for (const { path: p, content } of flat) {
        console.log(`${p}  ${content}`);
    }
    return true;
}

/**
 * Print the memo DAG, optionally filtered to a set of resolved module
 * descriptors. When a set is given, ancestors are emitted before the
 * members that reference them (deepest-first).
 */
function printDagForSet(resolvedSet) {
    const groups = memo.walkAll();
    if (groups.length === 0) {
        console.log('No memos found.');
        return false;
    }

    const totalCycles = groups.totalCycles ?? 0;
    const cyclePaths = groups.cycles ?? [];
    const wanted = resolvedSet ? new Set(resolvedSet.map((r) => r.rel)) : null;
    const byPath = new Map(groups.map((g) => [g.path, g]));
    const emitted = new Set();
    let shown = 0;

    const emitGroup = (groupPath, indent) => {
        if (emitted.has(groupPath)) return;
        emitted.add(groupPath);
        const g = byPath.get(groupPath);
        if (!g) return;

        for (const entry of g.related) {
            if (!entry.cycle) emitGroup(entry.path, true);
        }

        shown++;
        const prefix = indent ? '  ' : '';
        const style = indent ? DIM : '\x1b[1m';
        console.log(`\n${style}${prefix}${g.path}${RESET}`);

        if (g.related.length) {
            for (let i = 0; i < g.related.length; i++) {
                const entry = g.related[i];
                const isLast = i === g.related.length - 1;
                const branch = isLast ? '└── ' : '├── ';
                if (entry.cycle) {
                    console.log(`${prefix}  ${RED_BOLD}${branch}${entry.path} ↻${RESET}`);
                } else {
                    console.log(`${prefix}  ${DIM}${branch}${entry.path}${RESET}`);
                }
            }
        }

        for (const content of g.memos) {
            console.log(`${prefix}  ${content}`);
        }
    };

    if (wanted) {
        for (const { path } of groups) {
            if (wanted.has(path)) emitGroup(path, false);
        }
    } else {
        for (const { path } of groups) emitGroup(path, false);
    }

    if (shown === 0) {
        console.log('No memos found for the given modules.');
        return false;
    }
    if (totalCycles > 0) {
        console.log(
            `\n${RED_BOLD}⚠ ${totalCycles} cyclic import${totalCycles === 1 ? '' : 's'} detected:${RESET}`
        );
        for (const c of cyclePaths) {
            console.log(`  ${RED_BOLD}${c.path.join(' → ')}${RESET}`);
        }
    }
    console.log();
    return true;
}

// ---------------------------------------------------------------------------
// --drop helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated indices string into 0-based array indices.
 * 1-based positive; negative counts from end; 0 is invalid.
 */
function parseIndices(arg, count) {
    if (count === 0) {
        console.error('No memos to drop.');
        return null;
    }
    const raw = arg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (!raw.length) {
        console.error(`No indices provided in "${arg}".`);
        return null;
    }

    const indices = [];
    for (const token of raw) {
        const n = parseInt(token, 10);
        if (Number.isNaN(n)) {
            console.error(`Invalid index "${token}"; expected an integer.`);
            return null;
        }
        if (n === 0) {
            console.error(
                `Index 0 is invalid; indices are 1-based (use 1 for the first memo, -1 for the last).`
            );
            return null;
        }
        const idx = n > 0 ? n - 1 : count + n;
        if (idx < 0 || idx >= count) {
            const range = `1–${count} (or -1 to -${count} from end)`;
            console.error(`Index ${n} is out of bounds; valid range: ${range}.`);
            return null;
        }
        indices.push(idx);
    }
    return indices;
}

function applyDrop(resolved, selected) {
    const remaining = memo
        .loadMemos(resolved.rel)
        .flatMap((m) => m.content)
        .filter((c) => !selected.includes(c));
    if (!remaining.length) {
        try {
            fs.unlinkSync(resolved.sidecar);
        } catch {
            /* already absent */
        }
    } else {
        fs.writeFileSync(
            resolved.sidecar,
            JSON.stringify(
                { name: resolved.module.name, content: remaining, lastModified: Date.now() },
                null,
                2
            ) + '\n'
        );
    }
    console.log(`Dropped ${selected.length} memo(s) from ${resolved.rel}`);
}

async function multiSelectMemos(resolved) {
    const memos = memo.loadMemos(resolved.rel).flatMap((m) => m.content);
    if (!memos.length) return [];

    const { default: Enquirer } = await import('enquirer');
    const prompt = new Enquirer.MultiSelect({
        name: 'memos',
        message: `Select memos to drop:`,
        choices: memos.map((content, idx) => ({
            name: idx.toString(),
            message: content,
            value: content
        }))
    });
    try {
        const result = await prompt.run();
        return result.map((idx) => memos[parseInt(idx, 10)]);
    } catch {
        throw new AbortError();
    }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * Interactive module selection with priority-ordered fuzzy search.
 *
 * Matching tiers (highest priority first):
 *   1. Module name — the `name` field (e.g. "scripts/edit.mjs") fuzzy-
 *      matches the query.
 *   2. Preamble — the literal "add memo to <module>" prefix fuzzy-matches
 *      the query (matches the action phrase).
 *   3. Entire string — the full `message` (label + description) fuzzy-
 *      matches the query anywhere (proximity fallback).
 *
 * Fuzzy matching: each whitespace-separated query token must appear as
 * a substring (in order) somewhere in the target text, but the tokens
 * need not be contiguous. E.g. "add memo to check" matches
 * "add memo to scripts/check.mjs" because every token is a substring.
 *
 * Within each tier, results keep their original display order. The
 * special "__view" and "__exit" choices always stay at the top/bottom
 * respectively and are only matched by a direct hit so they don't
 * drown out module results on a partial query.
 *
 * Keybindings: ctrl-w and ctrl-backspace delete the previous word
 * (not just one char) since Enquirer's Select/AutoComplete prompts
 * don't inherit cutLeft from the String input type.
 *
 * Falls back to cli.select (plain Select, no search) when not
 * interactive so non-interactive callers still get deterministic output.
 */
async function selectModuleWithSearch(message, choices, options = {}) {
    if (!cli.isInteractive()) {
        return cli.select(message, choices, options);
    }

    const { limit = 10 } = options;

    // Pre-compute the module name, basename, and preamble for each choice
    // so the suggest function doesn't re-parse on every keystroke.
    const indexed = choices.map((c) => {
        const msg = (c.message || '').toLowerCase();
        const name = (c.name || '').toLowerCase();
        // Basename without extension (e.g. "core" from "lib/core.mjs") —
        // a basename match is more specific than a path substring match.
        const basename = name.replace(/^.*\//, '').replace(/\.\w+$/, '');
        // Preamble is "add memo to <module> ..."; extract the module path
        // portion for tier-1 matching against the `name` field instead.
        const preambleMatch = msg.match(/^add memo to (\S+)/);
        const preambleMod = preambleMatch ? preambleMatch[1].toLowerCase() : '';
        return { choice: c, name, basename, msg, preambleMod };
    });

    // Special entries that should stay pinned unless explicitly searched.
    const specials = new Set(['__view', '__exit']);

    /**
     * Fuzzy match: every whitespace-separated token in the query must
     * appear as a substring of the text (case-insensitive). Tokens are
     * matched in order but need not be contiguous.
     */
    const fuzzyMatch = (text, query) => {
        const tokens = query.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return true;
        let pos = 0;
        for (const token of tokens) {
            const idx = text.indexOf(token, pos);
            if (idx === -1) return false;
            pos = idx + token.length;
        }
        return true;
    };

    const { default: Enquirer } = await import('enquirer');

    // Enquirer's default keybinding maps (combos.ctrl, combos.keys, etc.)
    // are shallow-merged via { ...combos, ...customActions } in
    // keypress.action(), so providing a custom `ctrl` object would wipe
    // out ctrl-c (cancel), ctrl-a (first), enter/return, arrows, etc.
    // Inline the defaults from enquirer/lib/combos.js and spread them
    // into each sub-map so only the keys we override are replaced.
    const DEFAULT_CTRL = {
        a: 'first',
        b: 'backward',
        c: 'cancel',
        d: 'deleteForward',
        e: 'last',
        f: 'forward',
        g: 'reset',
        i: 'tab',
        k: 'cutForward',
        l: 'reset',
        n: 'newItem',
        m: 'cancel',
        j: 'submit',
        p: 'search',
        r: 'remove',
        s: 'save',
        u: 'undo',
        w: 'cutLeft',
        x: 'toggleCursor',
        v: 'paste'
    };
    const DEFAULT_KEYS = {
        pageup: 'pageUp',
        pagedown: 'pageDown',
        home: 'home',
        end: 'end',
        cancel: 'cancel',
        delete: 'deleteForward',
        backspace: 'delete',
        down: 'down',
        enter: 'submit',
        escape: 'cancel',
        left: 'left',
        space: 'space',
        number: 'number',
        return: 'submit',
        right: 'right',
        tab: 'next',
        up: 'up'
    };

    const prompt = new Enquirer.AutoComplete({
        name: 'memo',
        message,
        choices,
        limit,
        // Custom keybindings: wire ctrl-w and ctrl-backspace to a
        // word-deletion action since AutoComplete (which extends Select,
        // not String) lacks the cutLeft method that the String input
        // type defines.
        actions: {
            ctrl: { ...DEFAULT_CTRL, w: 'deleteWordLeft', h: 'deleteWordLeft' },
            keys: { ...DEFAULT_KEYS, backspace: 'deleteWordLeftIfCtrl' }
        },
        // Enquirer looks up this.options[action] before this[action], so
        // we provide deleteWordLeft as an option-level method bound to
        // the prompt instance.
        deleteWordLeft(input, key) {
            const inputVal = this.input || '';
            if (!inputVal) return this.alert();
            // Delete back to the previous word boundary
            const trimmed = inputVal.replace(/\s+$/, '');
            const lastSpace = trimmed.lastIndexOf(' ');
            this.input = lastSpace >= 0 ? trimmed.slice(0, lastSpace) : '';
            this.cursor = this.input.length;
            this.render();
        },
        deleteWordLeftIfCtrl(input, key) {
            // ctrl-backspace arrives as backspace with ctrl flag in some
            // terminals; plain backspace should still delete one char.
            if (key && key.ctrl) {
                return this.options.deleteWordLeft.call(this, input, key);
            }
            // Fall through to default single-char delete
            return this.delete.call(this, input, key);
        },
        // Filter out unsupported ctrl/alt keycodes that would otherwise
        // be appended as the literal string "undefined" into the search
        // input. Alert (beep) and re-render so the user gets feedback
        // that the key was ignored, without the input being corrupted.
        dispatch(ch, key) {
            if (ch === undefined || ch === null || typeof ch !== 'string' || !ch.trim()) {
                return this.alert();
            }
            // Skip control characters (ctrl+letter produces \x01-\x1a)
            if (ch.charCodeAt(0) < 32) {
                return this.alert();
            }
            return this.append(ch);
        },
        suggest(input) {
            const q = (input || '').toLowerCase().trim();
            if (!q) return choices;

            const tokens = q.split(/\s+/).filter(Boolean);
            const pinned = []; // __view/__exit if they match

            // Fuzzy filter: every token must appear somewhere in the
            // full displayed message (unordered). If any token is
            // missing, the choice is excluded entirely.
            const allTokensInMsg = (msg) => tokens.every((t) => msg.includes(t));
            const lastToken = tokens[tokens.length - 1];

            // Priority-ordered buckets. Each choice goes into the
            // highest-priority bucket it qualifies for (first match
            // wins). Buckets are concatenated in order, skipping empty
            // ones, so the first non-empty bucket's results appear
            // first. Within a bucket, original display order is kept.
            //
            // Priority (most intentional → least):
            //   1. last token matches basename  — "add to memo" → lib/memo.mjs
            //   2. any token matches basename    — "add memo to add" → scripts/add.mjs
            //   3. last token matches full path  — "add to scripts/check" → scripts/check.mjs
            //   4. any token matches full path    — "lib/co" → lib/core.mjs
            //   5. all tokens in message (fuzzy) — fallback
            const buckets = [[], [], [], [], []];
            for (const item of indexed) {
                const { choice, name, basename, msg, preambleMod } = item;
                if (specials.has(choice.name)) {
                    if (fuzzyMatch(name, q) || fuzzyMatch(msg, q)) {
                        pinned.push(choice);
                    }
                    continue;
                }

                if (!allTokensInMsg(msg)) continue;

                if (basename.includes(lastToken)) {
                    buckets[0].push(choice);
                } else if (tokens.some((t) => basename.includes(t))) {
                    buckets[1].push(choice);
                } else if (name.includes(lastToken) || preambleMod.includes(lastToken)) {
                    buckets[2].push(choice);
                } else if (tokens.some((t) => name.includes(t) || preambleMod.includes(t))) {
                    buckets[3].push(choice);
                } else {
                    buckets[4].push(choice);
                }
            }

            return [...pinned, ...buckets.flat()];
        }
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

async function cmdBare(modules) {
    if (modules.length === 0) {
        cli.fail('No modules found.');
    }

    const choices = [{ name: '__view', message: 'view — print all memos' }];
    for (const m of modules) {
        const meta = rarebert.getScriptMetadata(m.abs);
        const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
        const label = desc ? `add memo to ${m.path} — ${desc}` : `add memo to ${m.path}`;
        choices.push({ name: m.path, message: cli.truncate(label) });
    }
    choices.push({ name: '__exit', message: 'exit' });

    const selection = await selectModuleWithSearch('Memo', choices, { limit: 8 });

    if (selection === '__exit') return;
    if (selection === '__view') {
        printDagForSet(null);
        return;
    }

    const target = modules.find((m) => m.path === selection);
    if (!target) return;
    const content = await promptMemoContent();
    memo.remember(target.path, content);
    printMemoAdded(target.path);
}

function cmdPrintSet(resolvedSet, withAncestors) {
    if (withAncestors) {
        printDagForSet(resolvedSet);
    } else {
        const setPaths = new Set(resolvedSet.map((r) => r.rel));
        const all = memo.loadAllMemos().filter((e) => setPaths.has(e.module.path));
        printFlatMemos(all);
    }
}

function cmdPrintAll() {
    printFlatMemos(memo.loadAllMemos());
}

async function cmdAdd(groups, modules) {
    for (const g of groups) {
        if (g.flags[0] !== '--add') continue;
        const [modArg, ...rest] = g.positional;
        if (!modArg) {
            console.error('memo --add: missing module path');
            continue;
        }
        const content = rest.join(' ').trim();
        if (!content) {
            console.error(`memo --add: missing memo content for "${modArg}"`);
            continue;
        }
        const resolved = resolveModule(modArg, modules);
        if (!resolved) {
            console.error(`memo --add: module not found: ${modArg}`);
            continue;
        }
        memo.remember(resolved.rel, content);
        printMemoAdded(resolved.rel);
    }
}

async function cmdCommit(isYes, isFresh) {
    const label = 'memo snapshot';
    const hadMemos = memo.loadAllMemos().length > 0;
    if (!hadMemos) {
        console.log('No memos to commit.');
        return;
    }
    if (!isYes) {
        const ok = await cli.confirm('Commit memos to git notes?');
        if (!ok) {
            console.log('Aborted; memos not committed.');
            return;
        }
    }
    memo.snapshot(label);
    if (isFresh) {
        memo.forgetAll();
        console.log('Fresh slate (working sidecars cleared).');
    }
    memo.clearBuffer();
}

function cmdLog(nonFlag) {
    const entries = memo.logEntries();
    if (entries.length === 0) {
        console.log('memo: no snapshots in refs/notes/memos');
        return;
    }
    const wanted = nonFlag.length ? new Set(nonFlag) : null;
    let shown = 0;
    for (const e of entries) {
        if (wanted) {
            const hits = e.modules.filter((m) => wanted.has(m));
            if (hits.length === 0) continue;
            console.log(`${e.date}  ${e.subject}  [${hits.join(', ')}]`);
        } else {
            console.log(`${e.date}  ${e.subject}`);
        }
        shown++;
    }
    if (shown === 0) {
        console.log('memo: no snapshots reference the given filenames');
    }
}

function cmdRecall(ref, nonFlag) {
    if (!ref) {
        console.error('memo --recall: missing ref argument');
        return;
    }
    memo.restore(ref, nonFlag.length ? nonFlag : null);
    memo.clearBuffer();
}

async function cmdDrop(moduleArg, indicesArg, modules) {
    if (!moduleArg) {
        cli.fail("A memo'd module must be specified for --drop.");
    }

    const target = await promptModule(modules, moduleArg, 'Select module to drop memos from');
    const resolved = { module: target, rel: target.path, sidecar: target.memoFile() };

    const allMemos = memo.loadMemos(resolved.rel).flatMap((m) => m.content);
    if (!allMemos.length) {
        console.log('No memos found for this module.');
        return;
    }

    if (process.stdin.isTTY !== true) {
        if (!indicesArg) {
            console.error(
                `Error: missing indices argument for non-interactive --drop:\n` +
                    `Non-interactive mode cannot prompt for memo selection.\n` +
                    `  Pass comma-separated indices (1 for first, -1 for last): --drop ${moduleArg} 1,3,-1\n` +
                    `  Or to remove all memos for this module, use: --forget ${moduleArg}`
            );
            cli.fail();
        }
        const indices = parseIndices(indicesArg, allMemos.length);
        if (!indices) return;
        applyDrop(
            resolved,
            indices.map((i) => allMemos[i])
        );
        return;
    }

    let selected;
    if (indicesArg) {
        const indices = parseIndices(indicesArg, allMemos.length);
        if (!indices) return;
        selected = indices.map((i) => allMemos[i]);

        console.log(`\n\x1b[1mMemos to drop from ${resolved.rel}:\x1b[0m`);
        for (const [i, content] of selected.entries()) {
            console.log(`  ${indicesArg.split(',')[i]?.trim() || i + 1}. ${content}`);
        }
        console.log();
        const confirmed = await cli.select('Proceed?', [
            { name: 'drop', message: 'Drop the listed memos' },
            { name: 'cancel', message: 'Cancel' }
        ]);
        if (confirmed === 'cancel') {
            console.log('Aborted; no memos dropped.');
            return;
        }
    } else {
        selected = await multiSelectMemos(resolved);
    }

    if (!selected.length) {
        console.log('No memos selected; nothing dropped.');
        return;
    }
    applyDrop(resolved, selected);
}

function cmdForget(moduleArgs, modules) {
    if (!moduleArgs || moduleArgs.length === 0) {
        console.error('memo --forget: missing module argument');
        return;
    }

    // Resolve every argument first; if any module is not found, error
    // out completely without forgetting anything.
    const resolved = [];
    for (const moduleArg of moduleArgs) {
        const r = resolveModule(moduleArg, modules);
        if (!r) {
            console.error(`memo --forget: module not found: ${moduleArg}`);
            return;
        }
        resolved.push(r);
    }

    for (const r of resolved) {
        if (!fs.existsSync(r.sidecar)) {
            console.log(`${YELLOW_TICK} No memos were found on ${r.rel}`);
            continue;
        }
        memo.forgetByPath(r.rel);
        console.log(`${YELLOW_TICK} Forgot all memos for ${r.rel}`);
    }
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(args = []) {
    const groups = groupArgs(args);
    const allFlags = args.filter((a) => a.startsWith('--'));
    const nonFlag = args.filter((a) => (!a.startsWith('-') || /^-?\d+$/.test(a)) && a);
    const modules = listAllModules();

    const has = (f) => allFlags.includes(f);

    if (has('--add')) {
        await cmdAdd(groups, modules);
        return;
    }

    if (has('--commit')) {
        await cmdCommit(has('--yes'), has('--fresh'));
        return;
    }

    if (has('--log')) {
        cmdLog(nonFlag);
        return;
    }

    if (has('--recall')) {
        cmdRecall(nonFlag[0], nonFlag.slice(1));
        return;
    }

    if (has('--drop')) {
        await cmdDrop(nonFlag[0], nonFlag[1], modules);
        memo.clearBuffer();
        return;
    }

    if (has('--forget')) {
        cmdForget(nonFlag, modules);
        return;
    }

    if (has('--all')) {
        if (nonFlag.length) {
            const resolvedSet = resolveModuleSet(nonFlag, modules);
            cmdPrintSet(resolvedSet, true);
        } else {
            printDagForSet(null);
        }
        return;
    }

    if (nonFlag.length) {
        const resolvedSet = resolveModuleSet(nonFlag, modules);
        cmdPrintSet(resolvedSet, false);
        return;
    }

    await cmdBare(modules);
}

export { main };

export default {
    ...META,
    main
};
