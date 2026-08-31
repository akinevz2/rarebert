import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, ExitSignal, EXIT_FAIL } from '../lib/core.mjs';
import { runInteractively, cli, TUI, Interface } from '../lib/module.mjs';
import * as moduleNS from '../lib/module.mjs';

// Regression tests for the runInteractively gate: closure-producing,
// callback-capturing, bailing with a result through the exit() machinery
// when a non-interactive environment is detected.

const interactiveCtx = {
    isInteractive: () => true,
    nonInteractive: (m) => exit('non-interactive: ' + m)
};
const nonInteractiveCtx = {
    isInteractive: () => false,
    nonInteractive: (m) => exit('non-interactive: ' + m)
};

describe('module export spec', () => {
    test('lib/module.mjs exports class definitions only — no lowercase tui object', () => {
        assert.ok(!('tui' in moduleNS), 'module.mjs must not export a tui binding');
    });

    test('TUI member prompt methods exist (confirm/input/select/runInteractively)', () => {
        for (const method of [
            'confirm',
            'input',
            'select',
            'runInteractively',
            'isInteractive',
            'nonInteractive'
        ]) {
            assert.equal(
                typeof TUI.prototype[method],
                'function',
                `TUI.${method} should be a member method`
            );
        }
    });

    test('lib/tui.mjs is gone — the shared singleton was replaced by Interface factories', () => {
        assert.equal(
            fs.existsSync(
                path.join(fileURLToPath(new URL('../', import.meta.url)), 'lib', 'tui.mjs')
            ),
            false
        );
    });
});

describe('runInteractively', () => {
    test('is closure-producing — returns a callable wrapper capturing fn', () => {
        const run = runInteractively(interactiveCtx, async () => 'x');
        assert.equal(typeof run, 'function');
    });

    test('rejects a non-function fn', () => {
        assert.throws(() => runInteractively(interactiveCtx, null), TypeError);
    });

    test('interactive ctx — fn runs and its result passes through', async () => {
        const run = runInteractively(interactiveCtx, async (x) => 'ran:' + x);
        assert.equal(await run('a'), 'ran:a');
    });

    test('interactive ctx — args are forwarded to fn', async () => {
        const run = runInteractively(interactiveCtx, async (a, b) => a + b);
        assert.equal(await run(1, 2), 3);
    });

    test('non-interactive ctx — fn is never invoked, bails with an ExitSignal', async () => {
        let called = false;
        const run = runInteractively(nonInteractiveCtx, async () => {
            called = true;
            return 'should not run';
        });
        const result = await run();
        assert.equal(called, false);
        assert.ok(result instanceof ExitSignal);
        assert.equal(result.code, EXIT_FAIL);
    });

    test('non-interactive ctx — fallback value is returned instead', async () => {
        const run = runInteractively(nonInteractiveCtx, async () => 'never', {
            fallback: async () => 'fallback'
        });
        assert.equal(await run(), 'fallback');
    });

    test('non-interactive ctx — fallback receives forwarded args', async () => {
        const run = runInteractively(nonInteractiveCtx, async () => 'never', {
            fallback: async (a, b) => a * b
        });
        assert.equal(await run(3, 4), 12);
    });

    // Interface prompt factories — the replacement for the former tui
    // singleton. In a non-interactive runtime the Interface constructor
    // guard bails, so construction itself yields the ExitSignal (the
    // lenient tui-object fallbacks are gone by design; explicit
    // cli.isInteractive() guards now own that decision at call sites).
    test(
        'Interface.confirm construction bails with a nonInteractive ExitSignal',
        { skip: cli.isInteractive() },
        async () => {
            const result = Interface.createInterface('test');
            assert.ok(result instanceof ExitSignal);
            assert.equal(result.code, EXIT_FAIL);
        }
    );
});
