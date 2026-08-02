#!/usr/bin/env node

import path from 'path';
import { spawnSync } from 'child_process';
import { PROJECT_ROOT } from '../lib/core.mjs';
import { listAllModules } from '../lib/modules.mjs';
import * as memo from '../lib/memo.mjs';

function runNodeCheck(filePath) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    const firstLine = output.split(/\r?\n/)[0] ?? '';
    return { ok: result.status === 0, firstLine };
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('check: Run `node --check` on every library and script, memoizing the first line of output');
        console.error('  Usage: node index.js check');
        console.error('  Discovers all .js/.mjs files in lib/ and scripts/, runs `node --check` on each,');
        console.error('  and records a memo (name -> first output line) via lib/memo.mjs.');
        console.error('  Exits non-zero if any file fails the syntax check.');
        return;
    }

    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found in lib/ or scripts/.');
        process.exit(1);
    }

    let failures = 0;
    for (const mod of modules) {
        const rel = path.relative(PROJECT_ROOT, mod.path);
        const { ok, firstLine } = runNodeCheck(mod.path);
        memo.remember(mod.name, firstLine);
        if (ok) {
            console.error(`ok   ${rel}`);
        } else {
            failures++;
            console.error(`FAIL ${rel}`);
            console.error(`     ${firstLine}`);
        }
    }

    console.error(`\nchecked ${modules.length} module${modules.length === 1 ? '' : 's'}, ${failures} failure${failures === 1 ? '' : 's'}`);
    process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { runNodeCheck, main };

export default {
    name: 'check',
    description: 'Run `node --check` on every library and script, memoizing the first output line',
    main
};