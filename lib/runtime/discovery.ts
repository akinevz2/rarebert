import fs from 'node:fs';
import path from 'node:path';
import { rarebert } from './Project.ts';
import type { ProjectFolder } from './Project.ts';
import { Module } from './Module.ts';
import { truncate, isInteractive, nonInteractive } from './Module.ts';
import { AbortError } from './core.ts';

// ---------------------------------------------------------------------------
// Module discovery & resolution helpers.
//
// These lived at module level in the legacy runtime/module.ts (deleted in
// the PascalCase rewrite). Restored here with HEAD's exact semantics, on
// the free-function + singleton style:
//   - resolveModule/resolveModuleSet return {module, rel, sidecar}; the
//     memo system and scripts/check depend on the `rel` + `sidecar` shape.
//   - promptModule/promptModuleChoices bail via nonInteractive() (the
//     former `cli.nonInteractive` singleton path) when stdin is not a TTY.
//   - prompt loading of enquirer is lazy (call time, same as backend.ts).
// ---------------------------------------------------------------------------

/** A resolved module reference: the module plus its rel path and memo sidecar. */
export interface ResolvedModule {
    module: Module;
    rel: string;
    sidecar: string;
}

/** An Enquirer choice built from a module. */
export interface ModuleChoice {
    name: string;
    message: string;
}

/** Options for the fuzzy module picker. */
export interface PromptChoicesOptions {
    /** Maximum number of visible suggestions. */
    limit?: number;
    /** Choice names pinned to the top of the list. */
    specials?: string[];
}

/** Find a discovered folder by key, or null. */
export function findDirectoryTarget(key: string): ProjectFolder | null {
    return rarebert.discover().find((t) => t.key === key) || null;
}

/** Deepest discovered folder containing an absolute path, or null. */
export function directoryTargetByPath(absPath: string): ProjectFolder | null {
    const resolved = path.resolve(absPath);
    const targets = rarebert.discover();
    return (
        targets.find((t) => t.dir === resolved) ||
        targets.find((t) => resolved.startsWith(t.dir + path.sep)) ||
        null
    );
}

/**
 * Enumerate every module across all discovered project folders.
 * Pass `{ all: true }` to index every file regardless of extension
 * (used by memo indexing where any file may receive a sidecar).
 * Returns an array of Module instances (lightweight, no main callback).
 */
export function listAllModules(options: { all?: boolean } = {}): Module[] {
    const modules: Module[] = [];
    for (const project of rarebert.discover()) {
        for (const m of rarebert.discoverModules(project.dir, project.exts, options)) {
            modules.push(Module.fromProject(project, path.basename(m.path)));
        }
    }
    return modules;
}

/** Enquirer select choices for modules: path + truncated first description line. */
export function buildModuleChoices(modules: Module[]): ModuleChoice[] {
    return modules.map((s) => {
        const meta = rarebert.getScriptMetadata(s.abs);
        const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
        const label = truncate(`${s.path}${desc ? ' - ' + desc : ''}`);
        return { name: s.path, message: label };
    });
}

/**
 * Resolve one module reference against a module list.
 * Order: exact rel path → path suffix → basename/stem match.
 * Returns { module, rel, sidecar } or null.
 */
export function resolveModule(arg: string, modules: Module[]): ResolvedModule | null {
    const rel = path.isAbsolute(arg) ? rarebert.relPath(arg) : arg;
    const mod =
        modules.find((m) => m.path === rel) ||
        modules.find((m) => m.path.endsWith(rel)) ||
        modules.find((m) => m.name === path.basename(rel, path.extname(rel)));
    if (!mod) return null;
    return { module: mod, rel: mod.path, sidecar: mod.memoFile() };
}

/**
 * Resolve a list of module references. Directory args fan out to every
 * module under the directory (deduped); unmatched args are reported on
 * stderr and skipped.
 */
export function resolveModuleSet(args: string[], modules: Module[]): ResolvedModule[] {
    const result: ResolvedModule[] = [];
    const seen = new Set<string>();
    for (const arg of args) {
        const abs = path.isAbsolute(arg) ? arg : path.resolve(rarebert.root, arg);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            for (const m of modules) {
                if ((m.abs.startsWith(abs + path.sep) || m.abs === abs) && !seen.has(m.path)) {
                    seen.add(m.path);
                    result.push({ module: m, rel: m.path, sidecar: m.memoFile() });
                }
            }
            continue;
        }
        const resolved = resolveModule(arg, modules);
        if (resolved) {
            if (!seen.has(resolved.rel)) {
                seen.add(resolved.rel);
                result.push(resolved);
            }
        } else {
            console.error(`no module matched "${arg}"`);
        }
    }
    return result;
}

/**
 * Resolve a module for prompting: exact name/path match for `moduleArg`
 * (normalizeModuleName equality first), else the fuzzy AutoComplete
 * picker. Non-interactive without an argument → AbortError.
 */
export async function promptModule(
    modules: Module[],
    moduleArg?: string,
    message = 'Select a module'
): Promise<Module | undefined> {
    if (moduleArg) {
        const match =
            modules.find(
                (s) =>
                    rarebert.normalizeModuleName(s.name) ===
                    rarebert.normalizeModuleName(moduleArg)
            ) ||
            modules.find((s) => s.path === moduleArg) ||
            modules.find((s) => s.path.endsWith(moduleArg) || s.name === moduleArg);
        if (!match) {
            throw new AbortError(`Module not found: ${moduleArg}`, 1);
        }
        return match;
    }

    if (!isInteractive()) {
        throw new AbortError('Non-interactive; pass a module name as an argument.', 1);
    }

    const choices = buildModuleChoices(modules);
    const answer = await promptModuleChoices(message, choices, { limit: 12 });
    return modules.find((s) => s.path === answer);
}

// Enquirer AutoComplete key/ctrl action maps (verbatim from HEAD).
const DEFAULT_CTRL = {
    a: 'first',
    b: 'backward',
    c: 'cancel',
    d: 'deleteForward',
    e: 'last',
    f: 'forward',
    g: 'reset',
    i: 'tab',
    k: 'cutForward',
    l: 'reset',
    n: 'newItem',
    m: 'cancel',
    j: 'submit',
    p: 'search',
    r: 'remove',
    s: 'save',
    u: 'undo',
    w: 'cutLeft',
    x: 'toggleCursor',
    v: 'paste'
};

const DEFAULT_KEYS = {
    pageup: 'pageUp',
    pagedown: 'pageDown',
    home: 'home',
    end: 'end',
    cancel: 'cancel',
    delete: 'deleteForward',
    backspace: 'delete',
    down: 'down',
    enter: 'submit',
    escape: 'cancel',
    left: 'left',
    space: 'space',
    number: 'number',
    return: 'submit',
    right: 'right',
    tab: 'next',
    up: 'up'
};

/**
 * Fuzzy Enquirer.AutoComplete picker over module choices with 5-bucket
 * ranking (basename-exact → basename-token → name-last-token →
 * name-token → other); `specials` are pinned first. Subsequence token
 * matching (fuzzyMatch). Rejection (ctrl-c/escape) → AbortError.
 */
export async function promptModuleChoices(
    message: string,
    choices: ModuleChoice[],
    options: PromptChoicesOptions = {}
): Promise<string> {
    const { limit = 10, specials = [] } = options;
    const specialSet = new Set(specials);

    if (!isInteractive()) {
        return nonInteractive('cannot prompt for selection.') as unknown as string;
    }

    const indexed = choices.map((c) => {
        const msg = (c.message || '').toLowerCase();
        const name = (c.name || '').toLowerCase();
        const basename = name.replace(/^.*\//, '').replace(/\.\w+$/, '');
        return { choice: c, name, basename, msg };
    });

    const fuzzyMatch = (text: string, query: string) => {
        const tokens = query.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return true;
        let pos = 0;
        for (const token of tokens) {
            const idx = text.indexOf(token, pos);
            if (idx === -1) return false;
            pos = idx + token.length;
        }
        return true;
    };

    const { default: Enquirer } = await import('enquirer');

    const prompt = new Enquirer.AutoComplete({
        name: 'module',
        message,
        choices,
        limit,
        actions: {
            ctrl: { ...DEFAULT_CTRL, w: 'deleteWordLeft', h: 'deleteWordLeft' },
            keys: { ...DEFAULT_KEYS, backspace: 'deleteWordLeftIfCtrl' }
        },
        deleteWordLeft(this: any, input: string, key: unknown) {
            const inputVal: string = this.input || '';
            if (!inputVal) return this.alert();
            const trimmed = inputVal.replace(/\s+$/, '');
            const lastSpace = trimmed.lastIndexOf(' ');
            this.input = lastSpace >= 0 ? trimmed.slice(0, lastSpace) : '';
            this.cursor = this.input.length;
            this.render();
        },
        deleteWordLeftIfCtrl(this: any, input: string, key: { ctrl?: boolean } | undefined) {
            if (key && key.ctrl) {
                return this.options.deleteWordLeft.call(this, input, key);
            }
            return this.delete.call(this, input, key);
        },
        dispatch(this: any, ch: string | undefined, key: unknown) {
            if (ch === undefined || ch === null || typeof ch !== 'string' || !ch.trim()) {
                return this.alert();
            }
            if (ch.charCodeAt(0) < 32) {
                return this.alert();
            }
            return this.append(ch);
        },
        suggest(this: any, input: string) {
            const q = (input || '').toLowerCase().trim();
            if (!q) return choices;

            const tokens = q.split(/\s+/).filter(Boolean);
            const pinned: ModuleChoice[] = [];
            const allTokensInMsg = (msg: string) => tokens.every((t) => msg.includes(t));
            const lastToken = tokens[tokens.length - 1];

            const buckets: ModuleChoice[][] = [[], [], [], [], []];
            for (const item of indexed) {
                const { choice, name, basename, msg } = item;
                if (specialSet.has(choice.name)) {
                    if (fuzzyMatch(name, q) || fuzzyMatch(msg, q)) {
                        pinned.push(choice);
                    }
                    continue;
                }
                if (!allTokensInMsg(msg)) continue;
                if (basename.includes(lastToken)) buckets[0].push(choice);
                else if (tokens.some((t) => basename.includes(t))) buckets[1].push(choice);
                else if (name.includes(lastToken)) buckets[2].push(choice);
                else if (tokens.some((t) => name.includes(t))) buckets[3].push(choice);
                else buckets[4].push(choice);
            }
            return [...pinned, ...buckets.flat()];
        }
    });

    try {
        return (await prompt.run()) as string;
    } catch {
        throw new AbortError();
    }
}

export default listAllModules;
