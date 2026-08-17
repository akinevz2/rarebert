/**
 * Language support for CommonJS JavaScript (.js).
 *
 * Exports a ready-made `Language` instance providing the boilerplate
 * template (as a `Template` member) and language-variadic analysis:
 * a `require` parser, main()-body extraction, and public member
 * extraction.
 *
 * Import notation:
 *   - `foo::fs`      for `const { foo } = require('fs')`
 *   - `foo, bar::fs` for `const { foo, bar } = require('fs')`
 *   - `foo<-fs`      for `const foo = require('fs')` (whole-module binding)
 */

import { Language } from '../languages.mjs';
import { Template } from '../template.mjs';
import { extractBracedMain, extractExportedMembers, mjsExtractTopLevelMembers, mjsExtractLocalMembers, mjsExplorableMembers, mjsExtractDeclarationReferences } from './langmjs.js';

const jsLines = {
    shebang: '#!/usr/bin/env node',
    blank: '',
    imports: "const { PROJECT_ROOT } = require('{{CORE_IMPORT}}');",
    lib_imports: '{{LIB_IMPORTS}}',
    main_open: 'async function main() {',
    main_scaffold: '    // {{MODULE_NAME}}: implementation scaffold',
    main_todo: '    const todo = `',
    main_todo_body: '{{MODULE_NAME}} module - not yet implemented',
    main_todo_blank: '',
    main_todo_tasks: 'TODO:',
    main_todo_close: '`;',
    main_stub: '    console.log(todo);',
    main_close: '}',
    main_guard: 'if (require.main === module) {',
    main_call: '    main();',
    guard_close: '}',
    export_open: 'module.exports = {',
    export_name: "    name: '{{MODULE_NAME}}',",
    export_desc: "    description: '{{MODULE_NAME}} module'",
    export_close: '};'
};

const jsSections = [
    'shebang',
    'blank',
    'imports',
    'lib_imports',
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
    'main_guard',
    'main_call',
    'guard_close',
    'blank',
    'export_open',
    'export_name',
    'export_desc',
    'export_close',
    'blank'
];

const jsTemplate = new Template({ lines: jsLines, sections: jsSections });

/**
 * Parse CommonJS `require` calls from `content` and return a list of
 * notated import strings (see file header for the notation).
 *
 * Covers:
 *   const x = require('mod')            ->  "x<-mod"
 *   const { a, b: c } = require('mod')  ->  "a::mod", "c<-mod"
 *   require('mod')                      ->  "mod"  (bare, side-effect only)
 *
 * @param {string} content - full module source
 * @returns {string[]} notated imports
 */
const jsParseImports = (content) => {
    const results = [];

    // Strip comment lines (JSDoc, line, block) so example require()
    // calls in documentation don't produce false-positive imports.
    const stripped = content
        .split('\n')
        .filter((l) => {
            const t = l.trim();
            return !t.startsWith('*') && !t.startsWith('//') &&
                !t.startsWith('/*') && !t.startsWith('*/');
        })
        .join('\n');

    // Destructured: const { a, b: c } = require('mod')
    const destructureRe =
        /(?:const|let|var)\s*{\s*([^}]+?)\s*}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = destructureRe.exec(stripped)) !== null) {
        const mod = m[2];
        if (mod.includes('{{')) continue;
        const names = m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        for (const n of names) {
            // `b: c` -> local alias c for property b  ->  "c<-mod"
            const aliasMatch = n.match(/^(\w+)\s*:\s*(\w+)$/);
            if (aliasMatch) {
                results.push(`${aliasMatch[2]}<-${mod}`);
            } else {
                results.push(`${n}::${mod}`);
            }
        }
    }

    // Whole-module: const x = require('mod')  (but not the destructure form above)
    const wholeRe = /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = wholeRe.exec(stripped)) !== null) {
        const [, local, mod] = m;
        if (mod.includes('{{')) continue;
        results.push(`${local}<-${mod}`);
    }

    // Bare side-effect: require('mod')
    const bareRe = /(?<![\w.])require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = bareRe.exec(stripped)) !== null) {
        const mod = m[1];
        if (mod.includes('{{')) continue;
        // Avoid duplicating entries already captured by the forms above
        if (!results.some((r) => r.endsWith(`<-${mod}`) || r.endsWith(`::${mod}`) || r === mod)) {
            results.push(mod);
        }
    }

    return results;
};

/**
 * Extract the body of the main() function. Returns
 * { startLine, endLine, bodyLines } (1-indexed) or null.
 */
const jsExtractMainFunction = (content) =>
    extractBracedMain(content, /^(?:async\s+)?function\s+main\s*\(/);

/**
 * Extract public (exported) members. Returns a list of
 * { name, kind, startLine, endLine, lines }.
 */
const jsExtractPublicMembers = (content) => extractExportedMembers(content);

/**
 * Extract structured export and import binding declarations from
 * CommonJS JavaScript source. Returns { exports, imports }.
 *
 * exports: { [bindingName]: { line, type } }
 *   type is 'named' or 'default'.
 * imports: [ { binding, localName, source, line, kind } ]
 *   kind is 'named', 'default', or 'sideeffect'.
 *
 * Covers:
 *   module.exports = { foo, bar }       -> exports.foo, exports.bar (named)
 *   module.exports = { foo: fn, bar }    -> exports.foo, exports.bar
 *   module.exports = function foo() {}   -> exports.default (default)
 *   module.exports = fn                  -> exports.default (default)
 *   exports.foo = function() {}          -> exports.foo (named)
 *   exports.bar = 1                      -> exports.bar (named)
 *   exports = { foo, bar }               -> exports.foo, exports.bar (named)
 *
 *   const x = require('mod')             -> { binding: null, localName: 'x', source, kind: 'default' }
 *   const { a, b: c } = require('mod')   -> a (named), c (named, binding='b')
 *   require('mod')                       -> { binding: null, localName: null, source, kind: 'sideeffect' }
 */
const jsExtractBindings = (content) => {
    const lines = content.split('\n');
    const exports = {};
    const imports = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = i + 1;
        const trimmed = line.trim();

        // Skip comments (JSDoc, line, block) — these often contain
        // example require() calls that would be false-positive imports.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') ||
            trimmed.startsWith('/*') || trimmed.startsWith('*/')) continue;

        // ── Exports ──
        // Only match export patterns at the top level (column 0);
        // indented `exports.foo = ...` / `module.exports = ...` inside
        // function bodies are implementation code, not export declarations.
        const isTopLevel = line === trimmed;

        // module.exports = { ... }
        const moduleExportsObj = isTopLevel && trimmed.match(/^module\.exports\s*=\s*{/);
        if (moduleExportsObj) {
            // Gather the full object (may span multiple lines)
            let objText = trimmed;
            let braceCount = (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
            let startLine = lineNo;
            for (let j = i + 1; j < lines.length && braceCount > 0; j++) {
                objText += ' ' + lines[j].trim();
                braceCount += (lines[j].match(/{/g) || []).length;
                braceCount -= (lines[j].match(/}/g) || []).length;
            }
            // Extract keys from the object literal
            const keys = objText
                .replace(/^module\.exports\s*=\s*{/, '')
                .replace(/}\s*;?\s*$/, '');
            const pairs = keys
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            for (const p of pairs) {
                // `foo: bar` or just `foo` (shorthand)
                const kvMatch = p.match(/^(\w+)\s*:/);
                const shorthandMatch = p.match(/^(\w+)\s*$/);
                const name = kvMatch ? kvMatch[1] : shorthandMatch ? shorthandMatch[1] : null;
                if (name) {
                    exports[name] = { line: startLine, type: 'named' };
                }
            }
            continue;
        }

        // module.exports = function ... / module.exports = fn (default)
        const moduleExportsFn = isTopLevel && trimmed.match(/^module\.exports\s*=\s*(?:function|class|\w)/);
        if (moduleExportsFn && !moduleExportsObj) {
            exports.default = { line: lineNo, type: 'default' };
            continue;
        }

        // exports.foo = ...
        const exportsAssign = isTopLevel && trimmed.match(/^exports\.(\w+)\s*=/);
        if (exportsAssign) {
            exports[exportsAssign[1]] = { line: lineNo, type: 'named' };
            continue;
        }

        // exports = { ... }
        const exportsObj = isTopLevel && trimmed.match(/^exports\s*=\s*{/);
        if (exportsObj) {
            let objText = trimmed;
            let braceCount = (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
            let startLine = lineNo;
            for (let j = i + 1; j < lines.length && braceCount > 0; j++) {
                objText += ' ' + lines[j].trim();
                braceCount += (lines[j].match(/{/g) || []).length;
                braceCount -= (lines[j].match(/}/g) || []).length;
            }
            const keys = objText
                .replace(/^exports\s*=\s*{/, '')
                .replace(/}\s*;?\s*$/, '');
            const pairs = keys
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            for (const p of pairs) {
                const kvMatch = p.match(/^(\w+)\s*:/);
                const shorthandMatch = p.match(/^(\w+)\s*$/);
                const name = kvMatch ? kvMatch[1] : shorthandMatch ? shorthandMatch[1] : null;
                if (name) {
                    exports[name] = { line: startLine, type: 'named' };
                }
            }
            continue;
        }

        // ── Imports (require) ──

        // const { a, b: c } = require('mod')
        const destructureMatch = trimmed.match(
            /^(?:const|let|var)\s+{\s*([^}]+?)\s*}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/
        );
        if (destructureMatch) {
            const source = destructureMatch[2];
            const names = destructureMatch[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            for (const n of names) {
                const aliasMatch = n.match(/^(\w+)\s*:\s*(\w+)$/);
                if (aliasMatch) {
                    imports.push({
                        binding: aliasMatch[1],
                        localName: aliasMatch[2],
                        source,
                        line: lineNo,
                        kind: 'named'
                    });
                } else {
                    imports.push({
                        binding: n,
                        localName: n,
                        source,
                        line: lineNo,
                        kind: 'named'
                    });
                }
            }
            continue;
        }

        // const x = require('mod')
        const wholeMatch = trimmed.match(
            /^(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/
        );
        if (wholeMatch) {
            imports.push({
                binding: null,
                localName: wholeMatch[1],
                source: wholeMatch[2],
                line: lineNo,
                kind: 'default'
            });
            continue;
        }

        // require('mod')  (bare side-effect)
        const bareMatch = trimmed.match(/^require\(\s*['"]([^'"]+)['"]\s*\)/);
        if (bareMatch) {
            imports.push({
                binding: null,
                localName: null,
                source: bareMatch[1],
                line: lineNo,
                kind: 'sideeffect'
            });
        }
    }

    return { exports, imports };
};

const jsExtractDeclarationReferences = mjsExtractDeclarationReferences;

const jsLanguage = new Language('js', {
    template: jsTemplate,
    parseImports: jsParseImports,
    extractMainFunction: jsExtractMainFunction,
    extractPublicMembers: jsExtractPublicMembers,
    extractTopLevelMembers: mjsExtractTopLevelMembers,
    extractLocalMembers: mjsExtractLocalMembers,
    explorableMembers: mjsExplorableMembers,
    extractBindings: jsExtractBindings,
    extractDeclarationReferences: jsExtractDeclarationReferences
});

export { jsLanguage, jsExtractBindings, jsExtractDeclarationReferences };
export default jsLanguage;
