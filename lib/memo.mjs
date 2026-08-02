// Per-module memo registry. A `memo.remember(name, content)` call
// injected into a module's main() appends one JSON line to the module's
// sibling `<modulePath>.memo` file (so it sorts right next to the module
// in the file browser), prints "name: content" to stdout, and records
// the entry in the in-process `memos` array (exported for programmatic
// access).
//
// Setting FORGET makes the registry transient: after printing, the
// module's .memo file is removed and the entry is dropped from the array.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listAllModules } from './modules.mjs';

const SUFFIX = '.';

let resolved = null;
function modules() {
    if (!resolved) resolved = listAllModules();
    return resolved;
}

function memoFilePathFor(moduleName) {
    const mod = modules().find(m => m.name === moduleName);
    return mod ? mod.path + SUFFIX : null;
}

export const memos = [];

export function remember(name, content) {
    const entry = { name, content };
    memos.push(entry);
    console.log(`${name}: ${content}`);

    const file = memoFilePathFor(name);
    if (!file) {
        console.error(`memo: no module path resolved for "${name}"; not persisted`);
        return;
    }

    if (process.env.FORGET) {
        try { fs.unlinkSync(file); } catch { /* already absent */ }
        for (let i = memos.length - 1; i >= 0; i--) {
            if (memos[i].name === name) memos.splice(i, 1);
        }
        return;
    }

    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function forget(moduleName) {
    if (moduleName) {
        const file = memoFilePathFor(moduleName);
        if (file) {
            try { fs.unlinkSync(file); } catch { /* already absent */ }
        }
        for (let i = memos.length - 1; i >= 0; i--) {
            if (memos[i].name === moduleName) memos.splice(i, 1);
        }
        return;
    }
    for (const m of modules()) {
        const file = memoFilePathFor(m.name);
        if (file) { try { fs.unlinkSync(file); } catch { /* already absent */ } }
    }
    memos.length = 0;
}

export function loadMemos(moduleName) {
    const file = memoFilePathFor(moduleName);
    if (!file) return [];
    try {
        return fs.readFileSync(file, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line));
    } catch {
        return [];
    }
}

export function recallImports(callerRef) {
    const callerPath = callerRef.startsWith('file://')
        ? fileURLToPath(callerRef)
        : callerRef;
    const imports = parseImports(callerPath);
    const collected = [];
    for (const libName of imports) {
        for (const entry of loadMemos(libName)) {
            if (memos.some(m => m.name === entry.name && m.content === entry.content)) continue;
            collected.push(entry);
        }
    }
    for (const entry of collected) {
        memos.unshift(entry);
        console.log(`${entry.name}: ${entry.content}`);
    }
    return collected;
}

function parseImports(filePath) {
    let src;
    try { src = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
    const names = new Set();
    const re = /from\s+(['"`])([^'"`]+)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const spec = m[2];
        if (!spec.includes('/') && !spec.startsWith('.')) continue;
        const base = spec.replace(/^.*\//, '').replace(/\.(?:mjs|js)$/, '');
        if (base) names.add(base);
    }
    return [...names];
}

export default { memos, remember, forget, loadMemos, recallImports };// noop
