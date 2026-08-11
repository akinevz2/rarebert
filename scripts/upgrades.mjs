#!/usr/bin/env node

import fs from 'fs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'upgrades',
    description:
        'Compare local tree against origin/main: report added/modified/deleted files, identify added modules, and itemise newly-added methods per module',
    usage: 'node index.js upgrades [--base <ref>]',
    options: [
        {
            flag: '--base <ref>',
            description: 'base ref to diff against (default: origin/main)'
        }
    ]
};

const MODULE_EXT = new Set(['.mjs', '.js', '.py']);

/**
 * Parse a single `git diff --name-status` row into a descriptor.
 *
 * `git diff --name-status` emits lines like:
 *   M\tpath/to/file
 *   A\tpath/to/added
 *   R100\told/path\tnew/path
 *   C100\tsrc\tdst
 *
 * @param {string} line
 * @returns {{ status: string, path: string, from?: string } | null}
 */
function parseNameStatusLine(line) {
    if (!line) return null;
    const parts = line.split('\t');
    if (parts.length < 2) return null;
    const status = parts[0];
    if (status.length === 0) return null;
    // Renames and copies carry a similarity score: R100 / C75 etc.
    // The first char is the operation: A/M/D/R/C/T/U/X/B
    const op = status[0];
    if (status.length > 1 && (op === 'R' || op === 'C') && parts.length >= 3) {
        return { status, op, from: parts[1], path: parts[2] };
    }
    return { status, op, path: parts[1] };
}

/**
 * Run `git diff --name-status <base> HEAD` via the whitelisted git
 * interface and return the parsed rows.
 *
 * @param {string} base
 * @returns {{ status: string, op: string, path: string, from?: string }[]}
 */
function collectChanges(base) {
    const r = git.git('diff', ['--name-status', `${base}`, 'HEAD']);
    if (!r.ok) {
        throw new Error(`git diff --name-status ${base} HEAD failed: ${r.stderr.trim() || r.status}`);
    }
    return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseNameStatusLine)
        .filter(Boolean);
}

/**
 * Group change rows by their leading operation code.
 *
 * @param {{ op: string }[]} rows
 * @returns {{ added, modified, deleted, renamed, copied, other }}
 */
function categorize(rows) {
    const buckets = {
        added: [],
        modified: [],
        deleted: [],
        renamed: [],
        copied: [],
        other: []
    };
    for (const row of rows) {
        switch (row.op) {
            case 'A':
                buckets.added.push(row);
                break;
            case 'M':
                buckets.modified.push(row);
                break;
            case 'D':
                buckets.deleted.push(row);
                break;
            case 'R':
                buckets.renamed.push(row);
                break;
            case 'C':
                buckets.copied.push(row);
                break;
            default:
                buckets.other.push(row);
                break;
        }
    }
    return buckets;
}

/**
 * Determine whether a path looks like a Rarebert module (lives in
 * scripts/, lib/, or src/ and has a known module extension).
 *
 * @param {string} p
 * @returns {boolean}
 */
function isModulePath(p) {
    const ext = p.slice(p.lastIndexOf('.'));
    if (!MODULE_EXT.has(ext)) return false;
    return (
        p.startsWith('scripts/') ||
        p.startsWith('lib/') ||
        p.startsWith('src/') ||
        p.startsWith('supports/')
    );
}

/**
 * Extract exported and local function/method names from a JS/Python
 * module's source text.
 *
 * Recognises:
 *   - export function name(...)        (JS)
 *   - export async function name(...)  (JS)
 *   - function name(...)               (JS)
 *   - async function name(...)         (JS)
 *   - export const name = ...          (JS arrow/const)
 *   - class Name { ... method(...) }   (JS class methods)
 *   - def name(...)                    (Python)
 *   - async def name(...)              (Python)
 *
 * Returns a list of `{ kind, name, exported }` sorted by appearance.
 *
 * @param {string} source
 * @param {string} ext
 * @returns {{ kind: string, name: string, exported: boolean }[]}
 */
function extractMethods(source, ext) {
    const out = [];
    if (ext === '.py') {
        const re = /(?:(?:^|\n)\s*)(?:async\s+)?def\s+(\w+)\s*\(/g;
        let m;
        while ((m = re.exec(source)) !== null) {
            out.push({ kind: 'def', name: m[1], exported: false });
        }
        return out;
    }

    // JS / MJS
    const patterns = [
        {
            re: /export\s+async\s+function\s+(\w+)\s*\(/g,
            kind: 'async function',
            exported: true
        },
        {
            re: /export\s+function\s+(\w+)\s*\(/g,
            kind: 'function',
            exported: true
        },
        {
            re: /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
            kind: 'const arrow',
            exported: true
        },
        {
            re: /export\s+default\s+async\s+function\s+(\w+)\s*\(/g,
            kind: 'async function (default)',
            exported: true
        },
        {
            re: /export\s+default\s+function\s+(\w+)\s*\(/g,
            kind: 'function (default)',
            exported: true
        },
        { re: /(?<![.\w])async\s+function\s+(\w+)\s*\(/g, kind: 'async function', exported: false },
        { re: /(?<![.\w])function\s+(\w+)\s*\(/g, kind: 'function', exported: false },
        // Class methods: method(...) inside a class body. This is a loose
        // scan and may catch nested object methods too; we accept that.
        // Skip control-flow / keyword tokens that aren't real methods.
        { re: /^\s+(?:static\s+|async\s+)*(\w+)\s*\([^)]*\)\s*\{/gm, kind: 'method', exported: false }
    ];

    const KEYWORD_METHOD_NAMES = new Set([
        'if',
        'for',
        'while',
        'switch',
        'catch',
        'return',
        'do',
        'else',
        'try',
        'finally',
        'function',
        'async'
    ]);
    const seen = new Set();
    for (const { re, kind, exported } of patterns) {
        let m;
        while ((m = re.exec(source)) !== null) {
            const name = m[1];
            if (!name || name === 'function' || name === 'async') continue;
            if (KEYWORD_METHOD_NAMES.has(name)) continue;
            const key = `${kind}:${name}`;
            // Prefer the exported form; don't double-count.
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ kind, name, exported });
        }
    }
    return out;
}

/**
 * Read a file's content from the working tree, returning an empty
 * string if it is absent (e.g. a deleted row).
 *
 * @param {string} abs
 * @returns {string}
 */
function readSafe(abs) {
    try {
        return fs.readFileSync(abs, 'utf-8');
    } catch {
        return '';
    }
}

/**
 * Build a per-module method inventory for the given added rows.
 *
 * @param {{ path: string }[]} addedRows
 * @param {string} root
 * @returns {{ path: string, methods: { kind, name, exported }[] }[]}
 */
function inventoryAddedModules(addedRows, root) {
    const result = [];
    for (const row of addedRows) {
        if (!isModulePath(row.path)) continue;
        const ext = row.path.slice(row.path.lastIndexOf('.'));
        const abs = `${root}/${row.path}`;
        const source = readSafe(abs);
        if (!source) continue;
        const methods = extractMethods(source, ext);
        result.push({ path: row.path, methods });
    }
    return result;
}

function printSummary(buckets, inventory, base) {
    console.log(`upgrades: local tree vs ${base}\n`);

    const total =
        buckets.added.length +
        buckets.modified.length +
        buckets.deleted.length +
        buckets.renamed.length +
        buckets.copied.length +
        buckets.other.length;

    console.log(`changes: ${total}`);
    console.log(`  added:    ${buckets.added.length}`);
    console.log(`  modified: ${buckets.modified.length}`);
    console.log(`  deleted:  ${buckets.deleted.length}`);
    console.log(`  renamed:  ${buckets.renamed.length}`);
    console.log(`  copied:   ${buckets.copied.length}`);
    if (buckets.other.length) console.log(`  other:    ${buckets.other.length}`);

    const addedModules = buckets.added.filter((r) => isModulePath(r.path));
    console.log(`\nadded modules (${addedModules.length}):`);
    if (addedModules.length === 0) {
        console.log('  (none)');
    } else {
        for (const row of addedModules) {
            console.log(`  ${row.path}`);
        }
    }

    console.log(`\nadded methods per module:`);
    if (inventory.length === 0) {
        console.log('  (none)');
    } else {
        for (const mod of inventory) {
            console.log(`\n  ${mod.path}`);
            if (mod.methods.length === 0) {
                console.log('    (no methods found)');
            } else {
                for (const m of mod.methods) {
                    const tag = m.exported ? 'export' : 'local';
                    console.log(`    ${tag.padEnd(6)} ${m.kind.padEnd(20)} ${m.name}`);
                }
            }
        }
    }
}

async function main(opts, positional) {
    const base = (opts && opts.base) || 'origin/main';

    let rows;
    try {
        rows = collectChanges(base);
    } catch (err) {
        console.error(`upgrades: ${err.message}`);
        return;
    }

    const buckets = categorize(rows);
    const inventory = inventoryAddedModules(buckets.added, git.root);
    printSummary(buckets, inventory, base);
}

export { main, collectChanges, categorize, extractMethods, inventoryAddedModules };

export default {
    name: 'upgrades',
    description:
        'Compare local tree against origin/main: report added/modified/deleted files, identify added modules, and itemise newly-added methods per module',
    usage: 'node index.js upgrades [--base <ref>]',
    options: [
        {
            flag: '--base <ref>',
            description: 'base ref to diff against (default: origin/main)'
        }
    ],
    main: cli.run(meta, main)
};