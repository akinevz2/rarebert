import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveFileName(name) {
    if (fs.existsSync(path.join(LIB_DIR, `${name}.json`))) return `${name}.json`;
    if (fs.existsSync(path.join(LIB_DIR, `${name}`))) return name;
    const match = fs.readdirSync(LIB_DIR).find(f => f.replace(/\.json$/, '') === name);
    if (match) return match;
    throw new Error(`Resource "${name}" not found in ${LIB_DIR}`);
}

export function resolve(name, vars = {}) {
    const fileName = resolveFileName(name);
    const raw = fs.readFileSync(path.join(LIB_DIR, fileName), 'utf-8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
        throw new Error(`Resource "${name}" must be a JSON array of lines`);
    }

    return data.map(line => {
        return Object.entries(vars).reduce((l, [key, value]) => {
            return l.replaceAll(`{{${key}}}`, value);
        }, line);
    });
}

export function list() {
    return fs.readdirSync(LIB_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
}

export function validate(name) {
    const errors = [];

    let fileName;
    try {
        fileName = resolveFileName(name);
    } catch (e) {
        return { valid: false, errors: [e.message] };
    }

    let data;
    try {
        data = JSON.parse(fs.readFileSync(path.join(LIB_DIR, fileName), 'utf-8'));
    } catch (e) {
        return { valid: false, errors: [`Invalid JSON: ${e.message}`] };
    }

    if (!Array.isArray(data)) {
        errors.push('must be a JSON array of strings');
        return { valid: false, errors };
    }

    for (let i = 0; i < data.length; i++) {
        if (typeof data[i] !== 'string') {
            errors.push(`line ${i}: not a string`);
        }
    }

    const found = new Set();
    for (const line of data) {
        if (typeof line !== 'string') continue;
        const matches = line.match(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g) || [];
        for (const m of matches) found.add(m.slice(2, -2));
    }

    return { valid: errors.length === 0, errors, placeholders: [...found] };
}

export function validateAll() {
    const results = {};
    for (const name of list()) {
        results[name] = validate(name);
    }
    const allValid = Object.values(results).every(r => r.valid);
    return { valid: allValid, results };
}

export default { resolve, list, validate, validateAll };