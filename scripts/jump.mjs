#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { PROJECT_ROOT } from '../lib/core.mjs';
import { editFile } from '../lib/editor.mjs';

const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
const LIB_DIR = path.join(PROJECT_ROOT, 'lib');
const MAKEFILE_SRC = path.join(PROJECT_ROOT, 'Makefile');
const OPENCODE_SRC = path.join(PROJECT_ROOT, 'opencode.json');

function listDir(dir) {
    try {
        return fs.readdirSync(dir).map(name => path.join(dir, name));
    } catch {
        return [];
    }
}

function pathChoices(dir) {
    return listDir(dir).map(p => ({ name: p, message: p }));
}

function suggestPath(input) {
    const raw = (input || '').trim() || '.';
    const resolved = path.resolve(raw);
    let dir, base;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        dir = resolved;
        base = '';
    } else {
        dir = path.dirname(resolved);
        base = path.basename(resolved);
    }
    if (!fs.existsSync(dir)) return [];
    return listDir(dir)
        .filter(p => base === '' || path.basename(p).toLowerCase().startsWith(base.toLowerCase()))
        .map(p => ({ name: p, message: p }));
}

async function promptDestination() {
    if (process.stdin.isTTY !== true) {
        const arg = process.argv.slice(2).find(a => !a.startsWith('-') && a);
        if (!arg) {
            console.error('Non-interactive; pass a destination path as an argument.');
            process.exit(1);
        }
        return path.resolve(arg);
    }

    const prompt = new Enquirer.AutoComplete({
        name: 'destination',
        message: 'Enter the destination path:',
        initial: process.cwd(),
        choices: pathChoices(process.cwd()),
        suggest: suggestPath,
        format: () => prompt.input
    });

    try {
        return path.resolve(await prompt.run());
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

function copyEntry(src, dest, kind) {
    if (!fs.existsSync(src)) {
        console.error(`skip ${kind} (source missing)`);
        return;
    }
    if (fs.existsSync(dest)) {
        console.error(`skip ${kind} (already exists at destination)`);
        return;
    }
    if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
    } else {
        fs.copyFileSync(src, dest);
    }
    console.error(`copy ${kind} -> ${dest}`);
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('jump: Copy this rarebert scaffolding to another project');
        console.error('  Usage: node index.js jump [destination]');
        console.error('  Copies scripts/, lib/, Makefile, opencode.json to the destination.');
        console.error('  If a Makefile already exists there, the contents are concatenated');
        console.error('  and $EDITOR is opened on the result.');
        return;
    }

    const dest = await promptDestination();
    console.error(`Destination: ${dest}`);

    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
        console.error(`create ${dest}/`);
    }

    copyEntry(SCRIPTS_DIR, path.join(dest, 'scripts'), 'scripts/');
    copyEntry(LIB_DIR, path.join(dest, 'lib'), 'lib/');
    copyEntry(OPENCODE_SRC, path.join(dest, 'opencode.json'), 'opencode.json');

    const destMakefile = path.join(dest, 'Makefile');
    if (fs.existsSync(destMakefile)) {
        if (fs.existsSync(MAKEFILE_SRC)) {
            const existing = fs.readFileSync(destMakefile, 'utf-8');
            const incoming = fs.readFileSync(MAKEFILE_SRC, 'utf-8');
            const separator = existing.endsWith('\n') ? '' : '\n';
            fs.writeFileSync(destMakefile, existing + separator + '\n# --- appended by rarebert jump ---\n' + incoming);
            console.error(`concat Makefile -> ${destMakefile}`);
            console.error(`opening $EDITOR ${destMakefile}`);
            editFile(destMakefile);
        } else {
            console.error('skip Makefile (source missing)');
        }
    } else {
        copyEntry(MAKEFILE_SRC, destMakefile, 'Makefile');
    }

    console.error('\n✓ jump complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { promptDestination, suggestPath, main };

export default {
    name: 'jump',
    description: 'Copy this rarebert scaffolding to another project',
    main
};