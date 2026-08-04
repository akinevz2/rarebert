#!/usr/bin/env node

import { assertProjectRoot, normalizeModuleName, discover } from './lib/core.mjs';
import { listModules } from './lib/list.mjs';
import { loadForRun } from './lib/memo.mjs';
import { ensureConfig } from './lib/backend.mjs';
import { installSignalHandlers } from './lib/cli.mjs';

assertProjectRoot();
installSignalHandlers();

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
    await ensureConfig();
}

async function runModule(name, args = []) {
    const scripts = discover();
    const script = scripts.find((s) => normalizeModuleName(s.name) === name);
    if (!script) {
        console.error('Module not found:', name);
        process.exit(1);
    }

    loadForRun(script.path, script.name);

    try {
        const mod = await import('file://' + script.path);
        const main = mod.default?.main ?? mod.main;
        if (typeof main === 'function') await main(args);
    } catch (err) {
        console.error(err.message || err);
        process.exit(1);
    }
}

async function helpVerbose() {
    const scripts = discover();

    for (const script of scripts) {
        if (script !== scripts[0]) console.log();
        try {
            const mod = await import('file://' + script.path);
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

const HELP_PREFIXES = ['help', 'h', '--lib', '--scripts', '--script', '--src'];

async function main(argv) {
    const cmd = argv[2];
    const rest = argv.slice(3);

    if (cmd === '-v' || cmd === '--verbose') return helpVerbose();
    if (!cmd || HELP_PREFIXES.some((p) => cmd.startsWith(p))) {
        return listModules([cmd, ...rest].filter(Boolean));
    }

    await maybeOnboard(cmd);

    await runModule(normalizeModuleName(cmd), rest);
}

main(process.argv);
