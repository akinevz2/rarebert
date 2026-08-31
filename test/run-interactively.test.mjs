import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exit, ExitSignal, EXIT_FAIL } from '../lib/core.mjs';
import { runInteractively, cli, TUI } from '../lib/module.mjs';
import { tui } from '../lib/tui.mjs';
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

describe('tui instance spec', () => {
    test('lib/module.mjs exports class definitions only — no lowercase tui object', () => {
        assert.ok(!('tui' in moduleNS), 'module.mjs must not export a tui binding');
    });

    test('shared tui is a real TUI class instance carrying the member methods', () => {
        assert.ok(tui instanceof TUI);
        for (const method of ['confirm', 'input', 'select', 'runInteractively', 'isInteractive', 'nonInteractive']) {
            assert.equal(typeof tui[method], 'function', `tui.${method} should be a member method`);
        }
    });

    test('tui shares the cli abort registry', () => {
        assert.equal(tui.abortCallbacks, cli.abortCallbacks);
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

    // Real singleton paths — deterministic only when the test runner's
    // stdin is not a TTY (the default for `node --test`).
    test(
        'tui.confirm falls back to the initial value when non-interactive',
        { skip: cli.isInteractive() },
        async () => {
            assert.equal(await tui.confirm('proceed?', true), true);
            assert.equal(await tui.confirm('proceed?', false), false);
        }
    );

    test(
        'tui.input bails with a nonInteractive ExitSignal by default',
        { skip: cli.isInteractive() },
        async () => {
            const result = await tui.input('name?', { initial: 'def' });
            assert.ok(result instanceof ExitSignal);
            assert.equal(result.code, EXIT_FAIL);
        }
    );

    test(
        'tui.select bails with a nonInteractive ExitSignal by default',
        { skip: cli.isInteractive() },
        async () => {
            const result = await tui.select('pick?', ['a', 'b']);
            assert.ok(result instanceof ExitSignal);
        }
    );

    test(
        'tui.select returns the initial choice with nonInteractiveBehavior "default"',
        { skip: cli.isInteractive() },
        async () => {
            const result = await tui.select('pick?', ['a', 'b'], {
                nonInteractiveBehavior: 'default'
            });
            assert.equal(result, 'a');
        }
    );
});
