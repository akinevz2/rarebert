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
    if (result.status === 0) return { ok: true, locations: [] };

    const locations = [];
    const lines = output.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/:(\d+)$/);
        if (!m) continue;
        const lineNo = m[1];
        const msgMatch = output.match(/SyntaxError:\s+(.+)/);
        const msg = msgMatch ? msgMatch[1].trim() : lines[i + 1] ?? '';
        locations.push({ line: lineNo, message: msg });
        break;
    }
    if (locations.length === 0) {
        locations.push({ line: '?', message: output.split(/\r?\n/)[0] ?? 'unknown error' });
    }
    return { ok: false, locations };
}

async function main(args = []) {
    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found in lib/ or scripts/.');
        process.exit(1);
    }

    let failures = 0;
    for (const mod of modules) {
        const rel = path.relative(PROJECT_ROOT, mod.path);
        const { ok, locations } = runNodeCheck(mod.path);

        if (ok) {
            console.error(`ok   ${rel}`);
        } else {
            failures++;
            console.error(`FAIL ${rel}`);
            for (const loc of locations) {
                const content = `line ${loc.line}: ${loc.message}`;
                memo.remember(mod.name, content);
                console.error(`     ${content}`);
            }
        }

        const prior = memo.loadMemos(mod.name);
        for (const content of prior) {
            console.error(`     memo ${mod.name}: ${content}`);
        }
    }

    console.error(`\nchecked ${modules.length} module${modules.length === 1 ? '' : 's'}, ${failures} failure${failures === 1 ? '' : 's'}`);
    process.exit(failures === 0 ? 0 : 1);
}

export { runNodeCheck, main };

export default {
    name: 'check',
    description: 'Run `node --check` on every library and script; memo only on failure',
    main
};