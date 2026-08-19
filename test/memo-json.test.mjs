import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExitSignal, exit, Runtime } from '../lib/core.mjs';
import { Module, CLI, TUI } from '../lib/module.mjs';
import { ModuleArguments } from '../lib/run.mjs';
import {
    memo,
    cmdAdd,
    cmdDrop,
    cmdForget,
    cmdLog,
    cmdRecall,
    cmdCommit,
    cmdPrintAll,
    cmdPrintSet
} from '../lib/memo.mjs';
import { listAllModules } from '../lib/module.mjs';

// ---------------------------------------------------------------------------
// --json mode: cmd*() are Module singletons. scripts/memo.mjs::main calls
// cmd.main(args) directly, gets the ExitSignal, and formats producedResult
// as JSON or human text. cmd functions return raw data — no --json check.
// ---------------------------------------------------------------------------

function isJsonSerializable(val) {
    try { JSON.stringify(val); return true; } catch { return false; }
}

const TEST_MOD = './lib/core.mjs';
const TEST_MEMO = 'json-audit-test-memo';

async function callMain(cmdModule, positional = [], opts = {}) {
    const args = ModuleArguments.from(positional, opts);
    return await cmdModule.main(args, args);
}

// ---------------------------------------------------------------------------
// a) cmdAdd → exit(0, {module, memo}) on success, exit('error') on failure
// ---------------------------------------------------------------------------

describe('cmdAdd — raw data (no json check)', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdAdd instanceof CLI);
    });

    test('returns {module, memo} data on success', async () => {
        const sig = await callMain(cmdAdd, ['--add', TEST_MOD, TEST_MEMO]);
        assert.equal(sig.exitCode, 0);
        assert.ok(sig.producedResult.module, 'should have module path');
        assert.ok(sig.producedResult.memo, 'should have memo content');
        assert.ok(isJsonSerializable(sig.producedResult));
    });

    test('returns error string on missing module path', async () => {
        const sig = await callMain(cmdAdd, ['--add']);
        assert.equal(sig.exitCode, 1);
        assert.equal(typeof sig.producedResult, 'string');
    });
});

// ---------------------------------------------------------------------------
// b) cmdDrop → exit(0, {module, dropped}) on success (TUI)
// ---------------------------------------------------------------------------

describe('cmdDrop — raw data (no json check)', () => {
    test('is a TUI instance', () => {
        assert.ok(cmdDrop instanceof TUI);
    });
});

// ---------------------------------------------------------------------------
// c) cmdForget → exit(0, {forgotten}) on success
// ---------------------------------------------------------------------------

describe('cmdForget — raw data (no json check)', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdForget instanceof CLI);
    });

    test('returns {forgotten} data on success', async () => {
        memo.remember('lib/core.mjs', 'forget-test-memo');
        const sig = await callMain(cmdForget, [TEST_MOD]);
        assert.equal(sig.exitCode, 0);
        assert.ok(Array.isArray(sig.producedResult.forgotten));
        assert.ok(sig.producedResult.forgotten[0].module);
        assert.ok(Array.isArray(sig.producedResult.forgotten[0].content));
        assert.ok(isJsonSerializable(sig.producedResult));
    });

    test('returns error string on missing module arg', async () => {
        const sig = await callMain(cmdForget, []);
        assert.equal(sig.exitCode, 1);
        assert.equal(typeof sig.producedResult, 'string');
    });
});

// ---------------------------------------------------------------------------
// d) cmdPrintAll → exit(0, [{module, memos}]) — clean, no project/dir/abs
// ---------------------------------------------------------------------------

describe('cmdPrintAll — raw data (no json check)', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdPrintAll instanceof CLI);
    });

    test('returns clean array of {module, memos}', async () => {
        memo.remember('lib/core.mjs', 'list-test-memo');
        const sig = await callMain(cmdPrintAll, []);
        assert.equal(sig.exitCode, 0);
        assert.ok(Array.isArray(sig.producedResult));
        if (sig.producedResult.length > 0) {
            const entry = sig.producedResult[0];
            assert.equal(typeof entry.module, 'string');
            assert.ok(Array.isArray(entry.memos));
            assert.equal(entry.project, undefined);
            assert.equal(entry.dir, undefined);
            assert.equal(entry.abs, undefined);
        }
        assert.ok(isJsonSerializable(sig.producedResult));
    });
});

// ---------------------------------------------------------------------------
// e) cmdLog → exit(0, shownEntries) on success
// ---------------------------------------------------------------------------

describe('cmdLog — raw data (no json check)', () => {
    test('is a CLI instance', () => {
        assert.ok(cmdLog instanceof CLI);
    });

    test('returns ExitSignal with entries data', async () => {
        const sig = await callMain(cmdLog, []);
        assert.ok(sig instanceof ExitSignal);
        assert.ok(isJsonSerializable(sig.producedResult) || sig.producedResult === undefined);
    });
});

// ---------------------------------------------------------------------------
// f) main() integration — --json through Runtime
// ---------------------------------------------------------------------------

describe('main() integration — --json through Runtime', () => {
    test('--json --add runs without crash', async () => {
        const mod = (await import('../scripts/memo.mjs')).default;
        const runtime = new Runtime(mod);
        const code = await runtime.execute(['--json', '--add', TEST_MOD, 'integration-test-memo']);
        assert.equal(typeof code, 'number');
    });

    test('--json alone (list-only) runs without crash', async () => {
        const mod = (await import('../scripts/memo.mjs')).default;
        const runtime = new Runtime(mod);
        const code = await runtime.execute(['--json']);
        assert.equal(typeof code, 'number');
    });

    test('--json --forget runs without crash', async () => {
        memo.remember('lib/core.mjs', 'forget-integration-test');
        const mod = (await import('../scripts/memo.mjs')).default;
        const runtime = new Runtime(mod);
        const code = await runtime.execute(['--json', '--forget', TEST_MOD]);
        assert.equal(typeof code, 'number');
    });

    test('--add without --json runs without crash', async () => {
        const mod = (await import('../scripts/memo.mjs')).default;
        const runtime = new Runtime(mod);
        const code = await runtime.execute(['--add', TEST_MOD, 'plain-integration-test']);
        assert.equal(typeof code, 'number');
    });
});

// ---------------------------------------------------------------------------
// g) All cmd*() are Module instances
// ---------------------------------------------------------------------------

describe('all cmd*() are Module instances', () => {
    test('every cmd is a Module', () => {
        assert.ok(cmdAdd instanceof Module);
        assert.ok(cmdCommit instanceof Module);
        assert.ok(cmdLog instanceof Module);
        assert.ok(cmdRecall instanceof Module);
        assert.ok(cmdDrop instanceof Module);
        assert.ok(cmdForget instanceof Module);
        assert.ok(cmdPrintAll instanceof Module);
        assert.ok(cmdPrintSet instanceof Module);
    });
});

test.after(() => {
    memo.clearBuffer();
});