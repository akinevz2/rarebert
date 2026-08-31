import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exit, ExitSignal, EXIT_FAIL, EXIT_ABORT } from '../lib/core.mjs';
import { AbortError } from '../lib/module.mjs';

// Regression tests for the ExitSignal kind composition: every kind funnels
// through complete(), so a main callback can `return exit(<any kind>)` and
// Module.exit() handles continuation uniformly.

describe('ExitSignal kinds', () => {
    test('code kind — complete() yields the code and runs onExit', async () => {
        let saw;
        const sig = exit(7, { onExit: (c) => (saw = c) });
        assert.ok(sig instanceof ExitSignal);
        assert.equal(await sig.complete(), 7);
        assert.equal(saw, 7);
    });

    test('code kind — cleanup runs before onExit', async () => {
        const order = [];
        const sig = exit(0, {
            onExit: () => order.push('onExit'),
            cleanup: () => order.push('cleanup')
        });
        await sig.complete();
        assert.deepEqual(order, ['cleanup', 'onExit']);
    });

    test('error kind — isError(), defaults to EXIT_FAIL, message printed via onExit default', async () => {
        const sig = exit(new Error('boom'));
        assert.ok(sig.isError());
        assert.equal(sig.code, EXIT_FAIL);
        assert.equal(await sig.complete(), EXIT_FAIL);
    });

    test('error kind — custom onExit suppresses the default message print', async () => {
        let saw;
        const sig = exit(new Error('boom'), { onExit: (c) => (saw = c) });
        assert.equal(await sig.complete(), EXIT_FAIL);
        assert.equal(saw, EXIT_FAIL);
    });

    test('error kind — cleanup still runs', async () => {
        let cleaned = false;
        const sig = exit(new Error('boom'), { cleanup: () => (cleaned = true) });
        await sig.complete();
        assert.equal(cleaned, true);
    });

    test('AbortError maps to its own exitCode (130)', async () => {
        const sig = exit(new AbortError());
        assert.equal(sig.code, EXIT_ABORT);
        assert.equal(await sig.complete(), EXIT_ABORT);
    });

    test('promise kind — number result becomes the code', async () => {
        const sig = exit(Promise.resolve(7));
        assert.ok(sig.isPromise());
        assert.equal(await sig.complete(), 7);
    });

    test('promise kind — ExitSignal result recurses through complete()', async () => {
        const sig = exit(Promise.resolve(exit(3)));
        assert.equal(await sig.complete(), 3);
    });

    test('promise kind — rejection folds into the error kind', async () => {
        const sig = exit(Promise.reject(new Error('async boom')));
        assert.equal(await sig.complete(), EXIT_FAIL);
    });

    test('promise kind — onExit hook sees the resolved code', async () => {
        let saw;
        const sig = exit(Promise.resolve(5), { onExit: (c) => (saw = c) });
        assert.equal(await sig.complete(), 5);
        assert.equal(saw, 5);
    });

    test('submodule kind — plain function is invoked, numeric result becomes code', async () => {
        const sig = exit(() => 9);
        assert.ok(sig.isSubmodule());
        assert.equal(await sig.complete(), 9);
    });

    test('submodule kind — function rejection folds into the error kind', async () => {
        const sig = exit(() => {
            throw new Error('sub boom');
        });
        assert.equal(await sig.complete(), EXIT_FAIL);
    });

    test('string kind — exit(message) fails with EXIT_FAIL', async () => {
        const sig = exit('something failed');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.code, EXIT_FAIL);
        assert.equal(await sig.complete(), EXIT_FAIL);
    });

    test('undefined/null — exit() yields a zero-code signal', async () => {
        assert.equal(await exit().complete(), 0);
        assert.equal(await exit(null).complete(), 0);
    });

    test('exit(n, fn) — a bare function second argument is the on-exit callback', async () => {
        let ran = false;
        const sig = exit(0, () => (ran = true));
        assert.equal(sig.code, 0);
        assert.equal(await sig.complete(), 0);
        assert.equal(ran, true, 'happy-path callback runs during complete()');
    });

    test('exit(n, fn) — the callback also runs for non-zero codes', async () => {
        let ran = false;
        const sig = exit(3, () => (ran = true));
        assert.equal(await sig.complete(), 3);
        assert.equal(ran, true);
    });

    test('exit(n, runnable) fails fast — submodules are the first argument', () => {
        assert.throws(() => exit(0, { execute: async () => 1 }), TypeError);
        // The documented forms keep working:
        assert.doesNotThrow(() => exit(1, { onExit: () => {} }));
        assert.doesNotThrow(() => exit(() => 1));
    });
});
