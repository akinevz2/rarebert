import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SUPPORTS_DIR = path.join(__dirname, 'supports');

export const DEFAULT_LANGUAGES = ['js', 'mjs', 'py'];
export const DEFAULT_EXTENSIONS = DEFAULT_LANGUAGES.map(l => `.${l}`);

function parseExt(ext) {
    return ext.startsWith('.') ? ext.slice(1) : ext;
}

export function listLanguages() {
    if (!fs.existsSync(SUPPORTS_DIR)) return [];
    return fs.readdirSync(SUPPORTS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
}

export function supportedExtensions() {
    return listLanguages().map(l => `.${l}`);
}

export function extensionToLanguage(ext) {
    return parseExt(ext);
}

export function isSupported(ext) {
    return listLanguages().includes(parseExt(ext));
}

export function templatePathFor(ext) {
    return path.join(SUPPORTS_DIR, `${parseExt(ext)}.json`);
}

function validateTemplate(raw, lang) {
    if (!raw || typeof raw !== 'object' || !raw.lines || !raw.sections) {
        throw new Error(`Installed template for "${lang}" must be { lines, sections }`);
    }
    if (!raw.lines || typeof raw.lines !== 'object') {
        throw new Error(`Template for "${lang}" has no lines object`);
    }
    if (!raw.sections || !raw.sections.module || !Array.isArray(raw.sections.module)) {
        throw new Error(`Template for "${lang}" has no sections.module array`);
    }
    for (const key of raw.sections.module) {
        if (!(key in raw.lines)) {
            throw new Error(`Template for "${lang}" references missing line: ${key}`);
        }
    }
    return true;
}

async function opencodeGenerateTemplate(lang) {
    const { resolveOpencode } = await import('./opencode.mjs');
    const bin = resolveOpencode();
    const prompt = [
        `Generate a JSON boilerplate template for a new "${lang}" module in this project.`,
        `The template must be an object with two fields: "lines" (a map of symbolic line keys to template strings) and "sections" (a map of section names to arrays of line keys, including a "module" section).`,
        `Use placeholders like {{MODULE_NAME}} and {{LIB_IMPORTS}} where appropriate.`,
        `Mirror the structure used by the existing templates in lib/supports/ (js.json, mjs.json, py.json) but adapt the syntax to "${lang}".`,
        `Output ONLY the JSON object, no prose, no code fences.`
    ].join(' ');
    const result = spawnSync(bin, ['run', prompt, '--auto'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit']
    });
    if (result.status !== 0) {
        throw new Error(`opencode failed to generate a template for "${lang}" (exit ${result.status})`);
    }
    const out = result.stdout || '';
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error(`opencode did not return JSON for template "${lang}"`);
    }
    return out.slice(start, end + 1).trim();
}

export async function installLanguage(lang, options = {}) {
    const name = parseExt(lang).toLowerCase();
    const dest = path.join(SUPPORTS_DIR, `${name}.json`);
    if (fs.existsSync(dest) && !options.force) {
        throw new Error(`Language "${name}" already installed (use force:true to overwrite)`);
    }

    let raw;
    if (options.template) {
        raw = typeof options.template === 'string' ? options.template : JSON.stringify(options.template);
    } else {
        console.error(`languages: querying opencode for a "${name}" template...`);
        raw = await opencodeGenerateTemplate(name);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`Generated template for "${name}" is not valid JSON: ${e.message}`);
    }
    validateTemplate(parsed, name);

    fs.mkdirSync(SUPPORTS_DIR, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(parsed, null, 4) + '\n');
    return { name, path: dest, template: parsed };
}

export default {
    DEFAULT_LANGUAGES,
    DEFAULT_EXTENSIONS,
    SUPPORTS_DIR,
    listLanguages,
    supportedExtensions,
    extensionToLanguage,
    isSupported,
    templatePathFor,
    installLanguage
};