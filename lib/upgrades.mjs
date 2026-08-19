import fs from 'fs';
import { git } from './git.mjs';

const MODULE_EXT = new Set(['.mjs', '.js', '.py']);

function parseNameStatusLine(line) {
    if (!line) return null;
    const parts = line.split('\t');
    if (parts.length < 2) return null;
    const status = parts[0];
    if (status.length === 0) return null;
    const op = status[0];
    if (status.length > 1 && (op === 'R' || op === 'C') && parts.length >= 3) {
        return { status, op, from: parts[1], path: parts[2] };
    }
    return { status, op, path: parts[1] };
}

function collectChanges(base) {
    const r = git.git('diff', ['--name-status', `${base}`, 'HEAD']);
    if (!r.ok) {
        throw new Error(
            `git diff --name-status ${base} HEAD failed: ${r.stderr.trim() || r.status}`
        );
    }
    return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseNameStatusLine)
        .filter(Boolean);
}

function categorize(rows) {
    const buckets = { added: [], modified: [], deleted: [], renamed: [], copied: [], other: [] };
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

    const patterns = [
        { re: /export\s+async\s+function\s+(\w+)\s*\(/g, kind: 'async function', exported: true },
        { re: /export\s+function\s+(\w+)\s*\(/g, kind: 'function', exported: true },
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
        {
            re: /^\s+(?:static\s+|async\s+)*(\w+)\s*\([^)]*\)\s*\{/gm,
            kind: 'method',
            exported: false
        }
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
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ kind, name, exported });
        }
    }
    return out;
}

function readSafe(abs) {
    try {
        return fs.readFileSync(abs, 'utf-8');
    } catch {
        return '';
    }
}

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
        for (const row of addedModules) console.log(`  ${row.path}`);
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

export {
    parseNameStatusLine,
    collectChanges,
    categorize,
    isModulePath,
    extractMethods,
    inventoryAddedModules,
    printSummary
};
export default { collectChanges, categorize, extractMethods, inventoryAddedModules, printSummary };
