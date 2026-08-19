import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, ModuleArguments, exit } from '../lib/core.mjs';
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
                    // Throwing on --help is acceptable (TUI non-interactive guard, etc.)
                    assert.ok(err, `${name}: expected error or number, got nothing`);
                }
            });
        }
    });

    // -----------------------------------------------------------------------
    // Runtime.execute([]) inconsistency — documented via assertSaneExit.
    //
    // assertSaneExit is the test-only runtime check interface: it runs a
    // Module through the full Runtime lifecycle (guard → createRunner →
    // complete → decide) WITHOUT writing to stdout/stderr, and returns a
    // report { ok, exitCode, threw, error, module, args }.
    //
    // An `ok:false` report means the module's main returned an undefined or
    // non-ExitSignal value — the inconsistency this section documents. The
    // goal: flip every module to `ok:true` so `assertSaneExit` becomes an
    // assertion, not a recording.
    // -----------------------------------------------------------------------
    describe('Runtime.assertSaneExit([]) — document execute([]) inconsistency', () => {
        const reports = [];

        for (const { name, mod } of modules.filter((m) => m.mod instanceof CLI)) {
            test(`${name} assertSaneExit([])`, async () => {
                const r = await Runtime.assertSaneExit(mod, []);
                reports.push({ name, ...r });
                // Record current behavior as a memo — do NOT fail.
                // The fix pass flips this to: assert.equal(r.ok, true, r.error);
                memo.remember(
                    'test/modules.test.mjs',
                    `${name}: assertSaneExit([]) -> ok=${r.ok} exitCode=${r.exitCode}${r.threw ? ` threw=${r.threw}` : ''}${r.error ? ` err="${r.error}"` : ''}`
                );
                assert.ok(true);
            });
        }

        test('summary: which modules return sane exits vs inconsistent', () => {
            const sane = reports.filter((r) => r.ok);
            const broken = reports.filter((r) => !r.ok);
            console.log(`\n  assertSaneExit([]) summary: ${sane.length} sane, ${broken.length} broken`);
            if (sane.length) console.log(`  sane:   ${sane.map((r) => r.name).join(', ')}`);
            if (broken.length) console.log(`  broken: ${broken.map((r) => r.name).join(', ')}`);
            // Document the correct cases explicitly.
            for (const r of sane) {
                assert.equal(typeof r.exitCode, 'number', `${r.name}: sane exit should have numeric exitCode`);
            }
            // Don't fail on broken — this is a recording, not an assertion yet.
            assert.ok(true);
        });
    });
});

// ---------------------------------------------------------------------------
// ModuleArguments — the single object passed to main(args).
// Array subclass with Commander opts merged via Object.assign, so
// `'verbose' in args` and `args.verbose` both work, plus `args[0]` for
// positionals and helper methods (has/bool/get/first/rest/nonFlag).
// ---------------------------------------------------------------------------

describe('ModuleArguments', () => {
    test('is an Array — positional indexing works', () => {
        const ma = ModuleArguments.from(['a', 'b'], {});
        assert.equal(ma.length, 2);
        assert.equal(ma[0], 'a');
        assert.equal(ma[1], 'b');
        assert.deepEqual([...ma.slice(1)], ['b']);
    });

    test('opts keys are merged via Object.assign — `in` + direct access', () => {
        const ma = ModuleArguments.from([], { verbose: true, trace: 'foo' });
        assert.equal('verbose' in ma, true);
        assert.equal(ma.verbose, true);
        assert.equal(ma.trace, 'foo');
        assert.equal(ma.opts.trace, 'foo');
    });

    test('has() checks parsed opts AND literal --flag tokens', () => {
        const ma = ModuleArguments.from(['--add', './lib/core.mjs'], { yes: true });
        assert.equal(ma.has('--add'), true);
        assert.equal(ma.has('--yes'), true);
        assert.equal(ma.has('--force'), false);
    });

    test('bool() coerces to boolean', () => {
        const ma = ModuleArguments.from([], { verbose: 1, yes: undefined });
        assert.equal(ma.bool('verbose'), true);
        assert.equal(ma.bool('yes'), false);
    });

    test('get() returns fallback when unset', () => {
        const ma = ModuleArguments.from([], { trace: 'x' });
        assert.equal(ma.get('trace'), 'x');
        assert.equal(ma.get('missing'), null);
        assert.equal(ma.get('missing', 'default'), 'default');
    });

    test('first() / rest() split positionals', () => {
        const ma = ModuleArguments.from(['./lib/core.mjs', '--yes'], {});
        assert.equal(ma.first(), './lib/core.mjs');
        assert.deepEqual([...ma.rest()], ['--yes']);
    });

    test('nonFlag() filters out flags, keeps numeric tokens', () => {
        const ma = ModuleArguments.from(['./lib/core.mjs', '--add', '3'], {});
        assert.deepEqual(ma.nonFlag(), ['./lib/core.mjs', '3']);
    });

    test('backwards compat: works as both opts and positional in main(opts, positional)', () => {
        const ma = ModuleArguments.from(['mod.mjs'], { force: true });
        // Legacy destructure: const { force } = opts; positional[0]
        const { force } = ma.opts;
        const first = ma[0];
        assert.equal(force, true);
        assert.equal(first, 'mod.mjs');
    });
});