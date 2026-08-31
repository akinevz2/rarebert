import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Arguments } from '../lib/module.mjs';

// Regression tests for the Arguments contract: every main callback receives
// an assured Arguments instance — an Array subclass of the positional args
// with the parsed Commander opts merged, exposing Commander conveniences.

function fakeCommand(rawArgs) {
    return {
        rawArgs,
        opts: () => ({ debug: true, model: 'test-model' }),
        helpInformation: () => 'help-text'
    };
}

describe('Arguments (Commander-backed main-callback contract)', () => {
    test('is an Array subclass of the positional args', () => {
        const args = Arguments.from(fakeCommand(['--debug', 'file1']), ['file1', 'file2']);
        assert.ok(args instanceof Arguments);
        assert.ok(Array.isArray(args));
        assert.equal(args.length, 2);
        assert.equal(args[0], 'file1');
        assert.equal(args[1], 'file2');
    });

    test('legacy opts-style access works via the merged opts', () => {
        const args = Arguments.from(fakeCommand(['--debug']), ['file1']);
        assert.equal(args.debug, true);
        assert.equal(args.model, 'test-model');
        assert.deepEqual(args.opts, { debug: true, model: 'test-model' });
    });

    test('exposes the Commander command, has(flag), and help()', () => {
        const command = fakeCommand(['--debug', 'file1']);
        const args = Arguments.from(command, ['file1']);
        assert.equal(args.command, command);
        assert.equal(args.has('--debug'), true);
        assert.equal(args.has('--nope'), false);
        assert.equal(args.help(), 'help-text');
    });

    test('empty positional yields an empty Arguments with opts merged', () => {
        const args = Arguments.from(fakeCommand([]), []);
        assert.equal(args.length, 0);
        assert.equal(args.debug, true);
    });
});
