#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { exit } from '../lib/core.mjs';
import { CLI } from '../lib/module.mjs';
import { DEFAULT_MODULE, rel, runProcess, findJsModule, findPyModule } from '../lib/run.mjs';

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
            if (!fs.existsSync(DEFAULT_MODULE)) {
                console.error(`Default module not found: ${rel(DEFAULT_MODULE)}`);
                return exit(1);
            }
            runProcess('node', [DEFAULT_MODULE, ...rest]);
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
    },
    meta
).supportsDirectRunning(import.meta.url);
