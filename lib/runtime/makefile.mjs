import fs from 'fs';
import path from 'path';
import { home } from './projects.mjs';

// ---------------------------------------------------------------------------
// Makefile generation — the Makefile is a generated artifact, never a
// hand-edited one.
//
// Contract:
//   - `make reload` (scripts/reload.mjs) calls refreshMakefile(), which
//     regenerates the Makefile from the discovered scripts/ modules plus
//     the EXTRA_TARGETS template below.
//   - Do NOT write to the Makefile directly. Any hand-added target is
//     silently dropped on the next reload. To add or change a target,
//     edit EXTRA_TARGETS here (or scaffold a scripts/ module, which gets
//     a target automatically) and re-run `make reload`.
//   - The file is a pure index: one `node index.js <name>` target per
//     discovered module, plus the extra non-module targets.
// ---------------------------------------------------------------------------

const HEADER = '# Auto-generated Makefile: a pure index of `node index.js <name>` targets';
const EXTRA_TARGETS = {
    deps: 'npm install',
    test: 'node --test'
};

function buildPreamble(targetNames) {
    // `list` is hardcoded here as the default goal, but scripts/list.mjs
    // also generates a `list` target in the body — emit the hardcoded one
    // only when discovery didn't produce it, or make warns about the
    // duplicate recipe.
    const preamble = [
        HEADER,
        '',
        '.DEFAULT_GOAL := list',
        '',
        `.PHONY: list ${targetNames.join(' ')}`,
        ''
    ];
    if (!targetNames.includes('list')) {
        preamble.push('list:', '\tnode index.js', '');
    }
    return preamble.join('\n');
}

function buildBody(names) {
    const blocks = [];
    for (const name of names) {
        blocks.push(`${name}:\n\tnode index.js ${name}`);
    }
    for (const [name, recipe] of Object.entries(EXTRA_TARGETS)) {
        if (names.includes(name)) continue;
        blocks.push(`${name}:\n\t${recipe}`);
    }
    return blocks.map((b) => `\n\n${b}`).join('') + '\n';
}

/**
 * Generate the Makefile content from the discovered scripts/ modules.
 * Returns the full file content string.
 */
function generateMakefile() {
    const scripts = home.discoverModules();
    const names = scripts.map((s) => s.name);
    const phony = [...names, ...Object.keys(EXTRA_TARGETS).filter((n) => !names.includes(n))];
    return {
        content: buildPreamble(phony) + buildBody(names),
        scriptCount: scripts.length,
        extraCount: Object.keys(EXTRA_TARGETS).length,
        scripts
    };
}

/**
 * Write the Makefile if content has changed. Returns true if written.
 */
function refreshMakefile() {
    const makefilePath = path.join(home.root, 'Makefile');
    const { content, scriptCount, extraCount, scripts } = generateMakefile();
    const rel = path.relative(home.root, makefilePath);

    if (fs.existsSync(makefilePath) && fs.readFileSync(makefilePath, 'utf-8') === content) {
        return { written: false, rel, scriptCount, extraCount, scripts };
    }
    fs.writeFileSync(makefilePath, content);
    return { written: true, rel, scriptCount, extraCount, scripts };
}

export { generateMakefile, refreshMakefile, buildPreamble, buildBody, EXTRA_TARGETS };
export default { generateMakefile, refreshMakefile };
