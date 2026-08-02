#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, SCRIPTS_DIR, discoverScripts } from '../lib/core.mjs';
import { generateMakefile } from '../lib/makefile.mjs';

export async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('reload: Regenerate Makefile from discovered scripts in scripts/');
        console.log('  Usage: node index.js reload');
        return;
    }

    const scripts = discoverScripts();
    console.error(`discover scripts/ -> ${scripts.length} found: ${scripts.map(s => s.name).join(', ') || '(none)'}`);

    const makefilePath = path.join(PROJECT_ROOT, 'Makefile');
    const relPath = path.relative(PROJECT_ROOT, makefilePath);
    const content = generateMakefile(scripts);

    if (fs.existsSync(makefilePath)) {
        const existing = fs.readFileSync(makefilePath, 'utf-8');
        if (existing === content) {
            console.error(`up-to-date ${relPath} (no changes)`);
            console.error(`done: ${scripts.length} module(s), ${makefilePath}`);
            return;
        }
        fs.writeFileSync(makefilePath, content);
        console.error(`overwrite ${relPath} (${content.length} bytes)`);
    } else {
        fs.writeFileSync(makefilePath, content);
        console.error(`create ${relPath} (${content.length} bytes)`);
    }

    console.error(`done: ${scripts.length} module(s), ${makefilePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export default {
    name: 'reload',
    description: 'Regenerate Makefile from discovered scripts in scripts/',
    main
};