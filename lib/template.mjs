import fs from 'fs';
import path from 'path';
import { languages } from './languages.mjs';

class Template {
    constructor() {
        this.supportsDir = languages.supportsDir;
    }

    firstAlpha(s) {
        for (const ch of s) {
            if (/[a-zA-Z]/.test(ch)) return ch.toLowerCase();
        }
        return '';
    }

    sortLinesByFirstAlpha(entries) {
        return [...entries].sort((a, b) => {
            const fa = this.firstAlpha(a[1]);
            const fb = this.firstAlpha(b[1]);
            if (fa !== fb) return fa < fb ? -1 : 1;
            return a[1].length - b[1].length;
        });
    }

    load(ext) {
        const name = ext.replace(/^\./, '');
        const filePath = path.join(this.supportsDir, `${name}.json`);
        if (!fs.existsSync(filePath)) {
            const installed = languages.list();
            throw new Error(
                `No template file "supports/${name}.json" for extension "${ext}"` +
                    (installed.length ? ` (installed: ${installed.join(', ')})` : '')
            );
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || !raw.lines || !raw.sections) {
            throw new Error(`Template "${ext}" must be { lines, sections }`);
        }
        const sorted = new Map(this.sortLinesByFirstAlpha(Object.entries(raw.lines)));
        return { lines: sorted, sections: raw.sections };
    }

    substitute(line, vars = {}) {
        return Object.entries(vars).reduce(
            (l, [key, value]) => l.replaceAll(`{{${key}}}`, value),
            line
        );
    }

    resolve(ext, vars = {}, section = 'module') {
        const template = this.load(ext);
        if (!template.sections[section]) {
            throw new Error(`Template "${ext}" has no section "${section}"`);
        }
        return template.sections[section].map((key) => {
            if (!template.lines.has(key)) {
                throw new Error(`Template "${ext}" missing line: ${key}`);
            }
            return this.substitute(template.lines.get(key), vars);
        });
    }
}

const template = new Template();
export { Template, template };
export default template;
