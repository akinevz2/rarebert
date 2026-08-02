#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, SCRIPTS_DIR, discoverScripts } from '../lib/core.mjs';

const HEADER = '# Auto-generated Makefile';

function buildPreamble(targetNames) {
    return [HEADER, '', `.PHONY: ${targetNames.join(' ')}`].join('\n') + '\n';
}

function parseTargets(makefileBody) {
    const targets = new Map();
    const lines = makefileBody.split('\n');
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(/^([A-Za-z_.-]+):\s*$/);
        if (m) {
            const name = m[1];
            const block = [lines[i]];
            i++;
            while (i < lines.length && /^\t/.test(lines[i])) {
                block.push(lines[i]);
                i++;
            }
            targets.set(name, block.join('\n'));
        } else {
            i++;
        }
    }
    return targets;
}

export async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('reload: Refresh the Makefile preamble (.PHONY list) from discovered scripts');
        console.log('  Usage: node index.js reload');
        console.log('  Only rewrites the header and .PHONY line; existing recipe targets are');
        console.log('  left untouched. New scripts get a simple `node index.js <name>` target appended.');
        return;
    }

    const scripts = discoverScripts();
    console.error(`discover scripts/ -> ${scripts.length} found: ${scripts.map(s => s.name).join(', ') || '(none)'}`);

    const makefilePath = path.join(PROJECT_ROOT, 'Makefile');
    const relPath = path.relative(PROJECT_ROOT, makefilePath);
    const names = scripts.map(s => s.name);
    const preamble = buildPreamble(names);

    if (!fs.existsSync(makefilePath)) {
        const body = names.map(n => `\n\n${n}:\n\tnode index.js ${n}`).join('');
        fs.writeFileSync(makefilePath, preamble + body + '\n');
        console.error(`create ${relPath} (${preamble.length + body.length} bytes)`);
        console.error(`done: ${scripts.length} module(s), ${makefilePath}`);
        return;
    }

    const existing = fs.readFileSync(makefilePath, 'utf-8');
    const bodyStart = existing.indexOf('.PHONY:');
    const body = bodyStart === -1 ? existing : existing.slice(existing.indexOf('\n', bodyStart) + 1);
    const targets = parseTargets(body);

    const known = new Set(names);
    const extraTargetNames = [...targets.keys()].filter(n => !known.has(n));

    let appended = 0;
    for (const name of names) {
        if (!targets.has(name)) {
            targets.set(name, `${name}:\n\tnode index.js ${name}`);
            appended++;
            console.error(`  + ${name}: (new target appended)`);
        }
    }

    const orderedNames = [...names, ...extraTargetNames];
    const targetBlocks = orderedNames.map(n => `\n\n${targets.get(n)}`).join('');
    const phonyNames = orderedNames;
    const content = buildPreamble(phonyNames) + targetBlocks + '\n';

    if (content === existing) {
        console.error(`up-to-date ${relPath} (no changes)`);
    } else {
        fs.writeFileSync(makefilePath, content);
        console.error(`refresh ${relPath} (preamble${appended ? `, +${appended} new target(s)` : ''})`);
    }
    console.error(`done: ${scripts.length} module(s), ${makefilePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export default {
    name: 'reload',
    description: 'Refresh Makefile preamble from discovered scripts; preserve recipe targets',
    main
};