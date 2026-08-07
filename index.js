#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { rarebert } from './lib/projects.mjs';
import { ExitSignal } from './lib/core.mjs';
import { list } from './lib/list.mjs';
import { memo } from './lib/memo.mjs';
import { backend } from './lib/backend.mjs';
import { cli } from './lib/cli.mjs';

cli.installSignalHandlers();

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
    // Also skip onboarding when the command is a path/alias for one of
    // the skip-listed modules (e.g. "scripts/backend.mjs" -> "backend").
    try {
        const normalized = rarebert.normalizeModuleName(path.basename(cmd, path.extname(cmd)));
        if (SKIP_ONBOARD.has(normalized)) return;
    } catch {
        /* not a valid module name; fall through to onboarding */
    }
    await backend.ensureConfig();
}

async function runModule(ref, args = []) {
    const scripts = rarebert.discover();

    // Resolve `ref` either by relative path (e.g. "scripts/name.mjs")
    // or by normalized module name (e.g. "name"). A leading "./" or a
    // path separator marks a path lookup; otherwise fall back to name.
    const isPathRef =
        ref.includes('/') || ref.includes(path.sep) || ref.startsWith('./');

    let script;
    if (isPathRef) {
        const rel = rarebert.relPath(path.resolve(rarebert.root, ref));
        script = scripts.find((s) => s.path === rel || s.path === ref);
        if (!script && fs.existsSync(path.resolve(rarebert.root, ref))) {
            script = { name: path.basename(ref, path.extname(ref)), path: rel };
        }
    } else {
        const name = rarebert.normalizeModuleName(ref);
        script = scripts.find((s) => rarebert.normalizeModuleName(s.name) === name);
    }

    if (!script) {
        console.error('Module not found:', ref);
        process.exit(1);
    }

    memo.loadForRun(script.path, script.name);

    try {
        const mod = await import('file://' + rarebert.absPath(script.path));
        const main = mod.default?.main ?? mod.main;
        if (typeof main === 'function') {
            const result = await main(args);
            if (result instanceof ExitSignal) process.exit(result.code);
        }
    } catch (err) {
        console.error(err.message || err);
        process.exit(1);
    }
}

async function helpVerbose() {
    const scripts = rarebert.discover();

    for (const script of scripts) {
        if (script !== scripts[0]) console.log();
        try {
            const mod = await import('file://' + rarebert.absPath(script.path));
            const main = mod.default?.main ?? mod.main;
            if (typeof main === 'function') {
                await main(['--help']);
            } else {
                const meta = mod.default || {};
                console.log('  ' + (meta.description || '(no description)'));
            }
        } catch (err) {
            console.error('  (failed:', err.message, ')');
        }
    }
}

const HELP_COMMANDS = new Set(['--help', '-h', 'help']);

async function main(argv) {
    const cmd = argv[2];
    const rest = argv.slice(3);

    if (!cmd || HELP_COMMANDS.has(cmd)) {
        return list.listModules([cmd, ...rest].filter(Boolean));
    }

    await maybeOnboard(cmd);

    await runModule(cmd, rest);
}

main(process.argv);
