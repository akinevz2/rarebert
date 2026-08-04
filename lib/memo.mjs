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

    memoCascadingBuffer.push({ name, content });

    if (!file) {
        console.error(`memo: no module path resolved for "${name}"; not persisted`);
        return;
    }

    const contentSet = new Set([...loadMemos(name), content]);
    fs.writeFileSync(file, JSON.stringify({ name, content: [...contentSet] }) + '\n');
}

export function forget(moduleName) {
    if (moduleName) {
        const file = memoFilePathFor(moduleName);
        if (file) {
            try {
                fs.unlinkSync(file);
            } catch {
                /* already absent */
            }
        }
        return;
    }
    if (process.env.FORGET) {
        for (const m of modules()) {
            const file = memoFilePathFor(m.name);
            if (file) {
                try {
                    fs.unlinkSync(file);
                } catch {
                    /* already absent */
                }
            }
        }
    }
}

export function loadMemos(moduleName) {
    const file = memoFilePathFor(moduleName);
    if (!file) return [];
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data.content || [];
    } catch {
        return [];
    }
}

export function recallImports(callerRef) {
    const callerPath = callerRef.startsWith('file://') ? fileURLToPath(callerRef) : callerRef;
    const imports = parseImports(callerPath);
    const collected = [];
    for (const libName of imports) {
        for (const content of loadMemos(libName)) {
            if (memoCascadingBuffer.some((m) => m.name === libName && m.content === content))
                continue;
            collected.push({ name: libName, content });
        }
    }
    for (const entry of collected) {
        memoCascadingBuffer.unshift(entry);
    }
    return collected;
}

export function flush() {
    if (memoCascadingBuffer.length === 0) return;
    process.stderr.write('\n');
    for (const entry of memoCascadingBuffer) {
        process.stderr.write(`\x1b[1;2m${entry.name}:\x1b[0m ${entry.content}\n`);
    }
}

export function installFlushHandlers() {
    process.on('exit', flush);
    process.on('SIGINT', () => {
        flush();
        process.exit(130);
    });
    process.on('SIGHUP', () => {
        flush();
        process.exit(129);
    });
}

export function loadForRun(scriptPath, scriptName) {
    recallImports(scriptPath);
    for (const content of loadMemos(scriptName)) {
        if (!memoCascadingBuffer.some((m) => m.name === scriptName && m.content === content)) {
            memoCascadingBuffer.push({ name: scriptName, content });
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

export default {
    memoCascadingBuffer,
    remember,
    forget,
    loadMemos,
    recallImports,
    flush,
    installFlushHandlers,
    loadForRun
};
