import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AbortError } from './core.ts';
import { Template } from '../supports/template.ts';

/** Error thrown when an abstract method is not implemented. */
export class AbstractMethodError extends Error {
    constructor(methodName: string) {
        super(`Language: abstract method "${methodName}" not implemented`);
        this.name = 'AbstractMethodError';
    }
}

/** Abstract-throwing defaults for Language methods. */
const abstractTemplate: Template = {
    lines: {},
    sections: []
};

function abstractParseImports(_content: string): string[] {
    throw new AbstractMethodError('parseImports');
}

function abstractExtractMainFunction(_content: string): any | null {
    throw new AbstractMethodError('extractMainFunction');
}

function abstractExtractPublicMembers(_content: string): any[] {
    throw new AbstractMethodError('extractPublicMembers');
}

function abstractExtractTopLevelMembers(_content: string): any[] {
    throw new AbstractMethodError('extractTopLevelMembers');
}

function abstractExtractLocalMembers(_decl: any, _content: string, _kind?: string): any[] {
    throw new AbstractMethodError('extractLocalMembers');
}

function abstractExplorableMembers(_kind: string): Record<string, (...args: unknown[]) => unknown> | null {
    throw new AbstractMethodError('explorableMembers');
}

function abstractExtractBindings(_content: string): {
    exports: { [name: string]: { line: number; type?: string; exported: boolean } };
    imports: { binding: string; localName: string; source: string; line: number; kind?: string }[];
} {
    throw new AbstractMethodError('extractBindings');
}

function abstractExtractDeclarationReferences(_decl: any, _content: string, _knownNames?: Set<string>): string[] {
    throw new AbstractMethodError('extractDeclarationReferences');
}

/** Template language for missing JS support modules. */
export class JsonTemplateLanguage {
    /** The extension this template language stands in for. */
    readonly ext: string;
    /** The boilerplate template for this language. */
    template: Template;

    constructor(name: string, template: Template) {
        this.ext = name;
        this.template = template;
    }
    parseImports(_content: string): string[] { return []; }
    extractMainFunction(_content: string): any | null { return null; }
    extractPublicMembers(_content: string): any[] { return []; }
    extractTopLevelMembers(_content: string): any[] { return []; }
    extractLocalMembers(_decl: any, _content: string, _kind?: string): any[] { return []; }
    extractBindings(_content: string): any { return { exports: {}, imports: [] }; }
    extractDeclarationReferences(_decl: any, _content: string, _knownNames?: Set<string>): string[] { return []; }
    explorableMembers(_kind: string): Record<string, (...args: unknown[]) => unknown> | null { return null; }
}

/** Abstract-ish base Language class. */
export class Language {
    /** The file extension this language handles (e.g. '.ts'). */
    readonly ext: string;

    constructor(ext: string, impls: Partial<Language> = {}) {
        this.ext = ext;
        this.template = impls.template ?? abstractTemplate;
        this.parseImports = impls.parseImports ?? abstractParseImports;
        this.extractMainFunction = impls.extractMainFunction ?? abstractExtractMainFunction;
        this.extractPublicMembers = impls.extractPublicMembers ?? abstractExtractPublicMembers;
        this.extractTopLevelMembers = impls.extractTopLevelMembers ?? abstractExtractTopLevelMembers;
        this.extractLocalMembers = impls.extractLocalMembers ?? abstractExtractLocalMembers;
        this.explorableMembers = impls.explorableMembers ?? abstractExplorableMembers;
        this.extractBindings = impls.extractBindings ?? abstractExtractBindings;
        this.extractDeclarationReferences = impls.extractDeclarationReferences ?? abstractExtractDeclarationReferences;
    }

    template: Template;
    parseImports(content: string): string[] { throw new AbstractMethodError('parseImports'); }
    extractMainFunction(content: string): any | null { throw new AbstractMethodError('extractMainFunction'); }
    extractPublicMembers(content: string): any[] { throw new AbstractMethodError('extractPublicMembers'); }
    extractTopLevelMembers(content: string): any[] { throw new AbstractMethodError('extractTopLevelMembers'); }
    extractLocalMembers(decl: any, content: string, kind?: string): any[] { throw new AbstractMethodError('extractLocalMembers'); }
    explorableMembers(kind: string): Record<string, (...args: unknown[]) => unknown> | null { throw new AbstractMethodError('explorableMembers'); }
    extractBindings(content: string): any { throw new AbstractMethodError('extractBindings'); }
    extractDeclarationReferences(decl: any, content: string, knownNames?: Set<string>): string[] { throw new AbstractMethodError('extractDeclarationReferences'); }
}

export type LanguageImpl = any; // loose impl shape for for-tree consumers

/** Languages registry with dynamic import support. */
export class Languages {
    // lang*.js support modules live in lib/supports (adjacent to lib/runtime).
    private static SUPPORTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../supports');

    /** Extensions with a JS support module (or JSON template fallback). */
    static SUPPORTED_EXTS = ['.ts', '.js', '.mjs', '.py'];

    private static instanceCache = new Map<string, Language>();

    /** Get language by extension. */
    static async loadLanguage(ext: string): Promise<Language> {
        const extNoDot = ext.startsWith('.') ? ext.slice(1) : ext;
        if (this.instanceCache.has(extNoDot)) {
            return this.instanceCache.get(extNoDot)!;
        }

        const jsSupportFiles = (fs.readdirSync(this.SUPPORTS_DIR) as string[]).filter(f =>
            f.startsWith('lang') && f.endsWith('.js') && f.length > 4
        );

        const extMap: Record<string, string> = { 'ts': 'langts', 'js': 'langjs', 'mjs': 'langmjs', 'py': 'langpy' };
        const langKey = extMap[extNoDot];

        if (langKey && jsSupportFiles.includes(`${langKey}.js`)) {
            try {
                const mod = await import(pathToFileURL(path.join(this.SUPPORTS_DIR, `${langKey}.js`)).href);
                const lang = mod.language || mod.default;
                if (!lang || typeof lang !== 'object' || !(lang instanceof Language)) {
                    throw new AbortError(`JS support for ${ext} is not a Language instance`);
                }
                this.instanceCache.set(extNoDot, lang);
                return lang;
            } catch (e) {
                throw new AbortError(`Failed to load JS support for ${ext}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // Try JSON fallback
        const jsonPath = path.join(this.SUPPORTS_DIR, `${ext}.json`);
        if (fs.existsSync(jsonPath)) {
            const raw = fs.readFileSync(jsonPath, 'utf-8');
            const template: Template = JSON.parse(raw);
            const jsonLang = new JsonTemplateLanguage(ext, template);
            this.instanceCache.set(extNoDot, jsonLang);
            return jsonLang;
        }

        throw new AbortError(`No support file for extension "${ext}" (installed: ${jsSupportFiles.join(', ')})`);
    }

    /** Delegating async API. */
    static async parseImports(content: string, ext: string): Promise<string[]> {
        const lang = await this.loadLanguage(ext);
        return lang.parseImports(content);
    }

    static async extractMainFunction(content: string, ext: string): Promise<any | null> {
        const lang = await this.loadLanguage(ext);
        return lang.extractMainFunction(content);
    }

    static async extractPublicMembers(content: string, ext: string): Promise<any[]> {
        const lang = await this.loadLanguage(ext);
        return lang.extractPublicMembers(content);
    }

    static async extractTopLevelMembers(content: string, ext: string): Promise<any[]> {
        const lang = await this.loadLanguage(ext);
        return lang.extractTopLevelMembers(content);
    }

    static async extractLocalMembers(decl: any, content: string, ext: string, kind?: string): Promise<any[]> {
        const lang = await this.loadLanguage(ext);
        return lang.extractLocalMembers(decl, content, kind);
    }

    static async extractDeclarationReferences(decl: any, content: string, knownNames: Set<string> | undefined, ext: string): Promise<string[]> {
        const lang = await this.loadLanguage(ext);
        return lang.extractDeclarationReferences(decl, content, knownNames);
    }

    static async extractBindings(content: string, ext: string): Promise<any> {
        const lang = await this.loadLanguage(ext);
        return lang.extractBindings(content);
    }

    /** Template support. */
    static loadTemplate(ext: string): Promise<Template> {
        return this.loadLanguage(ext).then(lang => lang.template);
    }

    static async resolveTemplate(ext: string, vars: Record<string, unknown> = {}): Promise<string[]> {
        const lang = await this.loadLanguage(ext);
        const { resolveTemplate } = await import('../supports/template.ts');
        return resolveTemplate(lang.template, vars);
    }

    /** Synchronous extension check — a JS support module exists for `ext`. */
    static isSupported(ext: string): boolean {
        const extNoDot = (ext.startsWith('.') ? ext.slice(1) : ext).toLowerCase();
        return this.SUPPORTED_EXTS.includes(`.${extNoDot}`);
    }

    /** The supported extension list (dot-prefixed). */
    static list(): string[] {
        return [...this.SUPPORTED_EXTS];
    }
}

export const languages = Languages;

export default Languages;