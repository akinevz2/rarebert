import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

function firstAlpha(s) {
    for (const ch of s) {
        if (/[a-zA-Z]/.test(ch)) return ch.toLowerCase();
    }
    return '';
}

export function sortLinesByFirstAlpha(entries) {
    return [...entries].sort((a, b) => {
        const fa = firstAlpha(a[1]);
        const fb = firstAlpha(b[1]);
        if (fa !== fb) return fa < fb ? -1 : 1;
        return a[1].length - b[1].length;
    });
}

function loadTemplate(ext) {
    const name = ext.replace(/^\./, '');
    const filePath = path.join(LIB_DIR, `${name}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`No template file "${name}.json" for extension "${ext}"`);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !raw.lines || !raw.sections) {
        throw new Error(`Template "${ext}" must be { lines, sections }`);
    }
    const sorted = new Map(sortLinesByFirstAlpha(Object.entries(raw.lines)));
    return { lines: sorted, sections: raw.sections };
}

export function substitute(line, vars = {}) {
    return Object.entries(vars).reduce(
        (l, [key, value]) => l.replaceAll(`{{${key}}}`, value),
        line
    );
}

export function resolve(ext, vars = {}, section = 'module') {
    const template = loadTemplate(ext);
    if (!template.sections[section]) {
        throw new Error(`Template "${ext}" has no section "${section}"`);
    }
    return template.sections[section].map(key => {
        if (!template.lines.has(key)) {
            throw new Error(`Template "${ext}" missing line: ${key}`);
        }
        return substitute(template.lines.get(key), vars);
    });
}

export default { substitute, resolve };