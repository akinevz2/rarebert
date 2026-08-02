#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { PROJECT_ROOT } from '../lib/core.mjs';

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
    const entries = listDir(dir).filter(p => {
        if (base === '') return true;
        return path.basename(p).toLowerCase().startsWith(base.toLowerCase());
    });
    return entries.map(p => ({ name: p, message: p }));
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
        const answer = await prompt.run();
        return path.resolve(answer);
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

function copyDir(src, dest) {
    if (!fs.existsSync(src)) return false;
    fs.cpSync(src, dest, { recursive: true });
    return true;
}

function copyFile(src, dest) {
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, dest);
    return true;
}

function editFile(filePath) {
    const editor = process.env.EDITOR || 'nano';
    const editorFlags = process.env.EDITOR_FLAGS ? process.env.EDITOR_FLAGS.split(/\s+/).filter(Boolean) : [];
    const result = spawnSync(editor, [...editorFlags, filePath], { stdio: 'inherit' });
    return result.status ?? 0;
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

    const destScripts = path.join(dest, 'scripts');
    if (!fs.existsSync(destScripts)) {
        if (copyDir(SCRIPTS_DIR, destScripts)) {
            console.error(`copy scripts/ -> ${path.relative(dest, destScripts) || 'scripts/'}`);
        } else {
            console.error('skip scripts/ (source missing)');
        }
    } else {
        console.error(`skip scripts/ (already exists at destination)`);
    }

    const destLib = path.join(dest, 'lib');
    if (!fs.existsSync(destLib)) {
        if (copyDir(LIB_DIR, destLib)) {
            console.error(`copy lib/ -> ${path.relative(dest, destLib) || 'lib/'}`);
        } else {
            console.error('skip lib/ (source missing)');
        }
    } else {
        console.error(`skip lib/ (already exists at destination)`);
    }

    const destMakefile = path.join(dest, 'Makefile');
    if (!fs.existsSync(destMakefile)) {
        if (copyFile(MAKEFILE_SRC, destMakefile)) {
            console.error(`copy Makefile -> ${destMakefile}`);
        } else {
            console.error('skip Makefile (source missing)');
        }
    } else if (fs.existsSync(MAKEFILE_SRC)) {
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

    if (fs.existsSync(OPENCODE_SRC)) {
        const destConfig = path.join(dest, 'opencode.json');
        copyFile(OPENCODE_SRC, destConfig);
        console.error(`copy opencode.json -> ${destConfig}`);
    } else {
        console.error('skip opencode.json (source missing)');
    }

    console.error('\n✓ jump complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export {
    promptDestination,
    suggestPath,
    copyDir,
    copyFile,
    editFile,
    main
};

export default {
    name: 'jump',
    description: 'Copy this rarebert scaffolding to another project',
    main
};