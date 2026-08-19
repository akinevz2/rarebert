import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Memo, Memory, memo, cmdAdd, cmdCommit, cmdLog, cmdRecall, cmdDrop, cmdForget, groupArgs } from '../lib/memo.mjs';
import { Module, CLI, listAllModules } from '../lib/module.mjs';
import { ExitSignal, Runtime, exit } from '../lib/core.mjs';

// ---------------------------------------------------------------------------
// Contract: every cmd*() function returns a Module instance (CLI or TUI).
// The Module is run through Runtime.assertSaneExit to verify it produces a
// valid exit branch (exitCode, never undefined). See lib/run.mjs for the
// lifecycle: guard → createRunner → complete → decide → cleanup.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cmd*() now return CLI/TUI Module instances (not ExitSignals directly).
// Use Runtime.assertSaneExit to run them through the lifecycle and inspect
// the report { ok, exitCode, threw, error, producedResult }.
// ---------------------------------------------------------------------------

async function runCmd(cmdModule, args = []) {
    return Runtime.assertSaneExit(cmdModule, args);
}

// ---------------------------------------------------------------------------
// cmdAdd
// ---------------------------------------------------------------------------

describe('cmdAdd returns CLI instance with correct exit codes', () => {
    const modules = listAllModules();

    test('returns CLI instance', () => {
        const groups = groupArgs(['--add', './lib/core.mjs', 'test memo from unit test']);
        const mod = cmdAdd(groups, modules);
        assert.ok(mod instanceof Module, `cmdAdd must return Module, got ${mod?.constructor?.name}`);
    });

    test('sane exit (code 0) when adding a valid memo', async () => {
        const groups = groupArgs(['--add', './lib/core.mjs', 'test memo from unit test']);
        const r = await runCmd(cmdAdd(groups, modules));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 0);
    });

    test('sane exit (code 1) when module path is missing', async () => {
        const groups = groupArgs(['--add']);
        const r = await runCmd(cmdAdd(groups, modules));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 1);
    });

    test('sane exit (code 1) when memo content is missing', async () => {
        const groups = groupArgs(['--add', './lib/core.mjs']);
        const r = await runCmd(cmdAdd(groups, modules));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 1);
    });

    test('sane exit (code 1) when module not found', async () => {
        const groups = groupArgs(['--add', './nonexistent.mjs', 'some memo']);
        const r = await runCmd(cmdAdd(groups, modules));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 1);
    });
});

// ---------------------------------------------------------------------------
// cmdCommit
// ---------------------------------------------------------------------------

describe('cmdCommit returns CLI instance with correct exit codes', () => {
    test('returns CLI instance', () => {
        const mod = cmdCommit(true, false);
        assert.ok(mod instanceof Module, `cmdCommit must return Module, got ${mod?.constructor?.name}`);
    });

    test('sane exit (code 0) on successful commit', async () => {
        const r = await runCmd(cmdCommit(true, false));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 0, 'successful commit should exit code 0');
    });
});

// ---------------------------------------------------------------------------
// cmdLog
// ---------------------------------------------------------------------------

describe('cmdLog returns CLI instance', () => {
    test('returns CLI instance', () => {
        const mod = cmdLog([]);
        assert.ok(mod instanceof Module, `cmdLog must return Module, got ${mod?.constructor?.name}`);
    });

    test('sane exit', async () => {
        const r = await runCmd(cmdLog([]));
        assert.equal(r.ok, true, r.error);
    });
});

// ---------------------------------------------------------------------------
// cmdRecall
// ---------------------------------------------------------------------------

describe('cmdRecall returns CLI instance', () => {
    test('returns CLI instance', () => {
        const mod = cmdRecall(null, []);
        assert.ok(mod instanceof Module, `cmdRecall must return Module, got ${mod?.constructor?.name}`);
    });

    test('sane exit (code 1) when ref is missing', async () => {
        const r = await runCmd(cmdRecall(null, []));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 1, 'missing ref should exit code 1');
    });
});

// ---------------------------------------------------------------------------
// cmdForget
// ---------------------------------------------------------------------------

describe('cmdForget returns CLI instance with correct exit codes', () => {
    const modules = listAllModules();

    test('returns CLI instance', () => {
        const mod = cmdForget([], modules);
        assert.ok(mod instanceof Module, `cmdForget must return Module, got ${mod?.constructor?.name}`);
    });

    test('sane exit (code 1) when no module args', async () => {
        const r = await runCmd(cmdForget([], modules));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 1);
    });

    test('sane exit (code 1) when module not found', async () => {
        const r = await runCmd(cmdForget(['./nonexistent.mjs'], modules));
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 1);
    });

    test('sane exit when forgetting an existing module', async () => {
        const r = await runCmd(cmdForget(['./lib/core.mjs'], modules));
        assert.equal(r.ok, true, r.error);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting: every cmd*() returns a Module instance
// ---------------------------------------------------------------------------

describe('every cmd*() returns a Module instance', () => {
    const modules = listAllModules();

    test('cmdAdd returns Module', () => {
        const groups = groupArgs(['--add', './lib/core.mjs', 'cross-cutting test']);
        assert.ok(cmdAdd(groups, modules) instanceof Module, `got ${typeof cmdAdd(groups, modules)}`);
    });

    test('cmdCommit returns Module', () => {
        assert.ok(cmdCommit(true, false) instanceof Module);
    });

    test('cmdLog returns Module', () => {
        assert.ok(cmdLog([]) instanceof Module);
    });

    test('cmdRecall returns Module', () => {
        assert.ok(cmdRecall(null, []) instanceof Module);
    });

    test('cmdForget returns Module', () => {
        assert.ok(cmdForget([], modules) instanceof Module);
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
        assert.equal(sig.producedResult, undefined);
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