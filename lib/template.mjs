import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveTemplateFile(ext) {
    const name = ext.replace(/^\./, '');
    const fileName = `${name}.json`;
    const filePath = path.join(LIB_DIR, fileName);
    if (!fs.existsSync(filePath)) {
        throw new Error(`No template file "${fileName}" for extension "${ext}"`);
    }
    return filePath;
}

export function resolve(ext, vars = {}) {
    const filePath = resolveTemplateFile(ext);
    const lines = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    if (!Array.isArray(lines)) {
        throw new Error(`Template "${ext}" must be a JSON array of lines`);
    }

    return lines.map(line => {
        return Object.entries(vars).reduce((l, [key, value]) => {
            return l.replaceAll(`{{${key}}}`, value);
        }, line);
    });
}

export function list() {
    return fs.readdirSync(LIB_DIR)
        .filter(f => f.endsWith('.json') && f !== 'Makefile.json')
        .map(f => `.${f.replace(/\.json$/, '')}`);
}

export function validate(ext) {
    const errors = [];

    let filePath;
    try {
        filePath = resolveTemplateFile(ext);
    } catch (e) {
        return { valid: false, errors: [e.message] };
    }

    let lines;
    try {
        lines = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        return { valid: false, errors: [`Invalid JSON: ${e.message}`] };
    }

    if (!Array.isArray(lines)) {
        return { valid: false, errors: ['must be a JSON array of strings'] };
    }

    for (let i = 0; i < lines.length; i++) {
        if (typeof lines[i] !== 'string') {
            errors.push(`line ${i}: not a string`);
        }
    }

    const found = new Set();
    for (const line of lines) {
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

export default { resolve, list, validate, validateAll };