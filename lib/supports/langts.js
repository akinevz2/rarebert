/**
 * Language support for TypeScript (.ts).
 *
 * Exports a ready-made `Language` instance providing the boilerplate
 * template (as a `Template` member) and language-variadic analysis:
 * an ESM `import` parser (with TypeScript `import type` awareness),
 * main()-body extraction, public member extraction, and structured
 * binding extraction.
 *
 * TypeScript uses ESM import syntax with these extensions over .mjs:
 *   - `import type { T } from 'mod'`      (type-only imports)
 *   - `import { foo, type Bar } from 'm'` (inline type-only specifiers)
 *
 * Import notation (same as langmjs):
 *   - `foo::mod`      for `import { foo } from 'mod'`
 *   - `foo<-mod`      for `import foo as ... from 'mod'` (alias)
 *   - `mod`           for `import mod from 'mod'`         (default)
 *   - `*::mod`        for `import * as ns from 'mod'`    (namespace)
 */

import { Language } from '../languages.mjs';
import { Template } from '../template.mjs';
import { extractBracedMain, extractExportedMembers, mjsExtractTopLevelMembers, mjsExtractLocalMembers, mjsExplorableMembers, mjsExtractDeclarationReferences } from './langmjs.js';

const tsLines = {
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
    main_stub: "    console.log('{{MODULE_NAME}} module - not yet implemented');",
    main_close: '}',
    named_export: 'export { main };',
    module_ctor: "const module = new CLI('{{MODULE_NAME}}.mjs', main, meta);",
    export_default: 'export default module;',
    supports_direct: 'module.supportsDirectRunning(import.meta.url);'
};

const tsSections = [
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

const tsTemplate = new Template({ lines: tsLines, sections: tsSections });

/**
 * Parse ESM import statements (including TypeScript `import type`) from
 * `content` and return a list of notated import strings (see file
 * header for the notation).
 *
 * Covers:
 *   import defaultName from 'mod'
 *   import * as ns from 'mod'
 *   import { a, b as c } from 'mod'
 *   import defaultName, { a, b } from 'mod'
 *   import defaultName, * as ns from 'mod'
 *   import type { T } from 'mod'              (TS — type-only)
 *   import { foo, type Bar } from 'mod'       (TS — inline type-only)
 *   import type defaultName from 'mod'        (TS — type-only default)
 *
 * `import type` and inline `type` specifiers are recorded with a
 * `type::` prefix on the notated string so downstream consumers can
 * distinguish runtime imports from type-only ones.
 *
 * @param {string} content - full module source
 * @returns {string[]} notated imports
 */
const tsParseImports = (content) => {
    const results = [];
    const re =
        /import\s+(?:type\s+)?(?:(\w+)(?:\s*,\s*)?)?(?:(\*\s+as\s+\w+|{[^}]*}))?\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = re.exec(content)) !== null) {
        const isTypeImport = /import\s+type\s+/.test(match[0]);
        const defaultName = match[1] || null;
        const namedOrNs = match[2] || null;
        const mod = match[3];
        const typeTag = isTypeImport ? 'type::' : '';

        if (namedOrNs && namedOrNs.startsWith('*')) {
            const nsName = namedOrNs.replace(/\*\s+as\s+/, '').trim();
            const parts = [];
            if (defaultName) parts.push(defaultName);
            parts.push(`${nsName}<-${mod}`);
            results.push(`${typeTag}${parts.join(', ')}`);
        } else if (namedOrNs) {
            const names = namedOrNs
                .replace(/[{}]/g, '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const notated = names.map((n) => {
                const inlineType = /^type\s+/.test(n);
                const cleaned = n.replace(/^type\s+/, '');
                const asMatch = cleaned.match(/^(\w+)\s+as\s+(\w+)$/);
                const tag = inlineType || isTypeImport ? 'type::' : '';
                if (asMatch) {
                    return `${tag}${asMatch[2]}<-${mod}`;
                }
                return `${tag}${cleaned}::${mod}`;
            });
            const parts = [];
            if (defaultName) parts.push(`${typeTag}${defaultName}`);
            parts.push(...notated);
            results.push(parts.join(', '));
        } else if (defaultName) {
            results.push(`${typeTag}${defaultName}`);
        }
    }
    return results;
};

/**
 * Extract the body of the main() function. Returns
 * { startLine, endLine, bodyLines } (1-indexed) or null.
 *
 * TypeScript function signatures may carry type annotations, so the
 * signature regex is widened to accept `main(...args: T[]): R`.
 */
const tsExtractMainFunction = (content) =>
    extractBracedMain(content, /^(?:async\s+)?function\s+main\s*\(/);

/**
 * Extract public (exported) members. Returns a list of
 * { name, kind, startLine, endLine, lines }.
 *
 * Reuses the mjs extractor — TypeScript `export` declarations share the
 * same surface syntax (`export function`, `export class`, `export
 * const`). Type annotations on names are handled by the existing regex
 * which captures the bare identifier.
 */
const tsExtractPublicMembers = (content) => extractExportedMembers(content);

const tsExtractTopLevelMembers = (content) => mjsExtractTopLevelMembers(content);

const tsExtractLocalMembers = mjsExtractLocalMembers;
const tsExplorableMembers = mjsExplorableMembers;

/**
 * Extract structured export and import binding declarations from
 * TypeScript source. Returns { exports, imports }.
 *
 * exports: { [bindingName]: { line, type } }
 *   type is 'named', 'default', 'reexport', or 'type'.
 * imports: [ { binding, localName, source, line, kind } ]
 *   kind is 'named', 'default', 'namespace', 'reexport', 'sideeffect',
 *   'dynamic', or 'type' (for `import type`).
 *
 * Covers the same surface as mjsExtractBindings plus:
 *   export type Foo = ...           -> exports.Foo = { line, type: 'type' }
 *   export interface Foo { ... }    -> exports.Foo = { line, type: 'type' }
 *   import type { T } from 'mod'    -> { binding:'T', localName:'T', source, line, kind:'type' }
 *   import { foo, type Bar } from   -> foo (named), Bar (type)
 */
const tsExtractBindings = (content) => {
    const lines = content.split('\n');
    const exports = {};
    const imports = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = i + 1;
        const trimmed = line.trim();

        // ── Type-only exports ──

        // export type Foo = ...
        const exportType = trimmed.match(/^export\s+type\s+(\w+)/);
        if (exportType) {
            exports[exportType[1]] = { line: lineNo, type: 'type' };
            continue;
        }

        // export interface Foo { ... }
        const exportInterface = trimmed.match(/^export\s+interface\s+(\w+)/);
        if (exportInterface) {
            exports[exportInterface[1]] = { line: lineNo, type: 'type' };
            continue;
        }

        // ── Re-exports ──

        const reexportAll = trimmed.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/);
        if (reexportAll) {
            exports['*'] = { line: lineNo, type: 'reexport', source: reexportAll[1] };
            continue;
        }

        const reexportNamed = trimmed.match(/^export\s+{([^}]*)}\s+from\s+['"]([^'"]+)['"]/);
        if (reexportNamed) {
            const source = reexportNamed[2];
            const names = reexportNamed[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            for (const n of names) {
                const isType = /^type\s+/.test(n);
                const cleaned = n.replace(/^type\s+/, '');
                const asMatch = cleaned.match(/^(\w+)\s+as\s+(?:default\s+)?(\w+)$/);
                const name = asMatch ? asMatch[2] : cleaned;
                exports[name] = {
                    line: lineNo,
                    type: isType ? 'type' : 'reexport',
                    source
                };
            }
            continue;
        }

        // export { a, b as c }   (local export, possibly multi-line)
        const exportBraceStart = trimmed.match(/^export\s+{/);
        if (exportBraceStart) {
            let stmt = trimmed;
            let stmtLine = lineNo;
            let braceCount =
                (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
            for (let j = i + 1; j < lines.length && braceCount > 0; j++) {
                stmt += ' ' + lines[j].trim();
                braceCount += (lines[j].match(/{/g) || []).length;
                braceCount -= (lines[j].match(/}/g) || []).length;
            }

            const reexportMatch = stmt.match(/^export\s+{([^}]*)}\s+from\s+['"]([^'"]+)['"]/);
            if (reexportMatch) {
                const source = reexportMatch[2];
                const names = reexportMatch[1]
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                for (const n of names) {
                    const isType = /^type\s+/.test(n);
                    const cleaned = n.replace(/^type\s+/, '');
                    const asMatch = cleaned.match(/^(\w+)\s+as\s+(?:default\s+)?(\w+)$/);
                    const name = asMatch ? asMatch[2] : cleaned;
                    exports[name] = {
                        line: stmtLine,
                        type: isType ? 'type' : 'reexport',
                        source
                    };
                }
                continue;
            }

            const localMatch = stmt.match(/^export\s+{([^}]*)}\s*;?\s*$/);
            if (localMatch) {
                const names = localMatch[1]
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                for (const n of names) {
                    const isType = /^type\s+/.test(n);
                    const cleaned = n.replace(/^type\s+/, '');
                    const asMatch = cleaned.match(/^(\w+)\s+as\s+(?:default\s+)?(\w+)$/);
                    const name = asMatch ? asMatch[2] : cleaned;
                    exports[name] = { line: stmtLine, type: isType ? 'type' : 'named' };
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

        // export function/class/const (TS: may have type annotations)
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

        // Full import statement (may span multiple lines)
        const importStart = trimmed.match(/^import\s+/);
        if (importStart) {
            const isTypeImport = /^import\s+type\s+/.test(trimmed);
            let stmt = trimmed;
            let stmtLine = lineNo;
            if (!stmt.match(/from\s+['"]/)) {
                for (let j = i + 1; j < lines.length; j++) {
                    const nextTrim = lines[j].trim();
                    if (nextTrim.match(/^import\s+/) ||
                        nextTrim.match(/^export\s+/) ||
                        nextTrim.match(/^(?:async\s+)?function\s+\w/) ||
                        nextTrim.match(/^(?:const|let|var|class)\s+\w/)) break;
                    stmt += ' ' + nextTrim;
                    if (nextTrim.match(/from\s+['"]/)) break;
                    if (j - i > 200) break;
                }
            }

            const sourceMatch = stmt.match(/from\s+['"]([^'"]+)['"]/);
            if (sourceMatch) {
                const source = sourceMatch[1];
                const kindPrefix = isTypeImport ? 'type' : null;

                // default: import [type] defaultName from 'mod'
                const defaultMatch = stmt.match(/^import\s+(?:type\s+)?(\w+)\s+from\s+['"]/);
                if (defaultMatch) {
                    imports.push({
                        binding: 'default',
                        localName: defaultMatch[1],
                        source,
                        line: stmtLine,
                        kind: kindPrefix ?? 'default'
                    });
                }

                // namespace: import [type] * as ns from 'mod'
                const nsMatch = stmt.match(/^import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+['"]/);
                if (nsMatch) {
                    imports.push({
                        binding: '*',
                        localName: nsMatch[1],
                        source,
                        line: stmtLine,
                        kind: kindPrefix ?? 'namespace'
                    });
                }

                // named: import [type] { a, b as c, type Bar } from 'mod'
                const namedMatch = stmt.match(
                    /import\s*(?:\w+(?:\s*,\s*)?)?\s*{([^}]*)}\s*from\s+['"]/
                );
                if (namedMatch) {
                    const names = namedMatch[1]
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    for (const n of names) {
                        const inlineType = /^type\s+/.test(n);
                        const cleaned = n.replace(/^type\s+/, '');
                        const asMatch = cleaned.match(/^(\w+)\s+as\s+(\w+)$/);
                        const effectiveKind = kindPrefix || inlineType ? 'type' : 'named';
                        if (asMatch) {
                            imports.push({
                                binding: asMatch[1],
                                localName: asMatch[2],
                                source,
                                line: stmtLine,
                                kind: effectiveKind
                            });
                        } else {
                            imports.push({
                                binding: cleaned,
                                localName: cleaned,
                                source,
                                line: stmtLine,
                                kind: effectiveKind
                            });
                        }
                    }
                }

                // combined default + namespace
                const combinedNs = stmt.match(
                    /^import\s+(?:type\s+)?(\w+)\s*,\s*\*\s+as\s+(\w+)\s+from\s+['"]/
                );
                if (combinedNs && !defaultMatch) {
                    imports.push({
                        binding: 'default',
                        localName: combinedNs[1],
                        source,
                        line: stmtLine,
                        kind: kindPrefix ?? 'default'
                    });
                    imports.push({
                        binding: '*',
                        localName: combinedNs[2],
                        source,
                        line: stmtLine,
                        kind: kindPrefix ?? 'namespace'
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

const tsExtractDeclarationReferences = mjsExtractDeclarationReferences;

const tsLanguage = new Language('ts', {
    template: tsTemplate,
    parseImports: tsParseImports,
    extractMainFunction: tsExtractMainFunction,
    extractPublicMembers: tsExtractPublicMembers,
    extractTopLevelMembers: tsExtractTopLevelMembers,
    extractLocalMembers: tsExtractLocalMembers,
    explorableMembers: tsExplorableMembers,
    extractBindings: tsExtractBindings,
    extractDeclarationReferences: tsExtractDeclarationReferences
});

export { tsLanguage, tsExtractBindings, tsExtractDeclarationReferences };
export default tsLanguage;
