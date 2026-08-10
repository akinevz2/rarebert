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
    imports: "import { cli } from '{{CLI_IMPORT}}';",
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
    export_open: 'export default {',
    export_name: "    name: '{{MODULE_NAME}}',",
    export_desc: "    description: '{{MODULE_NAME}} module',",
    export_usage: "    usage: 'node index.js {{MODULE_NAME}}',",
    export_options: '    options: [],',
    export_main: '    main: cli.run(meta, main)',
    export_close: '};'
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
    'export_open',
    'export_name',
    'export_desc',
    'export_usage',
    'export_options',
    'export_main',
    'export_close',
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

const mjsLanguage = new Language('mjs', {
    template: mjsTemplate,
    parseImports: mjsParseImports,
    extractMainFunction: mjsExtractMainFunction,
    extractPublicMembers: mjsExtractPublicMembers
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
        members.push({
            name,
            kind,
            startLine: i + 1,
            endLine: end + 1,
            lines: lines.slice(i, end + 1)
        });
    }
    return members;
}

export { mjsLanguage, extractBracedMain, extractExportedMembers };
export default mjsLanguage;
