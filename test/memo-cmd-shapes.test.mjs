import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Memo, Memory, memo, cmdAdd, cmdCommit, cmdLog, cmdRecall, cmdDrop, cmdForget, groupArgs } from '../lib/memo.mjs';
import { Module, CLI, TUI, listAllModules } from '../lib/module.mjs';
import { ExitSignal, Runtime, exit } from '../lib/core.mjs';
import { ModuleArguments } from '../lib/run.mjs';

// ---------------------------------------------------------------------------
// Contract: every cmd*() is a Module instance (CLI or TUI singleton).
// Args come from the ModuleArguments passed to main(). No factory params.
// cmd main returns: exit(0, data) on success, exit('error') on failure.
// No --json check in lib/memo.mjs — scripts/memo.mjs decides presentation.
// ---------------------------------------------------------------------------

// Helper: build a ModuleArguments from a positional array + opts, then
// call the cmd module's main directly and return the ExitSignal.
async function callMain(cmdModule, positional = [], opts = {}) {
    const args = ModuleArguments.from(positional, opts);
    return await cmdModule.main(args, args);
}

// ---------------------------------------------------------------------------
// cmdAdd
// ---------------------------------------------------------------------------

describe('cmdAdd is a CLI instance with correct exit codes', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdAdd instanceof CLI, `cmdAdd must be CLI, got ${cmdAdd?.constructor?.name}`);
    });

    test('exit(0, data) when adding a valid memo', async () => {
        const sig = await callMain(cmdAdd, ['--add', './lib/core.mjs', 'test memo from unit test'], {});
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.ok(sig.producedResult.module, 'should have module path');
        assert.ok(sig.producedResult.memo, 'should have memo content');
    });

    test("exit('error') when module path is missing", async () => {
        const sig = await callMain(cmdAdd, ['--add'], {});
        assert.equal(sig.exitCode, 1);
        assert.match(sig.producedResult, /missing module path/);
    });

    test("exit('error') when memo content is missing", async () => {
        const sig = await callMain(cmdAdd, ['--add', './lib/core.mjs'], {});
        assert.equal(sig.exitCode, 1);
        assert.match(sig.producedResult, /missing memo content/);
    });

    test("exit('error') when module not found", async () => {
        const sig = await callMain(cmdAdd, ['--add', './nonexistent.mjs', 'some memo'], {});
        assert.equal(sig.exitCode, 1);
        assert.match(sig.producedResult, /module not found/);
    });
});

// ---------------------------------------------------------------------------
// cmdCommit
// ---------------------------------------------------------------------------

describe('cmdCommit is a CLI instance', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdCommit instanceof CLI);
    });

    test('exit(0) on successful commit with --yes', async () => {
        const sig = await callMain(cmdCommit, [], { yes: true });
        assert.equal(sig.exitCode, 0);
    });
});

// ---------------------------------------------------------------------------
// cmdLog
// ---------------------------------------------------------------------------

describe('cmdLog is a CLI instance', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdLog instanceof CLI);
    });

    test('returns ExitSignal', async () => {
        const sig = await callMain(cmdLog, [], {});
        assert.ok(sig instanceof ExitSignal);
    });
});

// ---------------------------------------------------------------------------
// cmdRecall
// ---------------------------------------------------------------------------

describe('cmdRecall is a CLI instance', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdRecall instanceof CLI);
    });

    test("exit('error') when ref is missing", async () => {
        const sig = await callMain(cmdRecall, [], {});
        assert.equal(sig.exitCode, 1);
        assert.match(sig.producedResult, /missing ref/);
    });
});

// ---------------------------------------------------------------------------
// cmdForget
// ---------------------------------------------------------------------------

describe('cmdForget is a CLI instance with correct exit codes', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdForget instanceof CLI);
    });

    test("exit('error') when no module args", async () => {
        const sig = await callMain(cmdForget, [], {});
        assert.equal(sig.exitCode, 1);
        assert.match(sig.producedResult, /missing module argument/);
    });

    test("exit('error') when module not found", async () => {
        const sig = await callMain(cmdForget, ['./nonexistent.mjs'], {});
        assert.equal(sig.exitCode, 1);
        assert.match(sig.producedResult, /module not found/);
    });

    test('exit(0, data) when forgetting an existing module', async () => {
        memo.remember('lib/core.mjs', 'forget-shape-test');
        const sig = await callMain(cmdForget, ['./lib/core.mjs'], {});
        assert.equal(sig.exitCode, 0);
        assert.ok(sig.producedResult.forgotten, 'should have forgotten array');
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting: every cmd*() is a Module instance
// ---------------------------------------------------------------------------

describe('every cmd*() is a Module instance', () => {
    test('cmdAdd is Module', () => { assert.ok(cmdAdd instanceof Module); });
    test('cmdCommit is Module', () => { assert.ok(cmdCommit instanceof Module); });
    test('cmdLog is Module', () => { assert.ok(cmdLog instanceof Module); });
    test('cmdRecall is Module', () => { assert.ok(cmdRecall instanceof Module); });
    test('cmdForget is Module', () => { assert.ok(cmdForget instanceof Module); });
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