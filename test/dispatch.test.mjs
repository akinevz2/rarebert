import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end dispatcher regressions, spawned with stdin closed so every
// path runs non-interactively. These pin the observable behavior of the
// exit() machinery: exit codes and stderr messages.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX = path.join(ROOT, 'index.js');

function run(args, opts = {}) {
    return spawnSync(process.execPath, [INDEX, ...args], {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts
    });
}

describe('dispatcher regression (spawned, non-interactive)', () => {
    test('node index.js check — full suite passes, exit 0', () => {
        const r = run(['check']);
        assert.equal(r.status, 0, r.stderr || r.stdout);
        assert.match(r.stdout, /0 syntax failures/);
        assert.match(r.stdout, /0 integrity issues/);
    });

    test('node index.js list — exit 0', () => {
        const r = run(['list']);
        assert.equal(r.status, 0, r.stderr || r.stdout);
    });

    test('unknown module — Error kind routes through the machinery, exit 1', () => {
        const r = run(['nosuchmodule']);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Module not found: nosuchmodule/);
    });

    test('TUI module with closed stdin — bails via nonInteractive, exit 1', () => {
        const r = run(['edit']);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Non-interactive; tui: /);
        assert.match(r.stderr, /requires an interactive terminal/);
    });

    test('direct module run — scripts/fix.mjs scaffold exits 0', () => {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fix.mjs')], {
            cwd: ROOT,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        assert.equal(r.status, 0, r.stderr || r.stdout);
        assert.match(r.stdout, /fix module/);
    });
});
