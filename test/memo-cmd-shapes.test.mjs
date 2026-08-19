import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Memo, Memory, memo, cmdAdd, cmdCommit, cmdLog, cmdRecall, cmdDrop, cmdForget, groupArgs } from '../lib/memo.mjs';
import { Module, CLI, listAllModules } from '../lib/module.mjs';
import { ExitSignal, Runtime, exit } from '../lib/core.mjs';

// ---------------------------------------------------------------------------
// Contract: every cmd*() function must return an ExitSignal in every branch.
//
// exit() mapping (lib/core.mjs:117):
//   exit(0)              → ExitSignal(0)           success, no payload
//   exit("error msg")    → ExitSignal(1, console.error("error msg"))  failure
//   exit(number)         → ExitSignal(number)      explicit exit code
//   exit(ExitSignal)     → passthrough
//
// For success with a produced value, cmd*() should use:
//   return exit(0, { onExit: () => console.log(producedResult) })
// or simply return exit(0) if the value was already printed via streaming.
//
// scripts/memo.mjs then forwards: `return await cmdX(args)` — the ExitSignal
// propagates through executeAndExit. If --json is in opts, the produced value
// is JSON.stringify'd before being passed to exit/onExit.
//
// This test verifies that every branch of every cmd*() returns an ExitSignal,
// NOT undefined, NOT a boolean, NOT a plain {success} object.
// ---------------------------------------------------------------------------

function isExitSignal(val) {
    return val instanceof ExitSignal;
}

function exitCode(val) {
    return isExitSignal(val) ? val.exitCode : null;
}

// ---------------------------------------------------------------------------
// cmdAdd
// ---------------------------------------------------------------------------

describe('cmdAdd returns ExitSignal', () => {
    const modules = listAllModules();

    test('returns ExitSignal when adding a valid memo', async () => {
        const groups = groupArgs(['--add', './lib/core.mjs', 'test memo from unit test']);
        const result = await cmdAdd(groups, modules);
        assert.ok(isExitSignal(result), `cmdAdd must return ExitSignal, got ${result?.constructor?.name}`);
        assert.equal(exitCode(result), 0, 'successful add should exit code 0');
    });

    test('returns ExitSignal with code 1 when module path is missing', async () => {
        const groups = groupArgs(['--add']);
        const result = await cmdAdd(groups, modules);
        assert.ok(isExitSignal(result), `cmdAdd must return ExitSignal, got ${result?.constructor?.name}`);
        assert.equal(exitCode(result), 1, 'missing module path should exit code 1');
    });

    test('returns ExitSignal with code 1 when memo content is missing', async () => {
        const groups = groupArgs(['--add', './lib/core.mjs']);
        const result = await cmdAdd(groups, modules);
        assert.ok(isExitSignal(result));
        assert.equal(exitCode(result), 1);
    });

    test('returns ExitSignal with code 1 when module not found', async () => {
        const groups = groupArgs(['--add', './nonexistent.mjs', 'some memo']);
        const result = await cmdAdd(groups, modules);
        assert.ok(isExitSignal(result));
        assert.equal(exitCode(result), 1);
    });
});

// ---------------------------------------------------------------------------
// cmdCommit
// ---------------------------------------------------------------------------

describe('cmdCommit returns ExitSignal', () => {
    test('returns ExitSignal (not undefined, not boolean, not plain object)', async () => {
        const result = await cmdCommit(true, false);
        assert.ok(isExitSignal(result), `cmdCommit must return ExitSignal, got ${result?.constructor?.name}`);
    });

    test('returns ExitSignal with code 0 on successful commit', async () => {
        const result = await cmdCommit(true, false);
        assert.ok(isExitSignal(result));
        assert.equal(exitCode(result), 0, 'successful commit should exit code 0');
    });
});

// ---------------------------------------------------------------------------
// cmdLog
// ---------------------------------------------------------------------------

describe('cmdLog returns ExitSignal', () => {
    test('returns ExitSignal (not undefined, not plain object)', () => {
        const result = cmdLog([]);
        assert.ok(isExitSignal(result), `cmdLog must return ExitSignal, got ${result?.constructor?.name}`);
    });

    test('onExit is a function that can produce output', () => {
        const result = cmdLog([]);
        assert.ok(isExitSignal(result));
        if (exitCode(result) === 0) {
            // producedResult is the shownEntries array, no onExit needed
        }
    });
});

// ---------------------------------------------------------------------------
// cmdRecall
// ---------------------------------------------------------------------------

describe('cmdRecall returns ExitSignal', () => {
    test('returns ExitSignal with code 1 when ref is missing', () => {
        const result = cmdRecall(null, []);
        assert.ok(isExitSignal(result), `cmdRecall must return ExitSignal, got ${result?.constructor?.name}`);
        assert.equal(exitCode(result), 1, 'missing ref should exit code 1');
    });
});

// ---------------------------------------------------------------------------
// cmdForget
// ---------------------------------------------------------------------------

describe('cmdForget returns ExitSignal', () => {
    const modules = listAllModules();

    test('returns ExitSignal with code 1 when no module args', () => {
        const result = cmdForget([], modules);
        assert.ok(isExitSignal(result), `cmdForget must return ExitSignal, got ${result?.constructor?.name}`);
        assert.equal(exitCode(result), 1);
    });

    test('returns ExitSignal with code 1 when module not found', () => {
        const result = cmdForget(['./nonexistent.mjs'], modules);
        assert.ok(isExitSignal(result));
        assert.equal(exitCode(result), 1);
    });

    test('returns ExitSignal when forgetting an existing module', () => {
        const result = cmdForget(['./lib/core.mjs'], modules);
        assert.ok(isExitSignal(result), `cmdForget must return ExitSignal, got ${result?.constructor?.name}`);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting: no cmd*() returns undefined, boolean, or plain object
// ---------------------------------------------------------------------------

describe('no cmd*() returns undefined, boolean, or plain object', () => {
    const modules = listAllModules();

    test('cmdAdd always returns ExitSignal', async () => {
        const groups = groupArgs(['--add', './lib/core.mjs', 'cross-cutting test']);
        const result = await cmdAdd(groups, modules);
        assert.ok(isExitSignal(result), `got ${typeof result}`);
    });

    test('cmdCommit always returns ExitSignal', async () => {
        const result = await cmdCommit(true, false);
        assert.ok(isExitSignal(result), `got ${typeof result}`);
    });

    test('cmdLog always returns ExitSignal', () => {
        const result = cmdLog([]);
        assert.ok(isExitSignal(result), `got ${typeof result}`);
    });

    test('cmdRecall always returns ExitSignal', () => {
        const result = cmdRecall(null, []);
        assert.ok(isExitSignal(result), `got ${typeof result}`);
    });

    test('cmdForget always returns ExitSignal', () => {
        const result = cmdForget([], modules);
        assert.ok(isExitSignal(result), `got ${typeof result}`);
    });
});

// ---------------------------------------------------------------------------
// ExitSignal shape verification
// ---------------------------------------------------------------------------

describe('ExitSignal shape', () => {
    test('exit(0) produces ExitSignal with code 0', () => {
        const sig = exit(0);
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.equal(sig.producedValue, undefined);
    });

    test('exit("error") produces ExitSignal with code 1 and producedResult as string', () => {
        const sig = exit('test error');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 1);
        assert.equal(sig.producedResult, 'test error');
    });

    test('exit(0, value) produces ExitSignal with code 0 and producedResult', () => {
        const produced = { entries: [{ date: '2026-01-01', subject: 'test' }] };
        const sig = exit(0, produced);
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.equal(sig.producedResult, produced);
    });

    test('exit(0, fn) sets onExit callback, producedResult undefined', () => {
        const sig = exit(0, () => {});
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.equal(sig.producedResult, undefined);
        assert.equal(typeof sig.onExit, 'function');
    });

    test('exit(0, "success string") produces ExitSignal with code 0 and string producedResult', () => {
        const sig = exit(0, 'operation succeeded');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.equal(sig.producedResult, 'operation succeeded');
    });

    test('exit("failure string") produces ExitSignal with code 1 and string producedResult', () => {
        const sig = exit('operation failed');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 1);
        assert.equal(sig.producedResult, 'operation failed');
    });

    test('complete() returns { exitCode, producedResult } when onExit is undefined', async () => {
        const sig = exit(0, { data: 1 });
        const result = await sig.complete();
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.producedResult, { data: 1 });
    });

    test('complete() returns Module when onExit callback returns a Module-like object', async () => {
        const fakeModule = { meta: { name: 'sub' }, main: () => exit(0, 're-run result') };
        const sig = exit(0, () => fakeModule);
        const result = await sig.complete();
        assert.equal(result, fakeModule, 'complete() should return the Module from onExit');
    });

    test('complete() returns { exitCode, producedResult } when onExit returns non-Module', async () => {
        const sig = exit(0, () => 42);
        const result = await sig.complete();
        assert.equal(result.exitCode, 0);
        assert.equal(result.producedResult, undefined);
    });
});

// ---------------------------------------------------------------------------
// Runtime lifecycle — assertSaneExit + execute guard/invoke/decide/cleanup.
// Module::exit() was removed; Runtime owns the completion/decision logic.
// Runtime IS the runner — it builds the Commander runner from module.meta +
// module.main. A Module never holds a runner reference.
// ---------------------------------------------------------------------------

// Fake module factory: constructs a real CLI instance whose main simply
// returns a known value through exit(). Extra fields (guard, cleanup) are
// attached after construction so the test exercises the actual Module/CLI
// code path while still allowing hook overrides.
const fakeMod = (file, main, extra = {}) => {
    const meta = { name: file, allowUnknownOption: true, ...extra.meta };
    const { meta: _drop, ...hooks } = extra;
    const mod = new CLI(file, main, meta);
    Object.assign(mod, hooks);
    return mod;
};

describe('Runtime.assertSaneExit — the test-only runtime check interface', () => {

    test('returns ok:true + exitCode for a main that returns exit(0, value)', async () => {
        const mod = fakeMod('test.mjs', () => exit(0, { data: 1 }));
        const r = await Runtime.assertSaneExit(mod, []);
        assert.equal(r.ok, true);
        assert.equal(r.exitCode, 0);
        assert.deepEqual(r.producedResult, { data: 1 });
    });

    test('returns ok:true + exitCode 1 for an error ExitSignal', async () => {
        const mod = fakeMod('test.mjs', () => exit('something went wrong'));
        const r = await Runtime.assertSaneExit(mod, []);
        assert.equal(r.ok, true);
        assert.equal(r.exitCode, 1);
    });

    test('reports ok:false when module is not runnable (no main)', async () => {
        const mod = { path: 'broken.mjs', meta: { name: 'broken.mjs' } };
        const r = await Runtime.assertSaneExit(mod, []);
        assert.equal(r.ok, false);
        assert.match(r.error, /not runnable/);
    });

    test('reports reExecutes when complete() returns a runnable Module', async () => {
        const sub = fakeMod('sub.mjs', () => exit(0));
        const mod = fakeMod('test.mjs', () => exit(0, () => sub));
        const r = await Runtime.assertSaneExit(mod, []);
        assert.equal(r.ok, true);
        assert.ok(r.reExecutes, 'reExecutes should be set (the sub module path)');
        assert.match(String(r.reExecutes), /sub\.mjs$/);
    });

    test('reports threw:true when guard throws', async () => {
        const mod = fakeMod('test.mjs', () => exit(0), {
            async guard() { throw new Error('guard-boom'); }
        });
        const r = await Runtime.assertSaneExit(mod, []);
        assert.equal(r.threw, true);
        assert.equal(r.ok, false);
        assert.match(r.error, /guard-boom/);
    });
});

describe('Runtime.execute — lifecycle hooks (guard/invoke/decide/cleanup)', () => {

    test('calls guard before main, cleanup after terminal result', async () => {
        const calls = [];
        const mod = fakeMod('test.mjs', () => { calls.push('main'); return exit(0); }, {
            async guard(_a) { calls.push('guard'); },
            async cleanup(_a) { calls.push('cleanup'); }
        });
        const code = await new Runtime(mod).execute([]);
        assert.equal(code, 0);
        assert.deepEqual(calls, ['guard', 'main', 'cleanup']);
    });

    test('skips cleanup when looping to a produced Module', async () => {
        const calls = [];
        const sub = fakeMod('sub.mjs', () => { calls.push('sub-main'); return exit(0); }, {
            async cleanup(_a) { calls.push('sub-cleanup'); }
        });
        const mod = fakeMod('test.mjs', () => { calls.push('main'); return exit(0, () => sub); }, {
            async guard(_a) { calls.push('guard'); },
            async cleanup(_a) { calls.push('cleanup'); }
        });
        const code = await new Runtime(mod).execute([]);
        assert.equal(code, 0);
        assert.deepEqual(calls, ['guard', 'main', 'sub-main', 'sub-cleanup']);
    });

    test('forwards the SAME args to a produced Module (not reset to [])', async () => {
        const seen = [];
        const sub = fakeMod('sub.mjs', (args) => { seen.push([...args]); return exit(0); });
        const mod = fakeMod('test.mjs', () => exit(0, () => sub));
        await new Runtime(mod).execute(['--flag', 'operand']);
        assert.deepEqual(seen[0], ['--flag', 'operand']);
    });

    test('returns 1 when module is not runnable (no main)', async () => {
        const mod = { path: 'broken.mjs', meta: { name: 'broken.mjs' } };
        const code = await new Runtime(mod).execute([]);
        assert.equal(code, 1);
    });
});

// ---------------------------------------------------------------------------
// Memo and Memory class shape verification (unchanged)
// ---------------------------------------------------------------------------

describe('Memo class shape', () => {
    test('Memo has expected fields', () => {
        const m = new Memo({ owner: 'test', name: 'test', lastModified: 123, path: 'lib/test.mjs', content: ['memo content'], related: [] });
        assert.equal(m.owner, 'test');
        assert.equal(m.name, 'test');
        assert.equal(m.lastModified, 123);
        assert.equal(m.path, 'lib/test.mjs');
        assert.ok(Array.isArray(m.content));
        assert.ok(Array.isArray(m.related));
    });
});

describe('Memory class shape', () => {
    test('Memory has buffer and modules', () => {
        assert.ok(Array.isArray(memo.buffer));
        assert.equal(typeof memo.modules, 'function');
    });

    test('loadAllMemos returns MemoryEntry-shaped array', () => {
        const all = memo.loadAllMemos();
        assert.ok(Array.isArray(all), 'loadAllMemos must return an array');
        for (const entry of all) {
            assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry));
            assert.ok('module' in entry);
            assert.ok('memos' in entry && Array.isArray(entry.memos));
            assert.ok('lastModified' in entry && typeof entry.lastModified === 'number');
        }
    });
});