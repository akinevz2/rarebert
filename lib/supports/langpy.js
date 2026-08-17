/**
 * Language support for Python (.py).
 *
 * Exports a ready-made `Language` instance providing the boilerplate
 * template (as a `Template` member) and language-variadic analysis:
 * a Python `import` parser, main()-body extraction (indentation-based),
 * and top-level public member extraction.
 *
 * Import notation:
 *   - `a.b`          for `import a.b`
 *   - `b, c::a`      for `from a import b, c`
 *   - `c<-a`         for `from a import b as c`  (alias)
 */

import { Language } from '../languages.mjs';
import { Template } from '../template.mjs';

const pyLines = {
    shebang: '#!/usr/bin/env python3',
    blank: '',
    docstring_open: '"""',
    docstring: '{{MODULE_NAME}} module',
    docstring_close: '"""',
    preamble: '{{LIB_IMPORTS}}',
    main_open: 'def main():',
    main_scaffold: '    # {{MODULE_NAME}}: implementation scaffold',
    main_todo: '    # TODO: Implement the logic here.',
    main_stub: "    print('{{MODULE_NAME}} module - not yet implemented')",
    main_guard: "if __name__ == '__main__':",
    main_call: '    main()'
};

const pySections = [
    'shebang',
    'blank',
    'docstring_open',
    'docstring',
    'docstring_close',
    'blank',
    'preamble',
    'blank',
    'main_open',
    'main_scaffold',
    'main_todo',
    'main_stub',
    'blank',
    'main_guard',
    'main_call'
];

const pyTemplate = new Template({ lines: pyLines, sections: pySections });

/**
 * Parse Python import statements from `content` and return a list of
 * notated import strings (see file header for the notation).
 *
 * Covers:
 *   import a.b              ->  "a.b"
 *   import a.b as c         ->  "c<-a.b"
 *   from a import b         ->  "b::a"
 *   from a import b, c      ->  "b, c::a"
 *   from a import b as d    ->  "d<-a"
 *
 * @param {string} content - full module source
 * @returns {string[]} notated imports
 */
const pyParseImports = (content) => {
    const results = [];

    // import a.b  /  import a.b as c
    const plainRe = /^import\s+([a-zA-Z_][\w.]*(?:\s+as\s+\w+)?)/gm;
    let m;
    while ((m = plainRe.exec(content)) !== null) {
        const clause = m[1].trim();
        const asMatch = clause.match(/^([a-zA-Z_][\w.]*)\s+as\s+(\w+)$/);
        if (asMatch) {
            results.push(`${asMatch[2]}<-${asMatch[1]}`);
        } else {
            results.push(clause);
        }
    }

    // from a import b, c as d
    const fromRe = /^from\s+([a-zA-Z_][\w.]*)\s+import\s+(.+)/gm;
    while ((m = fromRe.exec(content)) !== null) {
        const mod = m[1];
        const names = m[2]
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
        results.push(notated.join(', '));
    }

    return results;
};

/**
 * Extract the body of the main() function (indentation-based).
 * Returns { startLine, endLine, bodyLines } (1-indexed) or null.
 */
const pyExtractMainFunction = (content) => {
    const lines = content.split('\n');
    let mainStart = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^def\s+main\s*\(/.test(lines[i])) {
            mainStart = i;
            break;
        }
    }
    if (mainStart === -1) return null;

    const defIndent = lines[mainStart].match(/^\s*/)[0].length;
    let mainEnd = -1;
    for (let i = mainStart + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;
        const indent = line.match(/^\s*/)[0].length;
        if (indent <= defIndent && line.trim() !== '') {
            mainEnd = i - 1;
            break;
        }
    }
    if (mainEnd === -1) mainEnd = lines.length - 1;

    let absBodyStart = mainStart + 1;
    let absBodyEnd = mainEnd;
    while (absBodyStart <= absBodyEnd && lines[absBodyStart].trim() === '') absBodyStart++;
    while (absBodyEnd >= absBodyStart && lines[absBodyEnd].trim() === '') absBodyEnd--;
    if (absBodyStart > absBodyEnd) return null;

    return {
        startLine: absBodyStart + 1,
        endLine: absBodyEnd + 1,
        bodyLines: lines.slice(absBodyStart, absBodyEnd + 1)
    };
};

/**
 * Extract ALL top-level def/class declarations (column-0, including
 * underscore-prefixed private names). Each member carries an `exported`
 * boolean (true for non-underscore names). This is the polymorphic
 * "what counts as a top-level declaration" primitive for Python.
 *
 * Returns a list of { name, kind, startLine, endLine, lines, exported }.
 */
const pyExtractTopLevelMembers = (content) => {
    const lines = content.split('\n');
    const members = [];

    const captureRange = (startIdx) => {
        const indent = lines[startIdx].match(/^\s*/)[0].length;
        let end = startIdx;
        for (let i = startIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '') continue;
            const cur = line.match(/^\s*/)[0].length;
            if (cur <= indent) {
                end = i - 1;
                break;
            }
            end = i;
        }
        if (end < startIdx) end = startIdx;
        return end;
    };

    for (let i = 0; i < lines.length; i++) {
        const defMatch = lines[i].match(/^def\s+(\w+)\s*\(/);
        const classMatch = lines[i].match(/^class\s+(\w+)/);
        const m = defMatch || classMatch;
        if (!m) continue;
        const name = m[1];
        const end = captureRange(i);
        members.push({
            name,
            kind: classMatch ? 'class' : 'function',
            startLine: i + 1,
            endLine: end + 1,
            lines: lines.slice(i, end + 1),
            exported: !name.startsWith('_')
        });
    }
    return members;
};

/**
 * Extract public top-level members (def/class not starting with `_`).
 * Returns a list of { name, kind, startLine, endLine, lines }.
 */
const pyExtractPublicMembers = (content) => pyExtractTopLevelMembers(content).filter((m) => m.exported);

/**
 * Extract local declarations (assignments) inside a Python def body.
 * Used by the nested tracer. Returns a list of
 * { name, kind, startLine, endLine, lines, valueExpr }.
 *
 * `decl` is { startLine, endLine, lines } (the parent def).
 */
const pyExtractLocalDeclarations = (decl, content) => {
    if (!decl || !decl.lines) return [];
    const bodyLines = decl.lines;
    const bodyStart = decl.startLine;
    const members = [];

    for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        const trimmed = line.trim();
        const m = trimmed.match(/^(\w+)\s*=\s*(.*)/);
        if (!m) continue;
        const name = m[1];
        const valueExpr = m[2].trim();
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

const pyExplorableMembers = { local: pyExtractLocalDeclarations };

const pyExtractLocalMembers = (decl, content, kind) => {
    if (kind) {
        const fn = pyExplorableMembers[kind];
        return fn ? fn(decl, content) : [];
    }
    const all = [];
    for (const fn of Object.values(pyExplorableMembers)) {
        all.push(...fn(decl, content));
    }
    return all;
};

/**
 * Identify which names from `knownNames` are referenced in the body of
 * a declaration. Python identifier version — uses \b word boundaries.
 */
const pyExtractDeclarationReferences = (decl, content, knownNames) => {
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
 * Extract structured export and import bindings from Python source.
 * Returns { exports: {[name]: {line, type}}, imports: [{ binding, localName, source, line, kind }] }.
 * kind is one of: named, namespace, star, relative, sideeffect.
 * type is always 'named' (Python has no default/reexport distinction).
 */
const pyExtractBindings = (content) => {
    const lines = content.split('\n');
    const exports = {};
    const imports = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip comments and blank lines
        if (!trimmed || trimmed.startsWith('#')) continue;

        // __all__ = [...] or __all__ += [...]
        const allMatch = trimmed.match(/^__all__\s*(?:\+?=)\s*\[(.*)\]\s*$/);
        if (allMatch) {
            const items = allMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
            for (const item of items) {
                exports[item] = { line: i + 1, type: 'named' };
            }
            continue;
        }

        // import module or import module as alias
        const importMatch = trimmed.match(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?$/);
        if (importMatch) {
            const source = importMatch[1];
            const localName = importMatch[2] || source.split('.')[0];
            imports.push({
                binding: source,
                localName,
                source,
                line: i + 1,
                kind: 'namespace'
            });
            continue;
        }

        // from module import names
        const fromMatch = trimmed.match(/^from\s+(\.*)([\w.]+)?\s+import\s+(.+)$/);
        if (fromMatch) {
            const dots = fromMatch[1] || '';
            const modName = fromMatch[2] || '';
            const source = dots + modName;
            const importPart = fromMatch[3].trim();

            // from mod import *
            if (importPart === '*') {
                imports.push({
                    binding: '*',
                    localName: '*',
                    source,
                    line: i + 1,
                    kind: 'star'
                });
                continue;
            }

            const kind = dots ? 'relative' : 'named';
            const items = importPart.split(',').map(s => s.trim()).filter(Boolean);
            for (const item of items) {
                const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
                if (asMatch) {
                    imports.push({
                        binding: asMatch[1],
                        localName: asMatch[2],
                        source,
                        line: i + 1,
                        kind
                    });
                } else {
                    imports.push({
                        binding: item,
                        localName: item,
                        source,
                        line: i + 1,
                        kind
                    });
                }
            }
            continue;
        }
    }

    // If no __all__ was found, synthesize exports from public members
    if (Object.keys(exports).length === 0) {
        const members = pyExtractPublicMembers(content);
        for (const m of members) {
            if (m.name && !m.name.startsWith('_')) {
                exports[m.name] = { line: m.startLine, type: 'named' };
            }
        }
    }

    return { exports, imports };
};

const pyLanguage = new Language('py', {
    template: pyTemplate,
    parseImports: pyParseImports,
    extractMainFunction: pyExtractMainFunction,
    extractPublicMembers: pyExtractPublicMembers,
    extractTopLevelMembers: pyExtractTopLevelMembers,
    extractLocalMembers: pyExtractLocalMembers,
    explorableMembers: pyExplorableMembers,
    extractBindings: pyExtractBindings,
    extractDeclarationReferences: pyExtractDeclarationReferences
});

export { pyLanguage, pyExtractBindings, pyExtractDeclarationReferences };
export default pyLanguage;
