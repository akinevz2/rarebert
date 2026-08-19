import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mod from '../scripts/onboard.mjs';
import { Runtime, ExitSignal } from '../lib/core.mjs';
import { Module } from '../lib/module.mjs';

describe('onboard.mjs Runtime integration', () => {
    test('default export is a Module instance', () => {
        assert.ok(mod instanceof Module);
    });

    test('Runtime.execute returns a number exitCode', async () => {
        const runtime = new Runtime(mod);
        const code = await runtime.execute(['--help']);
        assert.equal(typeof code, 'number');
    });
});
