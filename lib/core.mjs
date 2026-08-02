import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolve as resolveResource } from './resources.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
export const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
export const LIB_DIR = path.resolve(MODULE_DIR);

export function assertProjectRoot() {
    const cwd = process.cwd();
    if (cwd !== PROJECT_ROOT) {
        console.error(`Error: must be run from project root (${PROJECT_ROOT})`);
        console.error(`  Current directory: ${cwd}`);
        console.error(`  Run: cd ${PROJECT_ROOT} && make ...`);
        process.exit(1);
    }
}

export class Stream {
    static empty = new Stream([]);

    constructor(parts = []) { this.parts = [...parts]; }

    static concat(a, b) {
        if (a === Stream.empty) return b;
        if (b === Stream.empty) return a;
        return new Stream([...a.parts, ...b.parts]);
    }

    append(part) { return new Stream([...this.parts, part]); }
    appendAll(parts = []) { return parts.reduce((s, p) => s.append(p), this); }
    prepend(part) { return new Stream([part, ...this.parts]); }
    concat(other) { return Stream.concat(this, other); }

    map(fn) { return new Stream(this.parts.map(fn)); }
    filter(pred) { return new Stream(this.parts.filter(pred)); }

    join(sep = '') { return this.parts.join(sep); }
    toArray() { return [...this.parts]; }
    get length() { return this.parts.length; }

    toString(sep = '\n') { return this.parts.join(sep); }
}

export function normalizeModuleName(rawName, extensions = ['.js', '.mjs', '.py']) {
    const name = rawName.trim();
    for (const ext of extensions) {
        if (name.endsWith(ext)) return name.slice(0, -ext.length);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error('Invalid module name: must start with letter/underscore and contain only letters, numbers, underscores, or hyphens');
    }
    return name;
}

export function discoverScripts(scriptsDir = SCRIPTS_DIR) {
    if (!fs.existsSync(scriptsDir)) return [];
    const files = fs.readdirSync(scriptsDir);
    return files.filter(f => f.endsWith('.mjs') || f.endsWith('.js')).map(f => ({
        name: f.replace(/\.(m)?js$/, ''),
        path: path.join(scriptsDir, f)
    }));
}

export function getScriptMetadata(scriptPath) {
    try {
        const content = fs.readFileSync(scriptPath, 'utf-8');
        const match = content.match(/export\s+default\s*({[\s\S]+?})\s*;?/);
        if (!match) return {};
        const obj = match[1];
        const nameMatch = obj.match(/name:\s*['"`]([^'"`]+)['"`]/);
        const descMatch = obj.match(/description:\s*['"`]([^'"`]+)['"`]/);
        return {
            name: nameMatch ? nameMatch[1] : '',
            description: descMatch ? descMatch[1] : ''
        };
    } catch { return {}; }
}

export function generateMakefile(scripts, projectRoot = PROJECT_ROOT) {
    const moduleNames = [...new Set(scripts.filter(s => s.name !== 'reload' && s.name !== 'add').map(s => s.name))];

    const seen = new Set(['reload', 'add', 'edit', 'implement']);
    const moduleTargets = [];
    for (const script of scripts) {
        const name = script.name;
        if (seen.has(name)) continue;
        seen.add(name);
        moduleTargets.push(`${name}:`);
        moduleTargets.push(`\tnode index.js ${(name === 'make-add' ? 'add' : name)}`);
    }

    const lines = resolveResource('Makefile', {
        MODULE_NAMES: moduleNames.join(' '),
        MODULE_TARGETS: moduleTargets.length > 0 ? '\n' + moduleTargets.join('\n') : ''
    });

    return lines.join('\n') + '\n';
}

export function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
}

export function fileExists(filePath) {
    return fs.existsSync(filePath);
}