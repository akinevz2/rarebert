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

function resolveTemplateFile(ext) {
    const name = ext.replace(/^\./, '');
    const fileName = `${name}.json`;
    const filePath = path.join(LIB_DIR, fileName);
    if (!fs.existsSync(filePath)) {
        throw new Error(`No template file "${fileName}" for extension "${ext}"`);
    }
    return filePath;
}

export function loadTemplate(ext) {
    const filePath = resolveTemplateFile(ext);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !raw.lines || !raw.sections) {
        throw new Error(`Template "${ext}" must be { lines, sections }`);
    }

    const sorted = new Map(
        [...Object.entries(raw.lines)].sort((a, b) => {
            const fa = firstAlpha(a[1]);
            const fb = firstAlpha(b[1]);
            if (fa !== fb) return fa < fb ? -1 : 1;
            return a[1].length - b[1].length;
        })
    );

    return { lines: sorted, sections: raw.sections };
}

export function substitute(line, vars = {}) {
    return Object.entries(vars).reduce(
        (l, [key, value]) => l.replaceAll(`{{${key}}}`, value),
        line
    );
}

export function buildSection(name, lineKeys, template, vars = {}) {
    const out = [];
    for (const key of lineKeys) {
        if (!template.lines.has(key)) {
            throw new Error(`Template "${name}" missing line: ${key}`);
        }
        out.push(substitute(template.lines.get(key), vars));
    }
    return out;
}

export function resolve(ext, vars = {}, section = 'module') {
    const template = loadTemplate(ext);
    if (!template.sections[section]) {
        throw new Error(`Template "${ext}" has no section "${section}"`);
    }
    return buildSection(section, template.sections[section], template, vars);
}

export function list() {
    return fs.readdirSync(LIB_DIR)
        .filter(f => f.endsWith('.json') && f !== 'Makefile.json')
        .map(f => `.${f.replace(/\.json$/, '')}`);
}

export function validate(ext) {
    const errors = [];

    let template;
    try {
        template = loadTemplate(ext);
    } catch (e) {
        return { valid: false, errors: [e.message] };
    }

    for (const [key, line] of template.lines.entries()) {
        if (typeof line !== 'string') {
            errors.push(`line "${key}": not a string`);
        }
    }

    for (const [sectionName, lineKeys] of Object.entries(template.sections)) {
        if (!Array.isArray(lineKeys)) {
            errors.push(`section "${sectionName}": not an array`);
            continue;
        }
        for (let i = 0; i < lineKeys.length; i++) {
            if (!template.lines.has(lineKeys[i])) {
                errors.push(`section "${sectionName}"[${i}]: references missing line "${lineKeys[i]}"`);
            }
        }
    }

    const found = new Set();
    for (const line of template.lines.values()) {
        if (typeof line !== 'string') continue;
        const matches = line.match(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g) || [];
        for (const m of matches) found.add(m.slice(2, -2));
    }

    return { valid: errors.length === 0, errors, placeholders: [...found] };
}

export function validateAll() {
    const results = {};
    for (const ext of list()) {
        results[ext] = validate(ext);
    }
    const allValid = Object.values(results).every(r => r.valid);
    return { valid: allValid, results };
}

export default { loadTemplate, substitute, buildSection, resolve, list, validate, validateAll };