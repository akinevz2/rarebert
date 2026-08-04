import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { project } from './core.mjs';
import { listAllModules } from './modules.mjs';
import { cli } from './cli.mjs';

const SUFFIX = '.';

class Memo {
    constructor() {
        this.buffer = [];
        this.flushed = false;
        this.modulesCache = null;
    }

    modules() {
        if (!this.modulesCache) this.modulesCache = listAllModules();
        return this.modulesCache;
    }

    memoFilePathFor(moduleRef) {
        if (path.isAbsolute(moduleRef)) {
            const rel = project.relPath(moduleRef);
            const mod = this.modules().find((m) => m.path === rel);
            return mod ? mod.abs + SUFFIX : null;
        }
        const mod = this.modules().find((m) => m.name === moduleRef || m.path === moduleRef);
        return mod ? mod.abs + SUFFIX : null;
    }

    remember(moduleRef, content) {
        const file = this.memoFilePathFor(moduleRef);
        const mod = this.modules().find((m) => m.name === moduleRef || m.path === moduleRef);
        const name = mod?.name ?? moduleRef;
        const modulePath = mod?.path ?? '';

        if (this.buffer.some((m) => m.name === name && m.content === content)) return;

        this.buffer.push({ name, content, modulePath, lastModified: Date.now() });

        if (!file) {
            console.error(`memo: no module path resolved for "${name}"; not persisted`);
            return;
        }

        const contentSet = new Set([...this.loadMemos(moduleRef), content]);
        fs.writeFileSync(
            file,
            JSON.stringify({ name, content: [...contentSet], lastModified: Date.now() }, null, 2) +
                '\n'
        );
    }

    forget(moduleRef) {
        const file = this.memoFilePathFor(moduleRef);
        const mod = this.modules().find((m) => m.name === moduleRef || m.path === moduleRef);
        const name = mod?.name ?? moduleRef;

        if (file) {
            try {
                fs.unlinkSync(file);
            } catch {
                /* already absent */
            }
        }
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            if (this.buffer[i].name === name) this.buffer.splice(i, 1);
        }
    }

    forgetAll() {
        for (const m of this.modules()) {
            this.forgetByPath(m.path);
        }
    }

    forgetByPath(moduleRelPath) {
        const file = project.absPath(moduleRelPath) + SUFFIX;
        try {
            fs.unlinkSync(file);
        } catch {
            /* already absent */
        }
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            if (this.buffer[i].modulePath === moduleRelPath) this.buffer.splice(i, 1);
        }
    }

    forgetMemos(moduleRef, recursive = false) {
        this.forget(moduleRef);
        if (recursive) {
            const mod = this.modules().find((m) => m.name === moduleRef || m.path === moduleRef);
            if (mod) this.forgetByPath(mod.path);
        }
    }

    loadMemos(moduleRef) {
        return this.loadMemosWithTimestamps(moduleRef).map((e) => e.content);
    }

    loadMemosWithTimestamps(moduleRef) {
        const file = this.memoFilePathFor(moduleRef);
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

    loadAllMemos() {
        const entries = [];
        for (const m of this.modules()) {
            const file = m.abs + SUFFIX;
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

    loadMemosByPath(modulePath) {
        const rel = path.isAbsolute(modulePath) ? project.relPath(modulePath) : modulePath;
        const file = project.absPath(rel) + SUFFIX;
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
                name: data.name || path.basename(rel, path.extname(rel)),
                memos: entries,
                modulePath: rel
            };
        } catch {
            return { name: path.basename(rel, path.extname(rel)), memos: [], modulePath: rel };
        }
    }

    recallImports(callerRef) {
        const callerPath = callerRef.startsWith('file://') ? fileURLToPath(callerRef) : callerRef;
        const imports = parseImports(callerPath);
        const collected = [];
        for (const libPath of imports) {
            const { name: libName, memos, modulePath: relPath } = this.loadMemosByPath(libPath);
            for (const entry of memos) {
                if (
                    this.buffer.some((m) => m.modulePath === relPath && m.content === entry.content)
                )
                    continue;
                collected.push({
                    name: libName,
                    content: entry.content,
                    modulePath: relPath,
                    lastModified: entry.lastModified
                });
            }
        }
        for (const entry of collected) {
            this.buffer.unshift(entry);
        }
        return collected;
    }

    loadForRun(scriptPath, scriptName) {
        this.recallImports(scriptPath);
        const mod = this.modules().find((m) => m.name === scriptName);
        const modulePath = mod?.path ?? scriptPath;
        for (const entry of this.loadMemosWithTimestamps(scriptName)) {
            if (!this.buffer.some((m) => m.name === scriptName && m.content === entry.content)) {
                this.buffer.push({
                    name: scriptName,
                    content: entry.content,
                    modulePath: modulePath || '',
                    lastModified: entry.lastModified
                });
            }
        }
        this.installFlushHandlers();
    }

    flush() {
        if (this.flushed || this.buffer.length === 0) return;
        this.flushed = true;
        const sorted = [...this.buffer].sort((a, b) => {
            const ta = a.lastModified || 0;
            const tb = b.lastModified || 0;
            return ta - tb;
        });
        process.stderr.write('\n');
        for (const entry of sorted) {
            const display = entry.modulePath || entry.name;
            process.stderr.write(`\x1b[1;2m${display}:\x1b[0m ${entry.content}\n`);
        }
    }

    clearBuffer() {
        this.buffer.length = 0;
    }

    installFlushHandlers() {
        process.on('exit', () => this.flush());
        cli.onAbort(() => this.flush());
    }
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

const memo = new Memo();

export { Memo, memo };
export default memo;
