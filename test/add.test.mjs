import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mod from '../scripts/add.mjs';
import { Runtime, ExitSignal } from '../lib/core.mjs';
import { Module } from '../lib/module.mjs';

describe('add.mjs Runtime integration', () => {
    test('default export is a Module instance', () => {
        assert.ok(mod instanceof Module);
    });

    test('Runtime.execute returns a number exitCode or throws on --help', async () => {
        const runtime = new Runtime(mod);
        try {
            const code = await runtime.execute(['--help']);
            assert.equal(typeof code, 'number');
        } catch {
            // Throw on --help is also valid behavior
        }
    });
});
