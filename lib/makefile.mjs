import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from './core.mjs';
import { substitute, sortLinesByFirstAlpha } from './template.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_FILE = path.join(LIB_DIR, 'Makefile.json');

function loadTemplate() {
    const raw = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !raw.lines || !raw.recipes) {
        throw new Error('Makefile.json must be { lines, recipes }');
    }
    const deduped = new Map();
    for (const [key, value] of Object.entries(raw.lines)) {
        if (![...deduped.values()].includes(value)) deduped.set(key, value);
    }
    const sorted = new Map(sortLinesByFirstAlpha([...deduped.entries()]));
    return { lines: sorted, recipes: raw.recipes };
}

function buildRecipe(targetName, lineKeys, lines) {
    return [`${targetName}:`, ...lineKeys.map(key => {
        if (!lines.has(key)) throw new Error(`Makefile template missing line: ${key}`);
        return substitute(lines.get(key));
    })];
}

function buildSimpleTarget(name, invokedAs) {
    return [`${name}:`, `\tnode index.js ${invokedAs}`];
}

export function generateMakefile(scripts, projectRoot = PROJECT_ROOT) {
    const { lines, recipes } = loadTemplate();
    const blank = lines.get('blank');

    const seen = new Set();
    const targets = [];

    if (recipes.help) {
        targets.push({ name: 'help', lines: buildRecipe('help', recipes.help, lines) });
    } else {
        targets.push({ name: 'help', lines: buildSimpleTarget('help', '') });
    }
    seen.add('help');

    for (const script of scripts) {
        const { name } = script;
        if (seen.has(name)) continue;
        seen.add(name);
        const invokedAs = name === 'make-add' ? 'add' : name;
        const recipeLines = recipes[name]
            ? buildRecipe(name, recipes[name], lines)
            : buildSimpleTarget(name, invokedAs);
        targets.push({ name, lines: recipeLines });
    }

    const phonyNames = targets.map(t => t.name);
    const out = [lines.get('header_comment'), blank, `.PHONY: ${phonyNames.join(' ')}`];
    for (const target of targets) {
        out.push(blank, blank, ...target.lines);
    }
    return out.join('\n') + '\n';
}

export default { generateMakefile };