import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT, SCRIPTS_DIR } from './core.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_FILE = path.join(LIB_DIR, 'Makefile.json');

function firstAlpha(s) {
    for (const ch of s) {
        if (/[a-zA-Z]/.test(ch)) return ch.toLowerCase();
    }
    return '';
}

export function loadTemplate() {
    const raw = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !raw.lines || !raw.recipes) {
        throw new Error('Makefile.json must be { lines, recipes }');
    }

    const deduped = new Map();
    for (const [key, value] of Object.entries(raw.lines)) {
        if (![...deduped.values()].includes(value)) {
            deduped.set(key, value);
        }
    }

    const sorted = new Map(
        [...deduped.entries()].sort((a, b) => {
            const fa = firstAlpha(a[1]);
            const fb = firstAlpha(b[1]);
            if (fa !== fb) return fa < fb ? -1 : 1;
            return a[1].length - b[1].length;
        })
    );

    return { lines: sorted, recipes: raw.recipes };
}

export function substitute(line, vars = {}) {
    return Object.entries(vars).reduce(
        (l, [key, value]) => l.replaceAll(`{{${key}}}`, value),
        line
    );
}

export function buildRecipe(targetName, lineKeys, template, vars = {}) {
    const lines = [`${targetName}:`];
    for (const key of lineKeys) {
        if (!template.has(key)) {
            throw new Error(`Makefile template missing line: ${key}`);
        }
        lines.push(substitute(template.get(key), vars));
    }
    return lines;
}

export function buildSimpleTarget(name, invokedAs) {
    return [`${name}:`, `\tnode index.js ${invokedAs}`];
}

export function generateMakefile(scripts, projectRoot = PROJECT_ROOT) {
    const { lines, recipes } = loadTemplate();
    const blank = lines.get('blank');

    const seen = new Set();
    const targets = [];

    if (recipes.help) {
        targets.push({ name: 'help', lines: buildRecipe('help', recipes.help, lines) });
        seen.add('help');
    } else {
        targets.push({ name: 'help', lines: buildSimpleTarget('help', '') });
        seen.add('help');
    }

    for (const script of scripts) {
        const name = script.name;
        if (seen.has(name)) continue;
        seen.add(name);

        const invokedAs = name === 'make-add' ? 'add' : name;
        let recipeLines;
        if (recipes[name]) {
            recipeLines = buildRecipe(name, recipes[name], lines);
        } else {
            recipeLines = buildSimpleTarget(name, invokedAs);
        }
        targets.push({ name, lines: recipeLines });
    }

    const phonyNames = targets.map(t => t.name);
    const out = [];

    out.push(lines.get('header_comment'));
    out.push(blank);
    out.push(`.PHONY: ${phonyNames.join(' ')}`);

    for (const target of targets) {
        out.push(blank);
        out.push(blank);
        out.push(...target.lines);
    }

    return out.join('\n') + '\n';
}

export default { loadTemplate, substitute, buildRecipe, buildSimpleTarget, generateMakefile };