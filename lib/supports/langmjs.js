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
    imports: "import { cli, CLI, TUI } from '{{CLI_IMPORT}}';",
    exit_import: "import { exit } from '../lib/core.mjs';",
    lib_imports: '{{LIB_IMPORTS}}',
    meta_open: 'const meta = {',
    meta_name: "    name: '{{MODULE_NAME}}',",
    meta_desc: "    description: '{{MODULE_NAME}} module',",
    meta_usage: "    usage: 'node index.js {{MODULE_NAME}}',",
    meta_options: '    options: []',
    meta_close: '};',
    main_open: 'async function main(opts, positional) {',
    main_scaffold: '    // {{MODULE_NAME}}: implementation scaffold',
    main_stub: "    console.log('{{MODULE_NAME}} module - not yet implemented');",
    main_exit: '    return exit(0);',
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
    'exit_import',
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
    'main_stub',
    'main_exit',
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
            // Gather the full statement (handle multi-line imports).
            // Cap continuation at 200 lines to avoid runaway loops on
            // malformed input; also bail if a new top-level statement
            // starts before we find `from`.
            let stmt = trimmed;
            let stmtLine = lineNo;
            if (!stmt.match(/from\s+['"]/)) {
                for (let j = i + 1; j < lines.length; j++) {
                    const nextTrim = lines[j].trim();
                    if (
                        nextTrim.match(/^import\s+/) ||
                        nextTrim.match(/^export\s+/) ||
                        nextTrim.match(/^(?:async\s+)?function\s+\w/) ||
                        nextTrim.match(/^(?:const|let|var|class)\s+\w/)
                    )
                        break;
                    stmt += ' ' + nextTrim;
                    if (nextTrim.match(/from\s+['"]/)) break;
                    if (j - i > 200) break;
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

/**
 * Identify which names from `knownNames` are referenced in the body of
 * a declaration. Returns the subset of knownNames actually used.
 * `decl` is { name, kind, startLine, endLine, lines }. `knownNames`
 * is an array of identifier strings (import localNames + sibling decl names).
 */
const mjsExtractDeclarationReferences = (decl, content, knownNames) => {
    if (!decl || !decl.lines || !knownNames || knownNames.length === 0) return [];
    const body = decl.lines.join('\n');
    const referenced = [];
    for (const name of knownNames) {
        if (!name || typeof name !== 'string') continue;
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (re.test(body)) referenced.push(name);
    }
    return referenced;
};

/**
 * Extract ALL top-level declarations (column-0 const/let/var/function/class),
 * whether or not they are prefixed with `export`. Each member carries an
 * `exported` boolean. This is the polymorphic "what counts as a top-level
 * declaration" primitive for ESM JS — used by introspect to populate the
 * declarations list regardless of export style.
 *
 * Returns a list of { name, kind, startLine, endLine, lines, exported }.
 */
const mjsExtractTopLevelMembers = (content) => {
    const lines = content.split('\n');
    const members = [];

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
            if (!foundOpen && i > startIdx) {
                const prev = lines[i - 1];
                if (!prev.endsWith(',') && !prev.endsWith('\\') && !prev.endsWith('(')) {
                    return i - 1;
                }
            }
        }
        return lines.length - 1;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(' ') || line.startsWith('\t')) continue;
        const m = line.match(
            /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+))/
        );
        if (!m) continue;
        const exported = !!m[1];
        const name = m[2] || m[3] || m[4];
        if (!name) continue;
        const kind = m[3] ? 'class' : m[2] ? 'function' : 'const';
        const end = captureRange(i);
        members.push({
            name,
            kind,
            startLine: i + 1,
            endLine: end + 1,
            lines: lines.slice(i, end + 1),
            exported
        });
    }
    return members;
};

/**
 * Extract local declarations (const/let/var) inside a declaration's body.
 * Used by the nested tracer (--trace module::decl::local) to resolve names
 * within a function/method scope. Returns a list of
 * { name, kind, startLine, endLine, lines, valueExpr }.
 *
 * `decl` is { startLine, endLine, lines } (the parent declaration).
 * `content` is the full file source (unused here; absolute lines derive
 * from decl.startLine + the line offset within decl.lines).
 */
const mjsExtractLocalDeclarations = (decl, content) => {
    if (!decl || !decl.lines) return [];
    const bodyLines = decl.lines;
    const bodyStart = decl.startLine;
    const members = [];

    for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        const trimmed = line.trim();
        const m = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(.*)/);
        if (!m) continue;
        const name = m[1];
        const valueExpr = m[2].replace(/;$/, '').trim();
        members.push({
            name,
            kind: 'const',
            startLine: bodyStart + i,
            endLine: bodyStart + i,
            lines: [line],
            valueExpr
        });
    }
    return members;
};

/**
 * Map of explorable declaration kinds for ESM JS. Each key is a label
 * that can appear in trace output; each value is a parser function
 * (decl, content) => Member[].
 */
const mjsExplorableMembers = { local: mjsExtractLocalDeclarations };

/**
 * Dispatch local-member extraction through the explorableMembers map.
 * If `kind` is provided, runs only that kind; otherwise merges all.
 */
const mjsExtractLocalMembers = (decl, content, kind) => {
    if (kind) {
        const fn = mjsExplorableMembers[kind];
        return fn ? fn(decl, content) : [];
    }
    const all = [];
    for (const fn of Object.values(mjsExplorableMembers)) {
        all.push(...fn(decl, content));
    }
    return all;
};

const mjsLanguage = new Language('mjs', {
    template: mjsTemplate,
    parseImports: mjsParseImports,
    extractMainFunction: mjsExtractMainFunction,
    extractPublicMembers: mjsExtractPublicMembers,
    extractTopLevelMembers: mjsExtractTopLevelMembers,
    extractLocalMembers: mjsExtractLocalMembers,
    explorableMembers: mjsExplorableMembers,
    extractBindings: mjsExtractBindings,
    extractDeclarationReferences: mjsExtractDeclarationReferences
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
 */
function extractExportedMembers(content) {
    return mjsExtractTopLevelMembers(content).filter((m) => m.exported);
}

export {
    mjsLanguage,
    extractBracedMain,
    extractExportedMembers,
    mjsExtractBindings,
    mjsExtractDeclarationReferences,
    mjsExtractTopLevelMembers,
    mjsExtractLocalDeclarations,
    mjsExtractLocalMembers,
    mjsExplorableMembers
};
export default mjsLanguage;
