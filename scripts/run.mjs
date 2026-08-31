#!/usr/bin/env node

// Process-spawning helpers merged from lib/run.mjs (this script was its only consumer).
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { exit } from '../lib/core.mjs';
import { CLI, listAllModules } from '../lib/module.mjs';
import { rarebert } from '../lib/projects.mjs';

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
        return exit(`Failed to launch ${cmd}: ${err.message}`);
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

const meta = {
    name: 'run',
    description: 'Run a module (defaults to src/main.py); forwards extra args',
    usage: 'node index.js run <module> [args...]',
    options: []
};

export { meta };

export default new CLI(
    'run.mjs',
    async (opts, positional) => {
        const moduleArg = positional[0];
        const rest = positional.slice(1);

        if (!moduleArg) {
            const defaultMod = DEFAULT_MODULE;
            if (!fs.existsSync(defaultMod)) {
                console.error(`Default module not found: ${rel(defaultMod)}`);
                return exit(1);
            }
            return await runProcess('node', [defaultMod, ...rest]);
        }

        const ext = path.extname(moduleArg).toLowerCase();

        if (ext === '.py') {
            const pyPath = findPyModule(moduleArg);
            if (!pyPath) {
                console.error(`Python module not found: ${moduleArg}`);
                return exit(1);
            }
            return await runProcess('python3', [pyPath, ...rest]);
        }

        if (ext === '.js' || ext === '.mjs') {
            const jsMod = findJsModule(moduleArg);
            if (!jsMod) {
                console.error(`Module not found: ${moduleArg}`);
                return exit(1);
            }
            return await runProcess(process.execPath, [jsMod.path, ...rest]);
        }

        const jsMod = findJsModule(moduleArg);
        if (jsMod) {
            return await runProcess(process.execPath, [jsMod.path, ...rest]);
        }

        const pyPath = findPyModule(moduleArg);
        if (pyPath) {
            return await runProcess('python3', [pyPath, ...rest]);
        }

        console.error(`Module not found: ${moduleArg}`);
        return exit(1);
    },
    meta
).supportsDirectRunning(import.meta.url);
