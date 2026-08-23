import fs from 'fs';
import path from 'path';
import { home } from './projects.mjs';

const HEADER = '# Auto-generated Makefile: a pure index of `node index.js <name>` targets';
const EXTRA_TARGETS = {
    deps: 'npm install',
    server: 'npx tsx index.js server'
};

function buildPreamble(targetNames) {
    return (
        [
            HEADER,
            '',
            '.DEFAULT_GOAL := list',
            '',
            `.PHONY: ${targetNames.join(' ')}`,
            '',
        ].join('\n') + '\n'
    );
}

function buildBody(names) {
    const blocks = [];
    for (const name of names) {
        if (!(name in EXTRA_TARGETS))
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