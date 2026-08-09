import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { rarebert } from './projects.mjs';
import { cli, AbortError } from './cli.mjs';

const DIRECTORY_TARGETS = [
    { key: 'root', dir: rarebert.root, label: './  (rarebert core)' },
    { key: 'scripts', dir: rarebert.scriptsDir, label: 'scripts/  (rarebert api)' },
    { key: 'lib', dir: rarebert.libDir, label: 'lib/  (rarebert library)' },
    { key: 'src', dir: rarebert.srcDir, label: 'src/  (rarebert projects)' }
];

class Module {
    constructor(rel) {
        this.path = rel;
        this.name = path.basename(rel, path.extname(rel));
        this.abs = rarebert.absPath(rel);
        this.ext = path.extname(rel);
        this.dir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
    }

    toString() {
        return this.path;
    }

    memoFile() {
        return this.abs + '.';
    }
}

function findDirectoryTarget(key) {
    return DIRECTORY_TARGETS.find((t) => t.key === key) || null;
}

function directoryTargetByPath(absPath) {
    const resolved = path.resolve(absPath);
    return (
        DIRECTORY_TARGETS.find((t) => t.dir === resolved) ||
        DIRECTORY_TARGETS.find((t) => resolved.startsWith(t.dir + path.sep)) ||
        null
    );
}

function listAllModules() {
    const raw = [...rarebert.discover(rarebert.scriptsDir), ...rarebert.discover(rarebert.libDir)];
    return raw.map((m) => new Module(m.path));
}

function buildModuleChoices(modules) {
    return modules.map((s) => {
        const meta = rarebert.getScriptMetadata(s.abs);
        const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
        const label = cli.truncate(`${s.path}${desc ? ' - ' + desc : ''}`);
        return { name: s.path, message: label };
    });
}

/**
 * Resolve a single module argument (path, name, or absolute path) to a
 * typed descriptor with the module object, its rarebert-relative path,
 * and the sidecar path used by memo files.
 *
 * @param {string} arg     module name, relative path, or absolute path
 * @param {Module[]} modules
 * @returns {{ module: Module, rel: string, sidecar: string } | null}
 */
function resolveModule(arg, modules) {
    const rel = path.isAbsolute(arg) ? rarebert.relPath(arg) : arg;
    const mod =
        modules.find((m) => m.path === rel) ||
        modules.find((m) => m.path.endsWith(rel)) ||
        modules.find((m) => m.name === arg || m.name === path.basename(rel, path.extname(rel)));
    if (!mod) return null;
    return { module: mod, rel: mod.path, sidecar: mod.memoFile() };
}

/**
 * Resolve a list of file/folder arguments to a set of resolved module
 * descriptors. Folders expand to all modules under them. Unmatched args
 * print a warning to stderr and are skipped.
 *
 * @param {string[]} args
 * @param {Module[]} modules
 * @returns {{ module: Module, rel: string, sidecar: string }[]}
 */
function resolveModuleSet(args, modules) {
    const result = [];
    const seen = new Set();
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

async function promptModule(modules, moduleArg, message = 'Select a module') {
    if (moduleArg) {
        const match =
            modules.find(
                (s) =>
                    rarebert.normalizeModuleName(s.name) === rarebert.normalizeModuleName(moduleArg)
            ) ||
            modules.find((s) => s.path === moduleArg) ||
            modules.find((s) => s.path.endsWith(moduleArg) || s.name === moduleArg);
        if (!match) {
            console.error(`Module not found: ${moduleArg}`);
            process.exit(1);
        }
        return match;
    }

    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; pass a module name as an argument.');
        process.exit(1);
    }

    const choices = buildModuleChoices(modules);
    const answer = await promptModuleChoices(message, choices, { limit: 12 });
    return modules.find((s) => s.path === answer);
}

/**
 * Interactive module selection with priority-ordered fuzzy search.
 *
 * Matching tiers (highest priority first):
 *   1. last token matches basename  — "add to memo" -> lib/memo.mjs
 *   2. any token matches basename    — "add memo to add" -> scripts/add.mjs
 *   3. last token matches full path  — "add to scripts/check" -> scripts/check.mjs
 *   4. any token matches full path   — "lib/co" -> lib/core.mjs
 *   5. all tokens in message (fuzzy) — fallback
 *
 * Fuzzy matching: each whitespace-separated query token must appear as
 * a substring (in order) somewhere in the target text, but the tokens
 * need not be contiguous.
 *
 * Special choices whose `name` starts with `__` are pinned: they stay
 * at the top of the result list and are only surfaced by a direct
 * name/message hit so they don't drown out module results on a partial
 * query.
 *
 * Keybindings: ctrl-w and ctrl-backspace delete the previous word
 * (not just one char) since Enquirer's Select/AutoComplete prompts
 * don't inherit cutLeft from the String input type.
 *
 * Falls back to cli.select (plain Select, no search) when not
 * interactive so non-interactive callers still get deterministic output.
 *
 * @param {string} message
 * @param {{ name: string, message: string }[]} choices
 * @param {{ limit?: number, specials?: string[] }} [options]
 * @returns {Promise<string>} the chosen `name`
 */
async function promptModuleChoices(message, choices, options = {}) {
    const { limit = 10, specials = [] } = options;
    const specialSet = new Set(specials);

    if (!cli.isInteractive()) {
        return cli.select(message, choices, { limit });
    }

    // Pre-compute the module name, basename, and message for each choice
    // so the suggest function doesn't re-parse on every keystroke.
    const indexed = choices.map((c) => {
        const msg = (c.message || '').toLowerCase();
        const name = (c.name || '').toLowerCase();
        // Basename without extension (e.g. "core" from "lib/core.mjs") —
        // a basename match is more specific than a path substring match.
        const basename = name.replace(/^.*\//, '').replace(/\.\w+$/, '');
        return { choice: c, name, basename, msg };
    });

    /**
     * Fuzzy match: every whitespace-separated token in the query must
     * appear as a substring of the text (case-insensitive). Tokens are
     * matched in order but need not be contiguous.
     */
    const fuzzyMatch = (text, query) => {
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

    // Enquirer's default keybinding maps (combos.ctrl, combos.keys, etc.)
    // are shallow-merged via { ...combos, ...customActions } in
    // keypress.action(), so providing a custom `ctrl` object would wipe
    // out ctrl-c (cancel), ctrl-a (first), enter/return, arrows, etc.
    // Inline the defaults from enquirer/lib/combos.js and spread them
    // into each sub-map so only the keys we override are replaced.
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

    const prompt = new Enquirer.AutoComplete({
        name: 'module',
        message,
        choices,
        limit,
        // Custom keybindings: wire ctrl-w and ctrl-backspace to a
        // word-deletion action since AutoComplete (which extends Select,
        // not String) lacks the cutLeft method that the String input
        // type defines.
        actions: {
            ctrl: { ...DEFAULT_CTRL, w: 'deleteWordLeft', h: 'deleteWordLeft' },
            keys: { ...DEFAULT_KEYS, backspace: 'deleteWordLeftIfCtrl' }
        },
        // Enquirer looks up this.options[action] before this[action], so
        // we provide deleteWordLeft as an option-level method bound to
        // the prompt instance.
        deleteWordLeft(input, key) {
            const inputVal = this.input || '';
            if (!inputVal) return this.alert();
            // Delete back to the previous word boundary
            const trimmed = inputVal.replace(/\s+$/, '');
            const lastSpace = trimmed.lastIndexOf(' ');
            this.input = lastSpace >= 0 ? trimmed.slice(0, lastSpace) : '';
            this.cursor = this.input.length;
            this.render();
        },
        deleteWordLeftIfCtrl(input, key) {
            // ctrl-backspace arrives as backspace with ctrl flag in some
            // terminals; plain backspace should still delete one char.
            if (key && key.ctrl) {
                return this.options.deleteWordLeft.call(this, input, key);
            }
            // Fall through to default single-char delete
            return this.delete.call(this, input, key);
        },
        // Filter out unsupported ctrl/alt keycodes that would otherwise
        // be appended as the literal string "undefined" into the search
        // input. Alert (beep) and re-render so the user gets feedback
        // that the key was ignored, without the input being corrupted.
        dispatch(ch, key) {
            if (ch === undefined || ch === null || typeof ch !== 'string' || !ch.trim()) {
                return this.alert();
            }
            // Skip control characters (ctrl+letter produces \x01-\x1a)
            if (ch.charCodeAt(0) < 32) {
                return this.alert();
            }
            return this.append(ch);
        },
        suggest(input) {
            const q = (input || '').toLowerCase().trim();
            if (!q) return choices;

            const tokens = q.split(/\s+/).filter(Boolean);
            const pinned = []; // special choices that match the query

            // Fuzzy filter: every token must appear somewhere in the
            // full displayed message (unordered). If any token is
            // missing, the choice is excluded entirely.
            const allTokensInMsg = (msg) => tokens.every((t) => msg.includes(t));
            const lastToken = tokens[tokens.length - 1];

            const buckets = [[], [], [], [], []];
            for (const item of indexed) {
                const { choice, name, basename, msg } = item;
                if (specialSet.has(choice.name)) {
                    if (fuzzyMatch(name, q) || fuzzyMatch(msg, q)) {
                        pinned.push(choice);
                    }
                    continue;
                }

                if (!allTokensInMsg(msg)) continue;

                if (basename.includes(lastToken)) {
                    buckets[0].push(choice);
                } else if (tokens.some((t) => basename.includes(t))) {
                    buckets[1].push(choice);
                } else if (name.includes(lastToken)) {
                    buckets[2].push(choice);
                } else if (tokens.some((t) => name.includes(t))) {
                    buckets[3].push(choice);
                } else {
                    buckets[4].push(choice);
                }
            }

            return [...pinned, ...buckets.flat()];
        }
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

export {
    Module,
    DIRECTORY_TARGETS,
    findDirectoryTarget,
    directoryTargetByPath,
    listAllModules,
    buildModuleChoices,
    resolveModule,
    resolveModuleSet,
    promptModule,
    promptModuleChoices
};
export default Module;
