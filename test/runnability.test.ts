import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Module } from '../lib/module.ts';

// Runnability sweep: every module in scripts/ must (1) import cleanly and
// export a runnable Module instance — the dispatcher's contract — and
// (2) respond to `--help` with exit 0 through the composition root.
// Under the Bunli thin-router entry, per-command `--help` is intercepted
// by Bunli's help renderer (exit 0, lists the module's declared options);
// it exercises registration + help wiring without running the module's
// real behaviour, so the sweep is safe non-interactively.
// Direct execution (`bun scripts/<name>.ts`) is intentionally gone:
// supportsDirectRunning was deprecated with the Bunli migration, and
// `bun launch.ts <name>` supersedes it.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX = path.join(ROOT, 'launch.ts');
const SCRIPTS = path.join(ROOT, 'scripts');

const scriptFiles = fs
    .readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.ts'))
    .sort();

function spawnHelp(args: string[]) {
    return spawnSync(process.execPath, [INDEX, ...args], {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000
    });
}

describe('scripts/ runnability — import & Module contract', () => {
    for (const file of scriptFiles) {
        test(`${file} imports and exports a runnable Module`, async () => {
            const mod = await import(pathToFileURL(path.join(SCRIPTS, file)).href);
            const exported = mod.default;
            assert.ok(exported, `${file}: missing default export`);
            assert.ok(
                exported instanceof Module,
                `${file}: default export must be a Module instance, got ${exported?.constructor?.name ?? typeof exported}`
            );
            assert.equal(
                typeof exported.execute,
                'function',
                `${file}: Module must expose execute(args)`
            );
        });
    }
});

describe('scripts/ runnability — dispatcher --help (spawned, non-interactive)', () => {
    for (const file of scriptFiles) {
        const name = path.basename(file, '.ts');
        test(`bun launch.ts ${name} --help exits 0`, () => {
            const r = spawnSync(process.execPath, [INDEX, name, '--help'], {
                cwd: ROOT,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 30000
            });
            assert.equal(r.status, 0, `${name}: --help failed\n${r.stderr || r.stdout}`);
            assert.ok((r.stdout || '').trim().length > 0, `${name}: --help printed nothing`);
        });
    }
});

// Direct-execution sweep removed: supportsDirectRunning was deprecated
// with the Bunli migration (the import.meta.url-based guard is not
// portable), and `bun launch.ts <name>` supersedes `bun scripts/<name>.ts`.
// The dispatcher --help block above covers the registration + help surface.
