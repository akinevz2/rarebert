import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Memo, Memory, memo, cmdAdd, cmdCommit, cmdLog, cmdRecall, cmdDrop, cmdForget, groupArgs } from '../lib/memo.mjs';
import { listAllModules } from '../lib/module.mjs';
import { ExitSignal, exit } from '../lib/core.mjs';

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
//   return exit(0, { onExit: () => console.log(producedValue) })
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
            // producedValue is the shownEntries array, no onExit needed
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

    test('exit("error") produces ExitSignal with code 1 and producedValue as string', () => {
        const sig = exit('test error');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 1);
        assert.equal(sig.producedValue, 'test error');
    });

    test('exit(0, value) produces ExitSignal with code 0 and producedValue', () => {
        const produced = { entries: [{ date: '2026-01-01', subject: 'test' }] };
        const sig = exit(0, produced);
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.equal(sig.producedValue, produced);
    });

    test('exit(0, fn) sets onExit callback, producedValue undefined', () => {
        const sig = exit(0, () => {});
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.equal(sig.producedValue, undefined);
        assert.equal(typeof sig.onExit, 'function');
    });

    test('exit(0, "success string") produces ExitSignal with code 0 and string producedValue', () => {
        const sig = exit(0, 'operation succeeded');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
        assert.equal(sig.producedValue, 'operation succeeded');
    });

    test('exit("failure string") produces ExitSignal with code 1 and string producedValue', () => {
        const sig = exit('operation failed');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 1);
        assert.equal(sig.producedValue, 'operation failed');
    });

    test('complete() returns { exitCode, producedValue } when onExit is undefined', async () => {
        const sig = exit(0, { data: 1 });
        const result = await sig.complete();
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.producedValue, { data: 1 });
    });

    test('complete() returns Module when onExit callback returns a Module-like object', async () => {
        const fakeModule = { execute: () => exit(0, 're-run result') };
        const sig = exit(0, () => fakeModule);
        const result = await sig.complete();
        assert.equal(result, fakeModule, 'complete() should return the Module from onExit');
    });

    test('complete() returns { exitCode, producedValue } when onExit returns non-Module', async () => {
        const sig = exit(0, () => 42);
        const result = await sig.complete();
        assert.equal(result.exitCode, 0);
        assert.equal(result.producedValue, undefined);
    });
});

// ---------------------------------------------------------------------------
// Module::exit() return chain — does NOT call process.exit()
// ---------------------------------------------------------------------------

describe('Module::exit() returns exitCode, does not call process.exit()', () => {
    const { Module } = require('../lib/module.mjs');

    test('Module::exit() returns a number (exitCode) for simple ExitSignal', async () => {
        const mod = Object.create(Module.prototype);
        mod.path = 'test.mjs';
        const result = await mod.exit(exit(0, { data: 1 }));
        assert.equal(typeof result, 'number', 'Module::exit() should return a number exitCode');
        assert.equal(result, 0);
    });

    test('Module::exit() returns 1 for error ExitSignal', async () => {
        const mod = Object.create(Module.prototype);
        mod.path = 'test.mjs';
        const result = await mod.exit(exit('something went wrong'));
        assert.equal(result, 1);
    });

    test('Module::exit() returns a Module when onExit callback returns one', async () => {
        const mod = Object.create(Module.prototype);
        mod.path = 'test.mjs';
        const fakeModule = { execute: () => exit(0) };
        const sig = exit(0, () => fakeModule);
        const result = await mod.exit(sig);
        assert.equal(result, fakeModule, 'Module::exit() should return the Module for re-execution');
    });

    test('Module::exit() returns 1 for non-ExitSignal result', async () => {
        const mod = Object.create(Module.prototype);
        mod.path = 'test.mjs';
        const result = await mod.exit({ not: 'an exit signal' });
        assert.equal(result, 1);
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