#!/usr/bin/env node

import { project, normalizeModuleName, ExitSignal, assertProjectRoot } from './lib/core.mjs';
import { list } from './lib/list.mjs';
import { memo } from './lib/memo.mjs';
import { backend } from './lib/backend.mjs';
import { cli } from './lib/cli.mjs';

assertProjectRoot();
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
    await backend.ensureConfig();
}

async function runModule(name, args = []) {
    const scripts = project.discover();
    const script = scripts.find((s) => normalizeModuleName(s.name) === name);
    if (!script) {
        console.error('Module not found:', name);
        process.exit(1);
    }

    memo.loadForRun(script.path, script.name);

    try {
        const mod = await import('file://' + project.absPath(script.path));
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
    const scripts = project.discover();

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
        return list.listModules([cmd, ...rest].filter(Boolean));
    }

    await maybeOnboard(cmd);

    await runModule(normalizeModuleName(cmd), rest);
}

main(process.argv);
