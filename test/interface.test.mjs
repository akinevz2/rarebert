import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exit, ExitSignal } from '../lib/core.mjs';
import { Interface, TUI, cli } from '../lib/module.mjs';

// Regression tests for the Interface flow class: TUI -> TUI stage chains
// run through the exit() machinery, and constructing an Interface from a
// CLI runtime (non-interactive stdin) returns exit() instead of an
// instance, so mains can uniformly `return new Interface(...)`.

// Build an instance bypassing the constructor's CLI-runtime guard so the
// chain semantics are deterministic regardless of the test runner's TTY.
function makeFlow(stages) {
    const flow = Object.create(Interface.prototype);
    flow.name = 'test-flow';
    flow.path = 'test-flow';
    flow.tui = null;
    flow.stages = stages;
    return flow;
}

// Same bypass for the prompt-factory tests: factories only need this.tui.
function makeIface() {
    const iface = Object.create(Interface.prototype);
    iface.name = 'test-iface';
    iface.path = 'test-iface';
    iface.tui = new TUI('test.mjs');
    iface.stages = [];
    return iface;
}

describe('Interface — CLI-runtime guard', () => {
    test(
        'constructing from a CLI runtime returns exit() — a nonInteractive ExitSignal, not an instance',
        { skip: cli.isInteractive() },
        () => {
            const result = new Interface('nope');
            assert.ok(result instanceof ExitSignal);
            assert.ok(!(result instanceof Interface));
            assert.equal(result.code, 1);
        }
    );
});

describe('Interface — stage chain semantics', () => {
    test('all stages advancing yields exit code 0', async () => {
        const flow = makeFlow([async () => 'a', async () => 'b', async () => undefined]);
        assert.equal(await flow.execute([]), 0);
    });

    test('function stages receive ctx { tui, args, prev } and plain values chain as prev', async () => {
        const seen = [];
        const flow = makeFlow([
            async ({ args, prev }) => {
                seen.push(['s1', args, prev]);
                return 'one';
            },
            async ({ prev }) => {
                seen.push(['s2', prev]);
                return `${prev}-two`;
            }
        ]);
        assert.equal(await flow.execute(['x']), 0);
        assert.deepEqual(seen, [
            ['s1', ['x'], undefined],
            ['s2', 'one']
        ]);
    });

    test('a stage returning a non-zero number terminates the flow with that code', async () => {
        let ran = false;
        const flow = makeFlow([async () => 2, async () => (ran = true)]);
        assert.equal(await flow.execute([]), 2);
        assert.equal(ran, false, 'stages after a terminating stage must not run');
    });

    test('a stage returning exit(0) advances; exit(1) terminates with code 1', async () => {
        const advance = makeFlow([async () => exit(0), async () => 'next']);
        assert.equal(await advance.execute([]), 0);

        const terminate = makeFlow([async () => exit(1), async () => 'never']);
        assert.equal(await terminate.execute([]), 1);
    });

    test('TUI-shaped stages run via their execute(args)', async () => {
        const calls = [];
        const stage = { execute: async (args) => (calls.push(args), 0) };
        const flow = makeFlow([stage]);
        assert.equal(await flow.execute(['a']), 0);
        assert.deepEqual(calls, [['a']]);
    });

    test('the flow is runnable as an ExitSignal submodule — exit(flow) completes with the flow code', async () => {
        const ok = makeFlow([async () => 'a']);
        assert.equal(await exit(ok).complete(), 0);

        const fails = makeFlow([async () => 3]);
        assert.equal(await exit(fails).complete(), 3);
    });
});

describe('Interface — prompt factories (submodule-level runnables)', () => {
    test('runnables are thenable and Module-shaped (execute + then)', async () => {
        const iface = makeIface();
        const r = iface.confirm('proceed?', true);
        assert.equal(typeof r.execute, 'function');
        assert.equal(typeof r.then, 'function');
    });

    test(
        '"return value" — confirm falls back to its initial when non-interactive',
        { skip: cli.isInteractive() },
        async () => {
            const iface = makeIface();
            assert.equal(await iface.confirm('proceed?', true), true);
            assert.equal(await iface.confirm('proceed?', false), false);
        }
    );

    test(
        '"return exit" — select/input bail with a nonInteractive ExitSignal',
        { skip: cli.isInteractive() },
        async () => {
            const iface = makeIface();
            const s = await iface.select('pick?', ['a', 'b']);
            assert.ok(s instanceof ExitSignal);
            const i = await iface.input('name?');
            assert.ok(i instanceof ExitSignal);
        }
    );

    test(
        'a select runnable used as an exit() submodule folds to the bail code',
        { skip: cli.isInteractive() },
        async () => {
            const iface = makeIface();
            const code = await exit(iface.select('pick?', ['a', 'b'])).complete();
            assert.equal(code, 1);
        }
    );

    test('effectful steps are plain function stages — no gate, value chains as prev', async () => {
        const iface = makeIface();
        const logged = [];
        const flow = makeFlow([
            () => {
                logged.push('hello');
                console.log('hello');
            },
            async ({ prev }) => prev
        ]);
        assert.equal(await flow.execute([]), 0);
        assert.deepEqual(logged, ['hello']);
        assert.equal(typeof iface.print, 'undefined', 'print factory is deliberately absent');
    });

    test('a confirm runnable drops into a stage chain and chains its value as prev', async () => {
        const iface = makeIface();
        const flow = makeFlow([iface.confirm('proceed?', true), async ({ prev }) => prev === true]);
        assert.equal(await flow.execute([]), 0);
    });

    test(
        'query bails with a nonInteractive ExitSignal when non-interactive',
        { skip: cli.isInteractive() },
        async () => {
            const iface = makeIface();
            const r = await iface.query('Select', { name: 'x', choices: ['a'] });
            assert.ok(r instanceof ExitSignal);
        }
    );

    test(
        'Interface.createInterface is the single entry — CLI runtime yields exit()',
        { skip: cli.isInteractive() },
        () => {
            const result = Interface.createInterface('nope');
            assert.ok(result instanceof ExitSignal);
            assert.ok(!(result instanceof Interface));
        }
    );
});

describe('Interface — directed stage protocol & flow-as-main', () => {
    test('exit(0) from a stage advances; the flow completes with 0', async () => {
        const flow = makeFlow([async () => exit(0), async () => exit(0)]);
        assert.equal(await flow.execute([]), 0);
    });

    test('exit("explanation") terminates the flow with the string kind\'s code', async () => {
        let ran = false;
        const flow = makeFlow([
            async () => exit('user chose to stop here'),
            async () => (ran = true)
        ]);
        assert.equal(await flow.execute([]), 1);
        assert.equal(ran, false, 'stages after a string termination must not run');
    });

    test('flow-as-main — a CLI main returns exit(flow); execute folds through the submodule kind', async () => {
        const { CLI } = await import('../lib/module.mjs');
        const flow = makeFlow([async () => exit(0), async () => 'done']);
        const mod = new CLI('flow-main.test.mjs', async () => exit(flow), {
            name: 'flow-main.test',
            description: 'test'
        });
        const result = await mod.execute([]);
        assert.ok(result instanceof ExitSignal);
        assert.equal(await result.complete(), 0);
    });

    test(
        'flow-as-main in a CLI runtime — the guard\'s ExitSignal passes through and bails',
        { skip: cli.isInteractive() },
        async () => {
            const { CLI } = await import('../lib/module.mjs');
            const mod = new CLI(
                'flow-guard.test.mjs',
                async () => exit(Interface.createInterface('nope')),
                { name: 'flow-guard.test', description: 'test' }
            );
            const result = await mod.execute([]);
            assert.ok(result instanceof ExitSignal);
            assert.equal(await result.complete(), 1);
        }
    );
});
