import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { opencode } from './opencode.mjs';
import { home } from './projects.mjs';
import { Template, resolveTemplate, substitute } from './template.mjs';
import { cli, tui } from './module.mjs';

const SUPPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supports');
const DEFAULT_LANGUAGES = ['js', 'mjs', 'py'];
const DEFAULT_EXTENSIONS = DEFAULT_LANGUAGES.map((l) => `.${l}`);

/**
 * Names of the built-in `lang{ext}.js` support modules shipped under
 * lib/supports/. These provide both a boilerplate template and an
 * import parser. Dynamically installed languages fall back to a plain
 * `{ext}.json` template (no import parser).
 */
const JS_SUPPORT_PREFIX = 'lang';
const JS_SUPPORT_SUFFIX = '.js';

/** Error raised when an abstract method is not overridden. */
class AbstractMethodError extends Error {
    constructor(name) {
        super(`Language: abstract method "${name}" not implemented`);
        this.name = 'AbstractMethodError';
    }
}

/** Default abstract implementations — throw when not overridden. */
function abstractTemplate() {
    throw new AbstractMethodError('template');
}
function abstractParseImports() {
    throw new AbstractMethodError('parseImports');
}
function abstractExtractMainFunction() {
    throw new AbstractMethodError('extractMainFunction');
}
function abstractExtractPublicMembers() {
    throw new AbstractMethodError('extractPublicMembers');
}
function abstractExtractTopLevelMembers() {
    throw new AbstractMethodError('extractTopLevelMembers');
}
function abstractExtractLocalMembers() {
    throw new AbstractMethodError('extractLocalMembers');
}
function abstractExtractBindings() {
    throw new AbstractMethodError('extractBindings');
}
function abstractExtractDeclarationReferences() {
    throw new AbstractMethodError('extractDeclarationReferences');
}

/**
 * Abstract base class for a language support module.
 *
 * Every supported language provides a concrete instance (exported from
 * `lib/supports/lang{ext}.js`) constructed with all its implementations
 * passed as a single `impls` object to the constructor. The `Languages`
 * registry loads these instances and delegates all language-variadic
 * behaviour to them, so callers (analyze.mjs, template.mjs, ...) never
 * branch on language name.
 *
 * A `Language` carries a `template` member (a `Template` from
 * lib/template.mjs) reflecting the boilerplate `lines`/`sections`.
 *
 * @param {string} ext - language extension without the leading dot
 * @param {object} impls - the language's concrete implementations:
 *   @param {Template}  impls.template
 *   @param {(content: string) => string[]}   impls.parseImports
 *   @param {(content: string) => object|null} impls.extractMainFunction
 *   @param {(content: string) => object[]}    impls.extractPublicMembers
 *   @param {(content: string) => object[]}    impls.extractTopLevelMembers
 *   @param {(decl: object, content: string, kind?: string) => object[]} impls.extractLocalMembers
 *   @param {Object<string, Function>|null}             impls.explorableMembers
 *   @param {(content: string) => {exports: object, imports: object[]}} impls.extractBindings
 */
class Language {
    constructor(
        ext,
        {
            template = abstractTemplate,
            parseImports = abstractParseImports,
            extractMainFunction = abstractExtractMainFunction,
            extractPublicMembers = abstractExtractPublicMembers,
            extractTopLevelMembers = abstractExtractTopLevelMembers,
            extractLocalMembers = abstractExtractLocalMembers,
            explorableMembers = null,
            extractBindings = abstractExtractBindings,
            extractDeclarationReferences = abstractExtractDeclarationReferences
        } = {}
    ) {
        this.ext = ext;
        this.template = template;
        this.parseImports = parseImports;
        this.extractMainFunction = extractMainFunction;
        this.extractPublicMembers = extractPublicMembers;
        this.extractTopLevelMembers = extractTopLevelMembers;
        this.extractLocalMembers = extractLocalMembers;
        this.explorableMembers = explorableMembers;
        this.extractBindings = extractBindings;
        this.extractDeclarationReferences = extractDeclarationReferences;
    }
}

/**
 * Minimal language adapter backed by a plain JSON template (for
 * languages installed via opencode that have no JS support module).
 * Provides template data but returns empty/null for the analysis
 * methods since there is no language-specific parser.
 */
class JsonTemplateLanguage extends Language {
    constructor(ext, raw) {
        super(ext, {
            template: new Template({ lines: raw.lines, sections: raw.sections }),
            parseImports: () => [],
            extractMainFunction: () => null,
            extractPublicMembers: () => [],
            extractTopLevelMembers: () => [],
            extractLocalMembers: () => [],
            explorableMembers: null,
            extractBindings: () => ({ exports: {}, imports: [] }),
            extractDeclarationReferences: () => []
        });
    }
}

class Languages {
    constructor() {
        this.supportsDir = SUPPORTS_DIR;
        /** @type {Map<string, Language>} */
        this.instanceCache = new Map();
    }

    parseExt(ext) {
        return ext.startsWith('.') ? ext.slice(1) : ext;
    }

    /**
     * Built-in JS support modules (`langjs.js`, `langmjs.js`, ...) keyed
     * by language extension (without the dot).
     */
    jsSupportFiles() {
        if (!fs.existsSync(this.supportsDir)) return [];
        return fs
            .readdirSync(this.supportsDir)
            .filter(
                (f) =>
                    f.startsWith(JS_SUPPORT_PREFIX) &&
                    f.endsWith(JS_SUPPORT_SUFFIX) &&
                    f.length > JS_SUPPORT_PREFIX.length + JS_SUPPORT_SUFFIX.length
            )
            .map((f) => f.slice(JS_SUPPORT_PREFIX.length, -JS_SUPPORT_SUFFIX.length));
    }

    /**
     * Legacy JSON template files (`{ext}.json`) — used for languages
     * installed via `opencode` that did not ship a JS support module.
     */
    jsonSupportFiles() {
        if (!fs.existsSync(this.supportsDir)) return [];
        return fs
            .readdirSync(this.supportsDir)
            .filter((f) => f.endsWith('.json') && !f.startsWith(JS_SUPPORT_PREFIX))
            .map((f) => f.replace(/\.json$/, ''));
    }

    /**
     * All supported language extensions (without the dot). JS support
     * modules take precedence; JSON-only templates fill in the rest.
     */
    list() {
        const js = this.jsSupportFiles();
        const json = this.jsonSupportFiles();
        return [...new Set([...js, ...json])];
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

    jsSupportPathFor(ext) {
        const name = this.parseExt(ext);
        return path.join(this.supportsDir, `${JS_SUPPORT_PREFIX}${name}${JS_SUPPORT_SUFFIX}`);
    }

    jsonSupportPathFor(ext) {
        const name = this.parseExt(ext);
        return path.join(this.supportsDir, `${name}.json`);
    }

    templatePathFor(ext) {
        // Prefer the JS support module when present.
        if (fs.existsSync(this.jsSupportPathFor(ext))) return this.jsSupportPathFor(ext);
        return this.jsonSupportPathFor(ext);
    }

    hasJsSupport(ext) {
        return fs.existsSync(this.jsSupportPathFor(ext));
    }

    validateTemplate(raw, lang) {
        if (!raw || typeof raw !== 'object' || !raw.lines || !raw.sections) {
            throw new Error(`Installed template for "${lang}" must be { lines, sections }`);
        }
        if (!raw.lines || typeof raw.lines !== 'object') {
            throw new Error(`Template for "${lang}" has no lines object`);
        }
        if (!Array.isArray(raw.sections)) {
            throw new Error(`Template for "${lang}" sections must be an array of line keys`);
        }
        for (const key of raw.sections) {
            if (!(key in raw.lines)) {
                throw new Error(`Template for "${lang}" references missing line: ${key}`);
            }
        }
        return true;
    }

    /**
     * Load the `Language` instance for a language extension.
     *
     * Prefers a `lang{ext}.js` ESM module that exports a ready-made
     * `Language` instance (default export or named `language`); falls
     * back to a legacy `{ext}.json` template wrapped in a
     * JsonTemplateLanguage.
     *
     * @param {string} ext - language extension, with or without leading dot
     * @returns {Promise<Language>}
     */
    async loadLanguage(ext) {
        const name = this.parseExt(ext);
        if (this.instanceCache.has(name)) return this.instanceCache.get(name);

        const jsPath = this.jsSupportPathFor(name);
        if (fs.existsSync(jsPath)) {
            const mod = await import(pathToFileURL(jsPath).href);
            const instance = mod.language || mod.default;
            if (!instance || typeof instance !== 'object') {
                throw new Error(`JS support "${name}" does not export a Language instance`);
            }
            if (!(instance instanceof Language)) {
                throw new Error(`JS support "${name}" instance does not extend Language`);
            }
            if (!instance.ext) instance.ext = name;
            this.instanceCache.set(name, instance);
            return instance;
        }

        const jsonPath = this.jsonSupportPathFor(name);
        if (fs.existsSync(jsonPath)) {
            const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            this.validateTemplate(raw, name);
            const instance = new JsonTemplateLanguage(name, raw);
            this.instanceCache.set(name, instance);
            return instance;
        }

        const installed = this.list();
        throw new Error(
            `No support file for extension ".${name}"` +
                (installed.length ? ` (installed: ${installed.join(', ')})` : '')
        );
    }

    // ---- Delegating API (thin wrappers over the Language instance) ----

    /**
     * Parse imports for a module's content using the language's parser.
     * Returns `[]` when the language has no parser (JSON-only template).
     */
    async parseImports(content, ext) {
        const lang = await this.loadLanguage(ext);
        return lang.parseImports(content);
    }

    /** Extract the main() function body, or null. */
    async extractMainFunction(content, ext) {
        const lang = await this.loadLanguage(ext);
        return lang.extractMainFunction(content);
    }

    /** Extract public (exported) members as { name, kind, startLine, endLine, lines }[]. */
    async extractPublicMembers(content, ext) {
        const lang = await this.loadLanguage(ext);
        return lang.extractPublicMembers(content);
    }

    /** Extract all top-level declarations (exported or not) as { name, kind, startLine, endLine, lines, exported }[]. */
    async extractTopLevelMembers(content, ext) {
        const lang = await this.loadLanguage(ext);
        return lang.extractTopLevelMembers(content);
    }

    /**
     * Extract local declarations inside a parent declaration's body.
     * `decl` is { startLine, endLine, lines }. If `kind` is omitted,
     * merges all explorable kinds. Returns { name, kind, startLine, endLine, lines, valueExpr }[].
     */
    async extractLocalMembers(decl, content, ext, kind) {
        const lang = await this.loadLanguage(ext);
        return lang.extractLocalMembers(decl, content, kind);
    }

    /**
     * Extract structured export and import binding declarations from
     * module source. Returns { exports, imports } where:
     *   exports: { [bindingName]: { line, type, exported: true } }
     *   imports: [ { binding, localName, source, line, kind } ]
     *
     * `kind` is one of: 'named', 'default', 'namespace', 'reexport', 'dynamic'.
     * Delegates to the language's extractBindings impl.
     */
    async extractBindings(content, ext) {
        const lang = await this.loadLanguage(ext);
        return lang.extractBindings(content);
    }

    async extractDeclarationReferences(decl, content, knownNames, ext) {
        const lang = await this.loadLanguage(ext);
        return lang.extractDeclarationReferences(decl, content, knownNames);
    }

    /** Load the template ({ lines, sections }) for a language. */
    async loadTemplate(ext) {
        const lang = await this.loadLanguage(ext);
        const tpl = lang.template;
        return { lines: tpl.lines, sections: tpl.sections };
    }

    /**
     * Resolve the language's boilerplate template into an array of
     * substituted lines. Delegates the pure substitution work to
     * template.mjs; this method only loads the `Language` instance
     * and hands its `Template` to the pure `resolveTemplate` function.
     */
    async resolveTemplate(ext, vars = {}) {
        const lang = await this.loadLanguage(ext);
        return resolveTemplate(lang.template, vars);
    }

    /** Substitute `{{key}}` placeholders in a single line (pure passthrough). */
    substituteLine(line, vars = {}) {
        return substitute(line, vars);
    }

    async opencodeGenerateTemplate(lang) {
        const bin = opencode.resolve();
        const prompt = [
            `Generate a JSON boilerplate template for a new "${lang}" module in this project.`,
            `Review the existing language support libraries in lib/supports/lang*.js to see the shape of a template.`,
            `View lib/languages.mjs and lib/template.mjs to understand what needs to be implemented — the Languages class consumes templates and Template defines the lines/sections contract.`,
            `Adapt the syntax to "${lang}".`,
            `Output ONLY the JSON object, no prose, no code fences.`
        ].join(' ');
        const result = spawnSync(bin, ['run', prompt, '--auto'], {
            cwd: home.root,
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
        // Never overwrite a built-in JS support module.
        const jsDest = this.jsSupportPathFor(name);
        if (fs.existsSync(jsDest) && !options.force) {
            throw new Error(
                `Language "${name}" has a built-in support module (use force:true to overwrite the JSON template only)`
            );
        }
        const dest = this.jsonSupportPathFor(name);
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
        this.instanceCache.delete(name);
        return { name, path: dest, template: parsed };
    }

    choices() {
        const langs = this.list();
        const choices = langs.map((l) => ({ name: l, message: `.${l}` }));
        choices.push({ name: '__install__', message: 'Install a new language via opencode...' });
        return choices;
    }

    show({ label = 'languages' } = {}) {
        const langs = this.list();
        if (langs.length === 0) {
            console.log(`${label}: no languages installed (lib/supports/ is empty)`);
            return;
        }
        console.log(`${label}: ${langs.length} installed`);
        for (const lang of langs) console.log(`  - ${lang}  (.${lang})`);
    }

    async installNew() {
        const lang = await tui.input('Language to install (e.g. ts, rb, go):', {
            validate: (v) => (v.trim() ? true : 'Language is required')
        });
        const name = lang.replace(/^\.+/, '').toLowerCase();
        if (this.isSupported(name)) {
            const overwrite = await tui.confirm(
                `Language "${name}" is already installed. Overwrite?`,
                false
            );
            if (!overwrite) return cli.ok('Not overwritten.');
        }
        console.log(`languages: installing "${name}"...`);
        const result = await this.install(name, { force: true });
        console.log(`\n✓ Installed language: ${result.name} (${result.path})`);
        return result.name;
    }

    async choose({ default: defaultLang = 'mjs' } = {}) {
        if (!cli.isInteractive()) return cli.nonInteractive('cannot choose a language.');
        const langs = this.list();
        if (langs.length === 0) return await this.installNew();
        const initial = Math.max(0, langs.indexOf(defaultLang));
        const choice = await tui.select('Select a language for the new module:', this.choices(), {
            nonInteractiveBehavior: 'return',
            initial
        });
        if (choice === '__install__') return await this.installNew();
        return choice;
    }

    async installFromArgs(opts = {}, positional = []) {
        const nameArg = positional[0];
        let force = !!opts.force;
        let lang = nameArg;
        if (!lang) {
            if (!cli.isInteractive())
                return cli.fail('Usage: node index.js languages install <lang> [--force]');
            lang = await tui.input('Language to install (e.g. ts, rb, go):', {
                validate: (v) => (v.trim() ? true : 'Language is required')
            });
        }
        lang = lang.replace(/^\.+/, '').toLowerCase();
        if (this.isSupported(lang) && !force) {
            const overwrite = await tui.confirm(
                `Language "${lang}" is already installed. Overwrite?`,
                false
            );
            if (!overwrite) return cli.ok('Not overwritten.');
            force = true;
        }
        console.log(`languages: installing "${lang}"...`);
        const result = await this.install(lang, { force });
        console.log(`\n✓ Installed language: ${result.name}`);
        console.log(`  template: ${result.path}`);
        console.log(`  lines: ${Object.keys(result.template.lines).length}`);
        console.log(`  sections: ${result.template.sections.length} line keys`);
        return cli.ok(`Done. New modules can now use .${result.name}`);
    }
}

/**
 * Abstract base for LSP-backed language adapters. A future lang*.js
 * module (e.g. langrust.js, langgo.js) can extend this to implement
 * LSP-protocol-backed introspection via rust-analyzer, gopls, tsserver,
 * etc. Not wired into any dispatch path today — purely a scaffold.
 */
class AbstractLspAdapter {
    constructor({ serverCommand, initializeOptions, workspaceRoot } = {}) {
        this.serverCommand = serverCommand;
        this.initializeOptions = initializeOptions;
        this.workspaceRoot = workspaceRoot;
    }

    async start(ctx) {
        throw new AbstractMethodError('AbstractLspAdapter.start');
    }
    async documentSymbols(absPath) {
        throw new AbstractMethodError('AbstractLspAdapter.documentSymbols');
    }
    async definitions(absPath, position) {
        throw new AbstractMethodError('AbstractLspAdapter.definitions');
    }
    async references(absPath, position) {
        throw new AbstractMethodError('AbstractLspAdapter.references');
    }
    async shutdown() {
        throw new AbstractMethodError('AbstractLspAdapter.shutdown');
    }
}

const languages = new Languages();
export {
    Language,
    JsonTemplateLanguage,
    AbstractMethodError,
    AbstractLspAdapter,
    Languages,
    languages,
    SUPPORTS_DIR,
    DEFAULT_LANGUAGES,
    DEFAULT_EXTENSIONS
};
export default languages;
