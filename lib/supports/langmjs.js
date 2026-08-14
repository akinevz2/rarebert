/**
 * Language support for ESM JavaScript (.mjs).
 *
 * Exports a ready-made `Language` instance providing the boilerplate
 * template (as a `Template` member) and language-variadic analysis:
 * an ESM `import` parser, main()-body extraction, and public member
 * extraction.
 *
 * Import notation:
 *   - `foo::fs`      for `import { foo } from 'fs'`
 *   - `foo<-fs`      for `import fs as foo from 'fs'` (alias)
 *   - `fs`           for `import fs from 'fs'`         (default)
 *   - `*::fs`        for `import * as ns from 'fs'`    (namespace, treated as alias)
 */

import { Language } from '../languages.mjs';
import { Template } from '../template.mjs';

const mjsLines = {
    shebang: '#!/usr/bin/env node',
    blank: '',
    imports: "import { cli, CLI } from '{{CLI_IMPORT}}';",
    lib_imports: '{{LIB_IMPORTS}}',
    meta_open: 'const meta = {',
    meta_name: "    name: '{{MODULE_NAME}}',",
    meta_desc: "    description: '{{MODULE_NAME}} module',",
    meta_usage: "    usage: 'node index.js {{MODULE_NAME}}',",
    meta_options: '    options: []',
    meta_close: '};',
    main_open: 'async function main(args = []) {',
    main_scaffold: '    // {{MODULE_NAME}}: implementation scaffold',
    main_todo: '    const todo = `',
    main_todo_body: '{{MODULE_NAME}} module - not yet implemented',
    main_todo_blank: '',
    main_todo_tasks: 'TODO:',
    main_todo_close: '`;',
    main_stub: '    console.log(todo);',
    main_close: '}',
    named_export: 'export { main };',
    module_ctor: "const module = new CLI('{{MODULE_NAME}}.mjs', main, meta);",
    export_default: 'export default module;',
    supports_direct: 'module.supportsDirectRunning(import.meta.url);'
};

const mjsSections = [
    'shebang',
    'blank',
    'imports',
    'lib_imports',
    'blank',
    'meta_open',
    'meta_name',
    'meta_desc',
    'meta_usage',
    'meta_options',
    'meta_close',
    'blank',
    'main_open',
    'main_scaffold',
    'main_todo',
    'main_todo_body',
    'main_todo_blank',
    'main_todo_tasks',
    'main_todo_close',
    'main_stub',
    'main_close',
    'blank',
    'named_export',
    'blank',
    'module_ctor',
    'export_default',
    'supports_direct',
    'blank'
];

const mjsTemplate = new Template({ lines: mjsLines, sections: mjsSections });

/**
 * Parse ESM import statements from `content` and return a list of
 * notated import strings (see file header for the notation).
 *
 * Covers:
 *   import defaultName from 'mod'
 *   import * as ns from 'mod'
 *   import { a, b as c } from 'mod'
 *   import defaultName, { a, b } from 'mod'
 *   import defaultName, * as ns from 'mod'
 *
 * @param {string} content - full module source
 * @returns {string[]} notated imports
 */
const mjsParseImports = (content) => {
    const results = [];
    const re =
        /import\s+(?:(\w+)(?:\s*,\s*)?)?(?:(\*\s+as\s+\w+|{[^}]*}))?\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = re.exec(content)) !== null) {
        const defaultName = match[1] || null;
        const namedOrNs = match[2] || null;
        const mod = match[3];

        if (namedOrNs && namedOrNs.startsWith('*')) {
            // import * as ns from 'mod'  ->  "ns<-mod"
            const nsName = namedOrNs.replace(/\*\s+as\s+/, '').trim();
            const parts = [];
            if (defaultName) parts.push(defaultName);
            parts.push(`${nsName}<-${mod}`);
            results.push(parts.join(', '));
        } else if (namedOrNs) {
            // import { a, b as c } from 'mod'
            //   a        -> "a::mod"
            //   b as c   -> "c<-mod"  (c is the local alias for b)
            const names = namedOrNs
                .replace(/[{}]/g, '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const notated = names.map((n) => {
                const asMatch = n.match(/^(\w+)\s+as\s+(\w+)$/);
                if (asMatch) {
                    return `${asMatch[2]}<-${mod}`;
                }
                return `${n}::${mod}`;
            });
            const parts = [];
            if (defaultName) parts.push(defaultName);
            parts.push(...notated);
            results.push(parts.join(', '));
        } else if (defaultName) {
            // import defaultName from 'mod'  ->  "defaultName"
            results.push(defaultName);
        }
    }
    return results;
};

/**
 * Extract the body of the main() function. Returns
 * { startLine, endLine, bodyLines } (1-indexed) or null.
 */
const mjsExtractMainFunction = (content) =>
    extractBracedMain(content, /^(?:async\s+)?function\s+main\s*\(/);

/**
 * Rarebert-aware entry-point detection. Recognizes three equivalent
 * entry-point forms:
 *   1. `async function main(...)` (standard)
 *   2. `export default new CLI('...', async (...) => {...}, ...)`
 *   3. `export default new TUI('...', async (...) => {...}, ...)`
 *   4. `export default <identifier>` where `const <identifier> = new CLI(...)`
 *      or `new TUI(...)` (indirect export of a CLI/TUI instance)
 *
 * For (2)/(3)/(4), the arrow function passed as the second constructor
 * argument is treated as the main body. Returns the same shape as
 * extractBracedMain ({ startLine, endLine, bodyLines }) or null.
 *
 * This is a rarebert-specific grace — only invoked when the module
 * being analyzed belongs to a rarebert project (gated by
 * Languages.extractMainFunction via current.root === rarebert.root).
 */
const mjsExtractEntryPoint = (content) => {
    // Try standard main() first.
    const standard = extractBracedMain(content, /^(?:async\s+)?function\s+main\s*\(/);
    if (standard) return standard;

    const lines = content.split('\n');

    // extractArrowBody: given a starting line index, find `async (...) => {`
    // within the next few lines and extract the arrow body via brace counting.
    const extractArrowBody = (startLine) => {
        let arrowLine = -1;
        for (let i = startLine; i < Math.min(startLine + 5, lines.length); i++) {
            if (/async\s*\([^)]*\)\s*=>\s*\{/.test(lines[i])) {
                arrowLine = i;
                break;
            }
        }
        if (arrowLine === -1) return null;

        let braceCount = 0;
        let foundOpen = false;
        let bodyStart = -1;
        let bodyEnd = -1;
        for (let i = arrowLine; i < lines.length; i++) {
            const line = lines[i];
            for (let j = 0; j < line.length; j++) {
                const ch = line[j];
                if (ch === '{') {
                    braceCount++;
                    foundOpen = true;
                    if (bodyStart === -1) bodyStart = i;
                } else if (ch === '}') {
                    braceCount--;
                }
            }
            if (foundOpen && braceCount === 0) {
                bodyEnd = i;
                break;
            }
        }
        if (bodyStart === -1 || bodyEnd === -1) return null;

        let absBodyStart = bodyStart;
        let absBodyEnd = bodyEnd;
        while (absBodyStart <= absBodyEnd && lines[absBodyStart].trim() === '') absBodyStart++;
        while (absBodyEnd >= absBodyStart && lines[absBodyEnd].trim() === '') absBodyEnd--;
        if (absBodyStart > absBodyEnd) return null;

        return {
            startLine: absBodyStart + 1,
            endLine: absBodyEnd + 1,
            bodyLines: lines.slice(absBodyStart, absBodyEnd + 1)
        };
    };

    // Pattern 1: `export default new CLI(` or `export default new TUI(`.
    for (let i = 0; i < lines.length; i++) {
        if (/^export\s+default\s+new\s+(?:CLI|TUI)\s*\(/.test(lines[i].trimStart())) {
            const body = extractArrowBody(i);
            if (body) return body;
        }
    }

    // Pattern 2: `export default <identifier>` → find
    // `const <identifier> = new CLI(...)` or `new TUI(...)`.
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trimStart().match(/^export\s+default\s+(\w+)\s*;?\s*$/);
        if (!m) continue;
        const identifier = m[1];
        for (let j = 0; j < lines.length; j++) {
            const decl = lines[j].match(
                new RegExp(`^const\\s+${identifier}\\s*=\\s*new\\s+(?:CLI|TUI)\\s*\\(`)
            );
            if (decl) {
                const body = extractArrowBody(j);
                if (body) return body;
            }
        }
    }

    return null;
};

/**
 * Extract public (exported) members. Returns a list of
 * { name, kind, startLine, endLine, lines }.
 */
const mjsExtractPublicMembers = (content) => extractExportedMembers(content);

/**
 * Extract structured export and import binding declarations from ESM
 * JavaScript source. Returns { exports, imports }.
 *
 * exports: { [bindingName]: { line, type } }
 *   type is 'named', 'default', or 'reexport'.
 * imports: [ { binding, localName, source, line, kind } ]
 *   kind is 'named', 'default', 'namespace', or 'reexport'.
 *
 * Covers:
 *   export function foo() {}        -> exports.foo = { line, type: 'named' }
 *   export const bar = 1            -> exports.bar = { line, type: 'named' }
 *   export class Baz {}             -> exports.Baz = { line, type: 'named' }
 *   export { foo, bar as baz }      -> exports.baz = { line, type: 'named' }
 *   export default function foo()   -> exports.default = { line, type: 'default' }
 *   export default foo              -> exports.default = { line, type: 'default' }
 *   export default { ... }          -> exports.default = { line, type: 'default' }
 *   export * from 'mod'             -> exports['*'] = { line, type: 'reexport', source: 'mod' }
 *   export { foo } from 'mod'       -> exports.foo = { line, type: 'reexport', source: 'mod' }
 *   export { foo as bar } from 'mod'-> exports.bar = { line, type: 'reexport', source: 'mod' }
 *
 *   import defaultName from 'mod'   -> { binding: 'default', localName: 'defaultName', source: 'mod', line, kind: 'default' }
 *   import * as ns from 'mod'       -> { binding: '*', localName: 'ns', source: 'mod', line, kind: 'namespace' }
 *   import { a, b as c } from 'mod' -> two records: a (named), c (named, binding='b')
 *   import d, { a } from 'mod'      -> default + named
 *   import 'mod'                    -> { binding: null, localName: null, source: 'mod', line, kind: 'sideeffect' }
 *   import('mod')                   -> { binding: null, localName: null, source: 'mod', line, kind: 'dynamic' }
 */
const mjsExtractBindings = (content) => {
    const lines = content.split('\n');
    const exports = {};
    const imports = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = i + 1;
        const trimmed = line.trim();

        // ── Exports ──

        // export * from 'mod'
        const reexportAll = trimmed.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/);
        if (reexportAll) {
            exports['*'] = { line: lineNo, type: 'reexport', source: reexportAll[1] };
            continue;
        }

        // export { a, b as c } from 'mod'   (re-export)
        const reexportNamed = trimmed.match(/^export\s+{([^}]*)}\s+from\s+['"]([^'"]+)['"]/);
        if (reexportNamed) {
            const source = reexportNamed[2];
            const names = reexportNamed[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            for (const n of names) {
                const asMatch = n.match(/^(\w+)\s+as\s+(?:default\s+)?(\w+)$/);
                const name = asMatch ? asMatch[2] : n;
                exports[name] = { line: lineNo, type: 'reexport', source };
            }
            continue;
        }

        // export { a, b as c }              (local re-export without source)
        // May span multiple lines: export {\n  a,\n  b\n} from 'mod'  (re-export)
        // or export {\n  a,\n  b\n}         (local export)
        const exportBraceStart = trimmed.match(/^export\s+{/);
        if (exportBraceStart) {
            // Gather the full statement (handle multi-line)
            let stmt = trimmed;
            let stmtLine = lineNo;
            let braceCount =
                (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
            for (let j = i + 1; j < lines.length && braceCount > 0; j++) {
                stmt += ' ' + lines[j].trim();
                braceCount += (lines[j].match(/{/g) || []).length;
                braceCount -= (lines[j].match(/}/g) || []).length;
            }

            // Re-export: export { a, b } from 'mod'
            const reexportMatch = stmt.match(/^export\s+{([^}]*)}\s+from\s+['"]([^'"]+)['"]/);
            if (reexportMatch) {
                const source = reexportMatch[2];
                const names = reexportMatch[1]
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                for (const n of names) {
                    const asMatch = n.match(/^(\w+)\s+as\s+(?:default\s+)?(\w+)$/);
                    const name = asMatch ? asMatch[2] : n;
                    exports[name] = { line: stmtLine, type: 'reexport', source };
                }
                continue;
            }

            // Local export: export { a, b as c }
            const localMatch = stmt.match(/^export\s+{([^}]*)}\s*;?\s*$/);
            if (localMatch) {
                const names = localMatch[1]
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                for (const n of names) {
                    const asMatch = n.match(/^(\w+)\s+as\s+(?:default\s+)?(\w+)$/);
                    const name = asMatch ? asMatch[2] : n;
                    exports[name] = { line: stmtLine, type: 'named' };
                }
                continue;
            }
        }

        // export default ...
        const exportDefault = trimmed.match(/^export\s+default\s+/);
        if (exportDefault) {
            exports.default = { line: lineNo, type: 'default' };
            continue;
        }

        // export function foo / export const foo / export class Foo
        const exportDecl = trimmed.match(
            /^export\s+(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+))/
        );
        if (exportDecl) {
            const name = exportDecl[1] || exportDecl[2] || exportDecl[3];
            exports[name] = { line: lineNo, type: 'named' };
            continue;
        }

        // ── Imports ──

        // import 'mod'   (side-effect only)
        const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
        if (sideEffect && !trimmed.match(/^import\s+\w/) && !trimmed.match(/^import\s*{/)) {
            imports.push({
                binding: null,
                localName: null,
                source: sideEffect[1],
                line: lineNo,
                kind: 'sideeffect'
            });
            continue;
        }

        // Full import statement (may span multiple lines — gather continuation)
        const importStart = trimmed.match(/^import\s+/);
        if (importStart) {
            // Gather the full statement (handle multi-line imports)
            let stmt = trimmed;
            let stmtLine = lineNo;
            if (!stmt.match(/from\s+['"]/)) {
                for (let j = i + 1; j < lines.length; j++) {
                    stmt += ' ' + lines[j].trim();
                    if (lines[j].trim().match(/from\s+['"]/)) break;
                    if (j - i > 10) break; // safety limit
                }
            }

            const sourceMatch = stmt.match(/from\s+['"]([^'"]+)['"]/);
            if (sourceMatch) {
                const source = sourceMatch[1];
                // default: import defaultName from 'mod'
                const defaultMatch = stmt.match(/^import\s+(\w+)\s+from\s+['"]/);
                if (defaultMatch) {
                    imports.push({
                        binding: 'default',
                        localName: defaultMatch[1],
                        source,
                        line: stmtLine,
                        kind: 'default'
                    });
                }
                // namespace: import * as ns from 'mod'
                const nsMatch = stmt.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]/);
                if (nsMatch) {
                    imports.push({
                        binding: '*',
                        localName: nsMatch[1],
                        source,
                        line: stmtLine,
                        kind: 'namespace'
                    });
                }
                // named: import { a, b as c } from 'mod'
                const namedMatch = stmt.match(
                    /import\s*(?:\w+(?:\s*,\s*)?)?\s*{([^}]*)}\s*from\s+['"]/
                );
                if (namedMatch) {
                    const names = namedMatch[1]
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    for (const n of names) {
                        const asMatch = n.match(/^(\w+)\s+as\s+(\w+)$/);
                        if (asMatch) {
                            imports.push({
                                binding: asMatch[1],
                                localName: asMatch[2],
                                source,
                                line: stmtLine,
                                kind: 'named'
                            });
                        } else {
                            imports.push({
                                binding: n,
                                localName: n,
                                source,
                                line: stmtLine,
                                kind: 'named'
                            });
                        }
                    }
                }
                // combined default + namespace: import d, * as ns from 'mod'
                const combinedNs = stmt.match(
                    /^import\s+(\w+)\s*,\s*\*\s+as\s+(\w+)\s+from\s+['"]/
                );
                if (combinedNs && !defaultMatch) {
                    imports.push({
                        binding: 'default',
                        localName: combinedNs[1],
                        source,
                        line: stmtLine,
                        kind: 'default'
                    });
                    imports.push({
                        binding: '*',
                        localName: combinedNs[2],
                        source,
                        line: stmtLine,
                        kind: 'namespace'
                    });
                }
                continue;
            }
        }

        // Dynamic import: import('mod')
        const dynamicMatch = trimmed.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (dynamicMatch) {
            imports.push({
                binding: null,
                localName: null,
                source: dynamicMatch[1],
                line: lineNo,
                kind: 'dynamic'
            });
        }
    }

    return { exports, imports };
};

const mjsLanguage = new Language('mjs', {
    template: mjsTemplate,
    parseImports: mjsParseImports,
    extractMainFunction: mjsExtractMainFunction,
    extractPublicMembers: mjsExtractPublicMembers,
    extractBindings: mjsExtractBindings,
    extractEntryPoint: mjsExtractEntryPoint
});

/**
 * Shared helper: locate a braced function body declared at any column.
 * Used by the JS/mjs language classes.
 */
function extractBracedMain(content, signatureRe) {
    const lines = content.split('\n');
    let mainStart = -1;
    for (let i = 0; i < lines.length; i++) {
        if (signatureRe.test(lines[i])) {
            mainStart = i;
            break;
        }
    }
    if (mainStart === -1) return null;

    let braceCount = 0;
    let foundOpen = false;
    let mainEnd = -1;
    for (let i = mainStart; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') {
                braceCount++;
                foundOpen = true;
            } else if (ch === '}') {
                braceCount--;
            }
        }
        if (foundOpen && braceCount === 0) {
            mainEnd = i;
            break;
        }
    }
    if (mainEnd === -1) return null;

    let absBodyStart = mainStart + 1;
    let absBodyEnd = mainEnd - 1; // exclude closing }
    while (absBodyStart <= absBodyEnd && lines[absBodyStart].trim() === '') absBodyStart++;
    while (absBodyEnd >= absBodyStart && lines[absBodyEnd].trim() === '') absBodyEnd--;
    if (absBodyStart > absBodyEnd) return null;

    return {
        startLine: absBodyStart + 1,
        endLine: absBodyEnd + 1,
        bodyLines: lines.slice(absBodyStart, absBodyEnd + 1)
    };
}

/**
 * Shared helper: extract `export`-prefixed members from JS/mjs source.
 *
 * Two passes:
 *  1. Inline export declarations (`export function foo`, `export class Bar`,
 *     `export const baz`) — captured directly at the declaration site.
 *  2. Detached `export { name1, name2, ... }` blocks (no `from`) — for each
 *     named export, the matching plain declaration (`function name`,
 *     `class name`, `const/let/var name`) is located earlier in the file
 *     and recorded as a member. This is standard ESM, not rarebert-specific.
 */
function extractExportedMembers(content) {
    const lines = content.split('\n');
    const members = [];
    const seen = new Set();

    const captureRange = (startIdx) => {
        let braceCount = 0;
        let foundOpen = false;
        for (let i = startIdx; i < lines.length; i++) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '{') {
                    braceCount++;
                    foundOpen = true;
                } else if (ch === '}') {
                    braceCount--;
                }
            }
            if (foundOpen && braceCount === 0) return i;
            // const/let without braces: terminate at first non-continuation line
            if (!foundOpen && i > startIdx) {
                const prev = lines[i - 1];
                if (!prev.endsWith(',') && !prev.endsWith('\\') && !prev.endsWith('(')) {
                    return i - 1;
                }
            }
        }
        return lines.length - 1;
    };

    const declPatterns = [
        { re: /^(?:async\s+)?function\s+(\w+)/, kind: 'function' },
        { re: /^class\s+(\w+)/, kind: 'class' },
        { re: /^(?:const|let|var)\s+(\w+)/, kind: 'const' }
    ];

    const findDeclaration = (name) => {
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();
            // Skip inline-exported declarations — already captured in pass 1.
            if (/^export\s/.test(trimmed)) continue;
            for (const { re, kind } of declPatterns) {
                const m = trimmed.match(re);
                if (m && m[1] === name) {
                    const end = captureRange(i);
                    return {
                        name,
                        kind,
                        startLine: i + 1,
                        endLine: end + 1,
                        lines: lines.slice(i, end + 1)
                    };
                }
            }
        }
        return null;
    };

    // Pass 1: inline export declarations.
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fnMatch = line.match(/^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/);
        const classMatch = line.match(/^export\s+(?:default\s+)?class\s+(\w+)/);
        const constMatch = line.match(/^export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/);

        const m = fnMatch || classMatch || constMatch;
        if (!m) continue;

        const name = m[1];
        const kind = classMatch ? 'class' : fnMatch ? 'function' : 'const';
        const end = captureRange(i);
        const member = {
            name,
            kind,
            startLine: i + 1,
            endLine: end + 1,
            lines: lines.slice(i, end + 1)
        };
        members.push(member);
        seen.add(name);
    }

    // Pass 2: detached `export { name, ... }` blocks (no `from`).
    // Handles both single-line (`export { foo, bar }`) and multi-line
    // (`export {\n  foo,\n  bar\n}`) forms.
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!/^export\s+{/.test(trimmed)) continue;

        // Gather lines until the closing brace.
        let blockText = trimmed;
        let endIdx = i;
        if (!blockText.includes('}')) {
            for (let j = i + 1; j < lines.length; j++) {
                blockText += '\n' + lines[j];
                endIdx = j;
                if (lines[j].includes('}')) break;
            }
        }
        // Extract the content between the first { and the last }.
        const braceStart = blockText.indexOf('{');
        const braceEnd = blockText.lastIndexOf('}');
        if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) continue;
        const inner = blockText.slice(braceStart + 1, braceEnd);
        // Skip re-exports (`export { ... } from '...'`).
        if (/\bfrom\s+['"]/.test(blockText)) continue;

        const names = inner
            .split(/[,\n]/)
            .map((s) => s.trim())
            .map((s) => {
                const asMatch = s.match(/^(\w+)\s+as\s+(\w+)$/);
                return asMatch
                    ? { local: asMatch[1], exported: asMatch[2] }
                    : { local: s, exported: s };
            })
            .filter((s) => s.local && s.exported);

        for (const { local, exported } of names) {
            if (seen.has(exported)) continue;
            const decl = findDeclaration(local);
            if (!decl) continue;
            members.push({ ...decl, name: exported });
            seen.add(exported);
        }

        i = endIdx; // skip consumed lines
    }

    return members;
}

export { mjsLanguage, extractBracedMain, extractExportedMembers, mjsExtractBindings };
export default mjsLanguage;
