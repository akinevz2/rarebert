import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from './core.mjs';
import { listAllModules } from './modules.mjs';
import { onAbort } from './cli.mjs';

const SUFFIX = '.';

let resolved = null;
function modules() {
    if (!resolved) resolved = listAllModules();
    return resolved;
}

function memoFilePathFor(moduleName) {
    const mod = modules().find((m) => m.name === moduleName);
    return mod ? mod.path + SUFFIX : null;
}

export const memoCascadingBuffer = [];

export function remember(name, content) {
    const file = memoFilePathFor(name);

    if (process.env.FORGET) {
        if (file) {
            try {
                fs.unlinkSync(file);
            } catch {
                /* already absent */
            }
        }
        for (let i = memoCascadingBuffer.length - 1; i >= 0; i--) {
            if (memoCascadingBuffer[i].name === name) memoCascadingBuffer.splice(i, 1);
        }
        console.error(`memo: performing a forgetful remember for ${name}, you've been warned`);
    }

    if (memoCascadingBuffer.some((m) => m.name === name && m.content === content)) return;

    const modulePath = modules().find((m) => m.name === name)?.path ?? '';
    memoCascadingBuffer.push({ name, content, modulePath, lastModified: Date.now() });

    if (!file) {
        console.error(`memo: no module path resolved for "${name}"; not persisted`);
        return;
    }

    const contentSet = new Set([...loadMemos(name), content]);
    fs.writeFileSync(
        file,
        JSON.stringify({ name, content: [...contentSet], lastModified: Date.now() }) + '\n'
    );
}

function forgetModuleFileByPath(modulePath) {
    const file = modulePath + SUFFIX;
    try {
        fs.unlinkSync(file);
    } catch {
        /* already absent */
    }
    for (let i = memoCascadingBuffer.length - 1; i >= 0; i--) {
        if (memoCascadingBuffer[i].modulePath === modulePath) memoCascadingBuffer.splice(i, 1);
    }
}

export function forget(moduleName) {
    const file = memoFilePathFor(moduleName);
    if (file) {
        try {
            fs.unlinkSync(file);
        } catch {
            /* already absent */
        }
    }
    for (let i = memoCascadingBuffer.length - 1; i >= 0; i--) {
        if (memoCascadingBuffer[i].name === moduleName) memoCascadingBuffer.splice(i, 1);
    }
}

export function forgetAllMemos() {
    for (const m of modules()) {
        forgetModuleFileByPath(m.path);
    }
}

export function forgetMemos(moduleName, recursive = false) {
    const file = memoFilePathFor(moduleName);
    if (file) {
        try {
            fs.unlinkSync(file);
        } catch {
            /* already absent */
        }
    }
    for (let i = memoCascadingBuffer.length - 1; i >= 0; i--) {
        if (memoCascadingBuffer[i].name === moduleName) memoCascadingBuffer.splice(i, 1);
    }
    if (recursive) {
        for (const m of modules()) {
            if (m.name === moduleName) forgetModuleFileByPath(m.path);
        }
    }
}

export function loadAllMemos() {
    const entries = [];
    for (const m of modules()) {
        const file = m.path + SUFFIX;
        let memos = [];
        let lastModified = 0;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            memos = data.content || [];
            lastModified = typeof data.lastModified === 'number' ? data.lastModified : 0;
        } catch {
            /* file absent or invalid */
        }
        if (memos.length) entries.push({ module: m, memos, lastModified });
    }
    entries.sort((a, b) => a.lastModified - b.lastModified);
    return entries;
}

export function clearBuffer() {
    memoCascadingBuffer.length = 0;
}

export function loadMemos(moduleName) {
    return loadMemosWithTimestamps(moduleName).map((e) => e.content);
}

export function loadMemosWithTimestamps(moduleName) {
    const file = memoFilePathFor(moduleName);
    if (!file) return [];
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const entries = (data.content || []).map((c, i) => ({
            content: c,
            lastModified:
                typeof data.lastModified === 'number'
                    ? data.lastModified
                    : typeof c === 'object' && c !== null
                      ? c.lastModified || 0
                      : 0,
            idx: i
        }));
        entries.sort((a, b) => a.lastModified - b.lastModified);
        return entries;
    } catch {
        return [];
    }
}

function loadMemosByPath(modulePath) {
    const file = modulePath + SUFFIX;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const entries = (data.content || []).map((c, i) => ({
            content: c,
            lastModified:
                typeof data.lastModified === 'number'
                    ? data.lastModified
                    : typeof c === 'object' && c !== null
                      ? c.lastModified || 0
                      : 0,
            idx: i
        }));
        entries.sort((a, b) => a.lastModified - b.lastModified);
        return {
            name: data.name || path.basename(modulePath, path.extname(modulePath)),
            memos: entries
        };
    } catch {
        return { name: path.basename(modulePath, path.extname(modulePath)), memos: [] };
    }
}

export function recallImports(callerRef) {
    const callerPath = callerRef.startsWith('file://') ? fileURLToPath(callerRef) : callerRef;
    const imports = parseImports(callerPath);
    const collected = [];
    for (const libPath of imports) {
        const { name: libName, memos } = loadMemosByPath(libPath);
        for (const entry of memos) {
            if (
                memoCascadingBuffer.some(
                    (m) => m.modulePath === libPath && m.content === entry.content
                )
            )
                continue;
            collected.push({
                name: libName,
                content: entry.content,
                modulePath: libPath,
                lastModified: entry.lastModified
            });
        }
    }
    for (const entry of collected) {
        memoCascadingBuffer.unshift(entry);
    }
    return collected;
}

let flushed = false;

export function flush() {
    if (flushed || memoCascadingBuffer.length === 0) return;
    flushed = true;
    const sorted = [...memoCascadingBuffer].sort((a, b) => {
        const ta = a.lastModified || 0;
        const tb = b.lastModified || 0;
        return ta - tb;
    });
    process.stderr.write('\n');
    for (const entry of sorted) {
        const display = entry.modulePath
            ? path.relative(PROJECT_ROOT, entry.modulePath)
            : entry.name;
        process.stderr.write(`\x1b[1;2m${display}:\x1b[0m ${entry.content}\n`);
    }
}

export function installFlushHandlers() {
    process.on('exit', flush);
    onAbort(flush);
}

export function loadForRun(scriptPath, scriptName) {
    recallImports(scriptPath);
    const modulePath = modules().find((m) => m.name === scriptName)?.path ?? scriptPath;
    for (const entry of loadMemosWithTimestamps(scriptName)) {
        if (
            !memoCascadingBuffer.some((m) => m.name === scriptName && m.content === entry.content)
        ) {
            memoCascadingBuffer.push({
                name: scriptName,
                content: entry.content,
                modulePath: modulePath || '',
                lastModified: entry.lastModified
            });
        }
    }
    installFlushHandlers();
}

function parseImports(filePath) {
    let src;
    try {
        src = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }
    const importerDir = path.dirname(filePath);
    const results = [];
    const seen = new Set();
    const re = /from\s+(['"`])([^'"`]+)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const spec = m[2];
        if (!spec.includes('/') && !spec.startsWith('.')) continue;
        let resolved;
        try {
            resolved = path.resolve(importerDir, spec);
        } catch {
            continue;
        }
        if (!seen.has(resolved)) {
            seen.add(resolved);
            results.push(resolved);
        }
    }
    return results;
}

export default {
    memoCascadingBuffer,
    remember,
    forget,
    forgetAllMemos,
    forgetMemos,
    loadMemos,
    loadAllMemos,
    clearBuffer,
    recallImports,
    flush,
    installFlushHandlers,
    loadForRun
};
