#!/usr/bin/env node

import path from 'path';
import {
    SCRIPTS_DIR,
    assertProjectRoot,
    normalizeModuleName,
    discoverScripts
} from './lib/core.mjs';
import { listModules } from './lib/list.mjs';

assertProjectRoot();

async function runModule(name, args = []) {
    const scripts = discoverScripts();
    const script = scripts.find(s => normalizeModuleName(s.name) === name);

    if (!script) {
        console.error('Module not found:', name);
        process.exit(1);
    }

    try {
        const mod = await import('file://' + script.path);
        const main = mod.default?.main ?? mod.main;
        if (typeof main === 'function') await main(args);
    } catch (err) { console.error(err.message || err); process.exit(1); }
}

async function helpVerbose() {
    const scripts = discoverScripts();
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

function refresh() {
    import(path.join(SCRIPTS_DIR, 'reload.mjs'))
        .then(m => (m.default?.main ?? m.main)?.())
        .catch(e => console.error('Reload failed:', e.message));
}

async function main(argv) {
    const cmd = argv[2];
    const rest = argv.slice(3);

    if (cmd === 'reload') return refresh();
    if (cmd === '-v' || cmd === '--verbose') return helpVerbose();
    if (!cmd || cmd.startsWith('help') || cmd.startsWith('h') || cmd.startsWith('--lib') || cmd.startsWith('--scripts') || cmd.startsWith('--script')) {
        return listModules([cmd, ...rest].filter(Boolean));
    }

    await runModule(normalizeModuleName(cmd), rest);
}

main(process.argv);