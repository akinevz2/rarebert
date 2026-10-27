import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end dispatcher regressions, spawned with stdin closed so every
// path runs non-interactively. These pin the observable behavior of the
// exit() machinery: exit codes and stderr messages.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX = path.join(ROOT, 'launch.ts');

function run(args: string[], opts: Record<string, unknown> = {}) {
    return spawnSync(process.execPath, [INDEX, ...args], {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts
    });
}

describe('dispatcher regression (spawned, non-interactive)', () => {
    test('launch.ts check — full suite passes, exit 0', () => {
        const r = run(['check']);
        assert.equal(r.status, 0, r.stderr || r.stdout);
        assert.match(r.stdout, /0 syntax failures/);
        assert.match(r.stdout, /0 integrity issues/);
    });

    test('launch.ts list — exit 0', () => {
        const r = run(['list']);
        assert.equal(r.status, 0, r.stderr || r.stdout);
    });

    test('unknown command — Bunli routing error, exit 1', () => {
        const r = run(['nosuchmodule']);
        assert.equal(r.status, 1);
        // Bunli's CommandNotFoundError (with the available-commands list)
        // arrives as a JSON error object on stderr under non-TTY output.
        assert.match(r.stderr, /Command 'nosuchmodule' not found/);
    });

    test('TUI module with closed stdin — bails via nonInteractive, exit 1', () => {
        const r = run(['edit']);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Non-interactive; tui: /);
        assert.match(r.stderr, /requires an interactive terminal/);
    });

    test('dispatcher-invoked module — scripts/fix.ts scaffold exits 0', () => {
        // supportsDirectRunning is deprecated (no import.meta for the
        // direct-run guard); module runs go through the Bunli entry.
        const r = run(['fix']);
        assert.equal(r.status, 0, r.stderr || r.stdout);
        assert.match(r.stdout, /fix module/);
    });
});
