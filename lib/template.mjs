/**
 * Pure template data + processing utilities.
 *
 * This module deliberately has no dependency on `lib/languages.mjs`:
 * it only defines the `Template` data class (holding `lines` and
 * `sections`) and pure functions that operate on a `Template` passed
 * in by the caller. The `Languages` registry is responsible for
 * loading a `Language` instance, reading its `template` member, and
 * handing it to these functions.
 */

/**
 * Plain data class representing a boilerplate template for one language:
 * a set of symbolic `lines` and named `sections` (arrays of line keys).
 */
class Template {
    constructor({ lines = {}, sections = {} } = {}) {
        this.lines = lines;
        this.sections = sections;
    }

    hasSection(name) {
        return Object.prototype.hasOwnProperty.call(this.sections, name);
    }

    lineKeysFor(section) {
        return this.sections[section] || [];
    }
}

function firstAlpha(s) {
    for (const ch of s) {
        if (/[a-zA-Z]/.test(ch)) return ch.toLowerCase();
    }
    return '';
}

/**
 * Sort template line entries alphabetically by the first alphabetic
 * character of the line value (stable by value length as a tiebreaker).
 */
function sortLinesByFirstAlpha(entries) {
    return [...entries].sort((a, b) => {
        const fa = firstAlpha(a[1]);
        const fb = firstAlpha(b[1]);
        if (fa !== fb) return fa < fb ? -1 : 1;
        return a[1].length - b[1].length;
    });
}

/**
 * Substitute `{{key}}` placeholders in a single line.
 */
function substitute(line, vars = {}) {
    return Object.entries(vars).reduce(
        (l, [key, value]) => l.replaceAll(`{{${key}}}`, value),
        line
    );
}

/**
 * Resolve a section of a `Template` into an array of substituted lines.
 *
 * @param {Template} tpl - template to resolve
 * @param {object} vars - placeholder substitutions
 * @param {string} section - section name (default 'module')
 * @returns {string[]} resolved boilerplate lines
 */
function resolveTemplate(tpl, vars = {}, section = 'module') {
    if (!tpl || !tpl.lines || !tpl.sections) {
        throw new Error('Template must be { lines, sections }');
    }
    if (!tpl.sections[section]) {
        throw new Error(`Template has no section "${section}"`);
    }
    const sorted = new Map(sortLinesByFirstAlpha(Object.entries(tpl.lines)));
    return tpl.sections[section].map((key) => {
        if (!sorted.has(key)) {
            throw new Error(`Template missing line: ${key}`);
        }
        return substitute(sorted.get(key), vars);
    });
}

export { Template, substitute, resolveTemplate, sortLinesByFirstAlpha };
export default { Template, substitute, resolveTemplate, sortLinesByFirstAlpha };
