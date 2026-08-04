import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { project } from './core.mjs';
import { opencode } from './opencode.mjs';

const SUPPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supports');
const DEFAULT_LANGUAGES = ['js', 'mjs', 'py'];
const DEFAULT_EXTENSIONS = DEFAULT_LANGUAGES.map((l) => `.${l}`);

class Languages {
    constructor() {
        this.supportsDir = SUPPORTS_DIR;
    }

    parseExt(ext) {
        return ext.startsWith('.') ? ext.slice(1) : ext;
    }

    list() {
        if (!fs.existsSync(this.supportsDir)) return [];
        return fs
            .readdirSync(this.supportsDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''));
    }

    supportedExtensions() {
        return this.list().map((l) => `.${l}`);
    }

    extensionToLanguage(ext) {
        return this.parseExt(ext);
    }

    isSupported(ext) {
        return this.list().includes(this.parseExt(ext));
    }

    templatePathFor(ext) {
        return path.join(this.supportsDir, `${this.parseExt(ext)}.json`);
    }

    validateTemplate(raw, lang) {
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

    async opencodeGenerateTemplate(lang) {
        const bin = opencode.resolve();
        const prompt = [
            `Generate a JSON boilerplate template for a new "${lang}" module in this project.`,
            `The template must be an object with two fields: "lines" (a map of symbolic line keys to template strings) and "sections" (a map of section names to arrays of line keys, including a "module" section).`,
            `Use placeholders like {{MODULE_NAME}} and {{LIB_IMPORTS}} where appropriate.`,
            `Mirror the structure used by the existing templates in lib/supports/ (js.json, mjs.json, py.json) but adapt the syntax to "${lang}".`,
            `Output ONLY the JSON object, no prose, no code fences.`
        ].join(' ');
        const result = spawnSync(bin, ['run', prompt, '--auto'], {
            cwd: project.root,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'inherit']
        });
        if (result.status !== 0) {
            throw new Error(
                `opencode failed to generate a template for "${lang}" (exit ${result.status})`
            );
        }
        const out = result.stdout || '';
        const start = out.indexOf('{');
        const end = out.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) {
            throw new Error(`opencode did not return JSON for template "${lang}"`);
        }
        return out.slice(start, end + 1).trim();
    }

    async install(lang, options = {}) {
        const name = this.parseExt(lang).toLowerCase();
        const dest = path.join(this.supportsDir, `${name}.json`);
        if (fs.existsSync(dest) && !options.force) {
            throw new Error(`Language "${name}" already installed (use force:true to overwrite)`);
        }

        let raw;
        if (options.template) {
            raw =
                typeof options.template === 'string'
                    ? options.template
                    : JSON.stringify(options.template);
        } else {
            console.log(`languages: querying opencode for a "${name}" template...`);
            raw = await this.opencodeGenerateTemplate(name);
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            throw new Error(`Generated template for "${name}" is not valid JSON: ${e.message}`);
        }
        this.validateTemplate(parsed, name);

        fs.mkdirSync(this.supportsDir, { recursive: true });
        fs.writeFileSync(dest, JSON.stringify(parsed, null, 4) + '\n');
        return { name, path: dest, template: parsed };
    }
}

const languages = new Languages();
export { Languages, languages, SUPPORTS_DIR, DEFAULT_LANGUAGES, DEFAULT_EXTENSIONS };
export default languages;
