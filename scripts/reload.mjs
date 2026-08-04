#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, discoverScripts } from '../lib/core.mjs';
import { clearLastModule } from '../lib/editor.mjs';
import { run } from '../lib/cli.mjs';

const HEADER = '# Auto-generated Makefile: a pure index of `node index.js <name>` targets';
const EXTRA_TARGETS = {
    install: 'npm install',
    deps: 'npm install'
};

const meta = {
    name: 'reload',
    description: 'Rebuild Makefile as a pure index of node index.js <name> targets',
    usage: 'node index.js reload [--forget]',
    options: [
        { flag: 'forget', label: '', description: 'also delete .last-module after refreshing' }
    ]
};

function buildPreamble(targetNames) {
    return (
        [
            HEADER,
            '',
            '.DEFAULT_GOAL := list',
            '',
            `.PHONY: list ${targetNames.join(' ')}`,
            '',
            'list:',
            '\tnode index.js'
        ].join('\n') + '\n'
    );
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

async function main(args = []) {
    if (args.includes('--forget')) {
        clearLastModule();
    }

    const scripts = discoverScripts();
    console.error(
        `discover scripts/ -> ${scripts.length} found: ${scripts.map((s) => s.name).join(', ') || '(none)'}`
    );

    const makefilePath = path.join(PROJECT_ROOT, 'Makefile');
    const rel = path.relative(PROJECT_ROOT, makefilePath);
    const names = scripts.map((s) => s.name);

    const phony = [...names, ...Object.keys(EXTRA_TARGETS).filter((n) => !names.includes(n))];
    const content = buildPreamble(phony) + buildBody(names);

    if (fs.existsSync(makefilePath) && fs.readFileSync(makefilePath, 'utf-8') === content) {
        console.error(`up-to-date ${rel} (no changes)`);
    } else {
        fs.writeFileSync(makefilePath, content);
        console.error(
            `refresh ${rel} (${scripts.length} script targets + ${Object.keys(EXTRA_TARGETS).length} extras)`
        );
    }
    console.error(`done: ${scripts.length} module(s), ${makefilePath}`);
}

export { main };

export default {
    name: 'reload',
    description: 'Rebuild Makefile as a pure index of node index.js <name> targets',
    main: run(meta, main)
};
