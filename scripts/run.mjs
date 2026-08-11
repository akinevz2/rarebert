#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules, Module } from '../lib/modules.mjs';

const meta = {
    name: 'run',
    description: 'Run a module (defaults to src/main.py); forwards extra args',
    usage: 'node index.js run <module> [args...]',
    options: []
};

const SRC_DIR = path.join(rarebert.root, 'src');
const DEFAULT_MODULE = path.join(SRC_DIR, 'main.py');

function rel(p) {
    return path.relative(rarebert.root, p);
}

function runProcess(cmd, args) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
        stdio: 'inherit',
        cwd: rarebert.root
    });
    child.on('error', (err) => {
        console.error(`Failed to launch ${cmd}: ${err.message}`);
        process.exit(1);
    });
    child.on('exit', (code) => process.exit(code ?? 0));
}

function findJsModule(name) {
    const normalized = rarebert.normalizeModuleName(name);
    return listAllModules().find(
        (s) =>
            (s.ext === '.mjs' || s.ext === '.js') &&
            rarebert.normalizeModuleName(s.name) === normalized
    );
}

function findPyModule(name) {
    const candidates = [
        path.join(SRC_DIR, name.endsWith('.py') ? name : `${name}.py`),
        path.isAbsolute(name) ? name : null
    ].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p));
}

async function main(opts, positional) {
    const moduleArg = positional[0];
    const rest = positional.slice(1);

    if (!moduleArg) {
        if (!fs.existsSync(DEFAULT_MODULE)) {
            console.error(`Default module not found: ${rel(DEFAULT_MODULE)}`);
            return exit(1);
        }
        runProcess('python3', [DEFAULT_MODULE, ...rest]);
        return;
    }

    const ext = path.extname(moduleArg).toLowerCase();

    if (ext === '.py') {
        const pyPath = findPyModule(moduleArg);
        if (!pyPath) {
            console.error(`Python module not found: ${moduleArg}`);
            return exit(1);
        }
        runProcess('python3', [pyPath, ...rest]);
        return;
    }

    if (ext === '.js' || ext === '.mjs') {
        const jsMod = findJsModule(moduleArg);
        if (!jsMod) {
            console.error(`Module not found: ${moduleArg}`);
            return exit(1);
        }
        runProcess(process.execPath, [jsMod.path, ...rest]);
        return;
    }

    const jsMod = findJsModule(moduleArg);
    if (jsMod) {
        runProcess(process.execPath, [jsMod.path, ...rest]);
        return;
    }

    const pyPath = findPyModule(moduleArg);
    if (pyPath) {
        runProcess('python3', [pyPath, ...rest]);
        return;
    }

    console.error(`Module not found: ${moduleArg}`);
    return exit(1);
}

export { main };

const module = new Module('run.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
