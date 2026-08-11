#!/usr/bin/env node

import path from 'path';
import { rarebert, home } from './lib/projects.mjs';
import { list } from './lib/list.mjs';
import { memo } from './lib/memo.mjs';
import { backend } from './lib/backend.mjs';
import { cli } from './lib/cli.mjs';
import { Module } from './lib/modules.mjs';

const SKIP_ONBOARD = new Set([
    'backend',
    'onboard',
    'reload',
    'help',
    'h',
    '--help',
    '-h',
    'list',
    '--lib',
    '--src',
    '--scripts',
    '--script'
]);

async function maybeOnboard(cmd) {
    if (cmd && SKIP_ONBOARD.has(cmd)) return;
    try {
        const normalized = rarebert.normalizeModuleName(path.basename(cmd, path.extname(cmd)));
        if (SKIP_ONBOARD.has(normalized)) return;
    } catch {
        /* not a valid module name; fall through to onboarding */
    }
    await backend.ensureConfig();
}

/**
 * Resolve a scripts/ module by name or path, import it, and run it.
 *
 * This is the sole purpose of this dispatcher — it's an optional entry
 * point.  Each scripts/*.mjs module is directly runnable via
 * `node scripts/<name>.mjs` because it exports a Module instance with
 * a .run(args) method.
 */
async function runModule(ref, args = []) {
    const scripts = home.discoverModules();

    const isPathRef = ref.includes('/') || ref.includes(path.sep) || ref.startsWith('./');

    let script;
    if (isPathRef) {
        const rel = home.relPath(path.resolve(home.root, ref));
        script = scripts.find((s) => s.path === rel || s.path === ref);
        if (!script && path.resolve(home.root, ref)) {
            script = { name: path.basename(ref, path.extname(ref)), path: rel };
        }
    } else {
        const name = home.normalizeModuleName(ref);
        script = scripts.find((s) => home.normalizeModuleName(s.name) === name);
    }

    if (!script) {
        console.error('Module not found:', ref);
        process.exit(1);
    }

    memo.loadForRun(script.path, script.name);

    try {
        const mod = await import('file://' + home.absPath(script.path));

        if (mod.default && typeof mod.default.run === 'function') {
            await mod.default.run(args);
            return;
        }

        const main = mod.default?.main ?? mod.main;
        if (typeof main === 'function') {
            await main(args);
        }
    } catch (err) {
        console.error(err.message || err);
        process.exit(1);
    }
}

const HELP_COMMANDS = new Set(['--help', '-h', 'help']);

async function main(opts, positional) {
    const cmd = positional[0];
    const rest = positional.slice(1);

    if (!cmd || HELP_COMMANDS.has(cmd)) {
        return list.listModules([cmd, ...rest].filter(Boolean));
    }

    await maybeOnboard(cmd);

    await runModule(cmd, rest);
}

const meta = {
    name: 'rarebert',
    description: 'Rarebert dispatcher: resolve a module by name/path and run it',
    usage: 'node index.js [module] [args...]',
    skipHelpIntercept: true,
    allowUnknownOption: true,
    options: []
};

const module = new Module('index.js', main, meta);

cli.installSignalHandlers();

module.supportsDirectRunning(import.meta.url);

export { main };
export default module;