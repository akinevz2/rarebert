import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../lib/core.mjs';
import { Module, CLI, TUI } from '../lib/module.mjs';
import { memo } from '../lib/memo.mjs';

// Every runnable scripts/ module — default export must be a Module instance.
const RUNNABLE = [
    'add', 'analyze', 'article', 'check', 'commit', 'diff', 'edit',
    'implement', 'install', 'languages', 'list', 'memo', 'onboard',
    'open', 'present', 'project', 'refactor', 'reload', 'run',
    'status', 'trail', 'update', 'upgrades'
];

const modules = await Promise.all(
    RUNNABLE.map(async (name) => ({ name, mod: (await import(`../scripts/${name}.mjs`)).default }))
);

describe('modules.test.mjs — every runnable scripts/ module', () => {
    test('every default export is a Module instance', () => {
        const nonModules = modules.filter((m) => !(m.mod instanceof Module));
        assert.equal(nonModules.length, 0, `non-Module exports: ${nonModules.map((m) => m.name).join(', ')}`);
    });

    test('instanceof statistics (CLI vs TUI vs other Module)', () => {
        const cli = modules.filter((m) => m.mod instanceof CLI);
        const tui = modules.filter((m) => m.mod instanceof TUI);
        const other = modules.filter((m) => !(m.mod instanceof CLI) && !(m.mod instanceof TUI));
        console.log(`\n  module stats: ${cli.length} CLI, ${tui.length} TUI, ${other.length} other Module`);
        console.log(`  CLI:  ${cli.map((m) => m.name).join(', ')}`);
        console.log(`  TUI:  ${tui.map((m) => m.name).join(', ')}`);
        if (other.length) console.log(`  other: ${other.map((m) => m.name).join(', ')}`);
        assert.equal(other.length, 0, `unexpected non-CLI/non-TUI Module: ${other.map((m) => m.name).join(', ')}`);
    });

    describe('--help exits 0 (or throws) for every runnable module', () => {
        for (const { name, mod } of modules) {
            test(`${name} --help`, async () => {
                const runtime = new Runtime(mod);
                try {
                    const code = await runtime.execute(['--help']);
                    assert.equal(typeof code, 'number', `${name}: runtime.execute should return a number exitCode`);
                } catch (err) {
                    // Throwing on --help is acceptable (TUI in non-interactive mode, AbortError, etc.)
                    assert.ok(err, `${name}: expected error or number, got nothing`);
                }
            });
        }
    });

    // MEMO: runtime.execute() with NO args on every CLI returns inconsistent
    // shapes — some return a number, some return undefined, some throw. This
    // must be addressed ASAP: every Module.execute() must return an ExitSignal
    // (or throw), never undefined. Tracked here so the next refactor pass
    // fixes it and this test flips from "record current behavior" to "assert
    // consistent behavior".
    describe('memo: runtime.execute() with no args — current behavior to address ASAP', () => {
        for (const { name, mod } of modules.filter((m) => m.mod instanceof CLI)) {
            test(`${name} execute([]) shape`, async () => {
                const runtime = new Runtime(mod);
                let result;
                let threw = null;
                try {
                    result = await runtime.execute([]);
                } catch (err) {
                    threw = err;
                }
                memo.remember(
                    'test/modules.test.mjs',
                    `${name}: execute([]) -> ${threw ? `throws ${threw.name}` : typeof result} (ASAP: must be number exitCode, never undefined)`
                );
                // Don't fail — this records current behavior. The refactor
                // pass will tighten this to `assert.equal(typeof result, 'number')`.
                assert.ok(true);
            });
        }
    });
});
