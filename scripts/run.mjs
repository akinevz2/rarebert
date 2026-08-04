#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
    PROJECT_ROOT,
    SCRIPTS_DIR,
    LIB_DIR,
    normalizeModuleName,
    discoverScripts
} from '../lib/core.mjs';

const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const DEFAULT_MODULE = path.join(SRC_DIR, 'main.py');

function rel(p) {
    return path.relative(PROJECT_ROOT, p);
}

function runProcess(cmd, args) {
    console.error(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
        stdio: 'inherit',
        cwd: PROJECT_ROOT
    });
    child.on('error', (err) => {
        console.error(`Failed to launch ${cmd}: ${err.message}`);
        process.exit(1);
    });
    child.on('exit', (code) => process.exit(code ?? 0));
}

function findJsModule(name) {
    const normalized = normalizeModuleName(name);
    const all = [...discoverScripts(SCRIPTS_DIR), ...discoverScripts(LIB_DIR)];
    return all.find((s) => normalizeModuleName(s.name) === normalized);
}

function findPyModule(name) {
    const candidates = [
        path.join(SRC_DIR, name.endsWith('.py') ? name : `${name}.py`),
        path.isAbsolute(name) ? name : null
    ].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p));
}

async function main(args = []) {
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];
    const rest = nonFlag.slice(1);

    if (!moduleArg) {
        if (!fs.existsSync(DEFAULT_MODULE)) {
            console.error(`Default module not found: ${rel(DEFAULT_MODULE)}`);
            process.exit(1);
        }
        runProcess('python3', [DEFAULT_MODULE, ...rest]);
        return;
    }

    const ext = path.extname(moduleArg).toLowerCase();

    if (ext === '.py') {
        const pyPath = findPyModule(moduleArg);
        if (!pyPath) {
            console.error(`Python module not found: ${moduleArg}`);
            process.exit(1);
        }
        runProcess('python3', [pyPath, ...rest]);
        return;
    }

    if (ext === '.js' || ext === '.mjs') {
        const jsMod = findJsModule(moduleArg);
        if (!jsMod) {
            console.error(`Module not found: ${moduleArg}`);
            process.exit(1);
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
    process.exit(1);
}

export { main };

export default {
    name: 'run',
    description: 'Run a module (defaults to src/main.py); forwards extra args',
    main
};
