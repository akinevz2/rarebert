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
 * Extract public top-level members (def/class not starting with `_`).
 * Returns a list of { name, kind, startLine, endLine, lines }.
 */
const pyExtractPublicMembers = (content) => {
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
        if (name.startsWith('_')) continue;
        const end = captureRange(i);
        members.push({
            name,
            kind: classMatch ? 'class' : 'function',
            startLine: i + 1,
            endLine: end + 1,
            lines: lines.slice(i, end + 1)
        });
    }
    return members;
};

const pyLanguage = new Language('py', {
    template: pyTemplate,
    parseImports: pyParseImports,
    extractMainFunction: pyExtractMainFunction,
    extractPublicMembers: pyExtractPublicMembers
});

export { pyLanguage };
export default pyLanguage;
