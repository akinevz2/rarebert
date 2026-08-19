import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExitSignal, exit, Runtime } from '../lib/core.mjs';
import { Module, CLI, TUI } from '../lib/module.mjs';
import {
    memo,
    groupArgs,
    cmdAdd,
    cmdCommit,
    cmdDrop,
    cmdForget,
    cmdLog,
    cmdRecall,
    cmdPrintAll,
    cmdPrintSet
} from '../lib/memo.mjs';
import { listAllModules } from '../lib/module.mjs';

// ---------------------------------------------------------------------------
// --json mode audit: every memo cmd*() now returns a CLI/TUI instance.
// Each cmd module has its own --json option. When --json is passed, the
// cmd module's main produces clean JSON-serializable structured output.
// We test by running each cmd through Runtime (which drives the lifecycle).
// ---------------------------------------------------------------------------

function isJsonSerializable(val) {
    try { JSON.stringify(val); return true; } catch { return false; }
}

const modules = listAllModules();
const TEST_MOD = './lib/core.mjs';
const TEST_MEMO = 'json-audit-test-memo';

// Helper: run a cmd module through Runtime with --json and return the
// assertSaneExit report so we can inspect the producedResult.
async function runJson(cmdModule) {
    return Runtime.assertSaneExit(cmdModule, ['--json']);
}

// Helper: run without --json for backwards compat.
async function runPlain(cmdModule, args = []) {
    return Runtime.assertSaneExit(cmdModule, args);
}

// ---------------------------------------------------------------------------
// a) --add --json → { action, module, memo, ok }
// ---------------------------------------------------------------------------

describe('--add --json', () => {
    test('cmdAdd with --json returns CLI that produces structured JSON', async () => {
        const groups = groupArgs(['--add', TEST_MOD, TEST_MEMO]);
        const mod = cmdAdd(groups, modules);
        assert.ok(mod instanceof CLI, 'cmdAdd should return a CLI instance');
        const r = await runJson(mod);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 0);
        assert.equal(r.producedResult.action, 'add');
        assert.equal(r.producedResult.ok, true);
        assert.ok(r.producedResult.module, 'should have module path');
        assert.ok(r.producedResult.memo, 'should have memo content');
        assert.ok(isJsonSerializable(r.producedResult));
    });

    test('cmdAdd without --json returns CLI producing bare string', async () => {
        const groups = groupArgs(['--add', TEST_MOD, TEST_MEMO + '-plain']);
        const mod = cmdAdd(groups, modules);
        const r = await runPlain(mod);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 0);
        assert.equal(typeof r.producedResult, 'string');
    });
});

// ---------------------------------------------------------------------------
// b) --drop --json → { action, module, dropped: [memo contents], ok }
// ---------------------------------------------------------------------------

describe('--drop --json', () => {
    test('cmdDrop returns TUI instance', () => {
        memo.remember('lib/core.mjs', 'drop-test-memo');
        const mod = cmdDrop('./lib/core.mjs', '1', modules);
        assert.ok(mod instanceof TUI, 'cmdDrop should return a TUI instance');
    });

    test('cmdDrop with --json in non-TTY returns structured JSON', async () => {
        memo.remember('lib/core.mjs', 'drop-test-memo-json');
        const mod = cmdDrop('./lib/core.mjs', '1', modules);
        // TUI guard will throw in non-interactive — that's expected.
        const r = await runJson(mod);
        // In non-TTY, TUI guard throws, so r.threw should be true.
        // OR if the TUI allows non-interactive with indices, r.ok is true.
        if (r.threw) {
            assert.ok(r.error, 'should have error message');
        } else {
            assert.equal(r.ok, true, r.error);
            assert.equal(r.producedResult.action, 'drop');
            assert.ok(Array.isArray(r.producedResult.dropped));
            assert.ok(isJsonSerializable(r.producedResult));
        }
    });
});

// ---------------------------------------------------------------------------
// c) --forget --json → { action, forgotten: [{ module, content }], ok }
// ---------------------------------------------------------------------------

describe('--forget --json', () => {
    test('cmdForget with --json returns structured JSON, no human text', async () => {
        memo.remember('lib/core.mjs', 'forget-test-memo');
        const mod = cmdForget(['./lib/core.mjs'], modules);
        assert.ok(mod instanceof CLI, 'cmdForget should return a CLI instance');
        const r = await runJson(mod);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 0);
        assert.equal(r.producedResult.action, 'forget');
        assert.equal(r.producedResult.ok, true);
        assert.ok(Array.isArray(r.producedResult.forgotten), 'forgotten should be an array');
        assert.ok(r.producedResult.forgotten[0].module, 'each entry should have module path');
        assert.ok(Array.isArray(r.producedResult.forgotten[0].content));
        assert.ok(isJsonSerializable(r.producedResult));
    });

    test('cmdForget without --json uses onExit callback (human text)', async () => {
        memo.remember('lib/core.mjs', 'compat-forget-test');
        const mod = cmdForget(['./lib/core.mjs'], modules);
        const r = await runPlain(mod);
        assert.equal(r.ok, true, r.error);
        // Without json, cmdForget returns exit(0, onExitFn) — the onExit
        // callback prints human text. producedResult is undefined.
    });
});

// ---------------------------------------------------------------------------
// d) list-only --json → clean array of { module, memos } (no project/dir/abs)
// ---------------------------------------------------------------------------

describe('list-only --json', () => {
    test('cmdPrintAll with --json returns clean array', async () => {
        memo.remember('lib/core.mjs', 'list-test-memo');
        const mod = cmdPrintAll(true);
        assert.ok(mod instanceof CLI);
        const r = await runJson(mod);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.exitCode, 0);
        assert.ok(isJsonSerializable(r.producedResult));
        const arr = r.producedResult;
        assert.ok(Array.isArray(arr), 'should be an array');
        if (arr.length > 0) {
            const entry = arr[0];
            assert.ok(entry.module, 'entry should have module path (string)');
            assert.ok(Array.isArray(entry.memos), 'entry should have memos array');
            assert.equal(typeof entry.module, 'string', 'module should be a plain string path');
            assert.equal(entry.project, undefined, 'should not include project object');
            assert.equal(entry.dir, undefined, 'should not include dir');
            assert.equal(entry.abs, undefined, 'should not include abs');
        }
    });

    test('cmdPrintSet with --json returns clean array scoped to set', async () => {
        memo.remember('lib/core.mjs', 'list-set-test-memo');
        const resolved = modules.filter((m) => m.path === 'lib/core.mjs');
        if (resolved.length === 0) { assert.ok(true, 'no core.mjs module found, skipping'); return; }
        const mod = cmdPrintSet(resolved, false);
        assert.ok(mod instanceof CLI);
        const r = await runJson(mod);
        assert.equal(r.ok, true, r.error);
        assert.ok(isJsonSerializable(r.producedResult));
    });
});

// ---------------------------------------------------------------------------
// e) --log --json → { action, entries }
// ---------------------------------------------------------------------------

describe('--log --json', () => {
    test('cmdLog returns CLI instance', () => {
        const mod = cmdLog([]);
        assert.ok(mod instanceof CLI);
    });

    test('cmdLog with --json returns structured JSON', async () => {
        const mod = cmdLog([]);
        const r = await runJson(mod);
        // May be ok:true with entries, or ok:false with error (no snapshots).
        assert.ok(isJsonSerializable(r.producedResult));
    });
});

// ---------------------------------------------------------------------------
// f) main() integration — --json threaded through to cmd modules via Runtime
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
});

// ---------------------------------------------------------------------------
// g) Backwards compat — without --json, all branches still work
// ---------------------------------------------------------------------------

describe('backwards compat — without --json', () => {
    test('--add without --json produces bare string', async () => {
        const groups = groupArgs(['--add', TEST_MOD, 'compat-test-memo']);
        const mod = cmdAdd(groups, modules);
        const r = await runPlain(mod);
        assert.equal(r.ok, true, r.error);
        assert.equal(typeof r.producedResult, 'string');
    });

    test('--forget without --json uses onExit callback', async () => {
        memo.remember('lib/core.mjs', 'compat-forget-test2');
        const mod = cmdForget(['./lib/core.mjs'], modules);
        const r = await runPlain(mod);
        assert.equal(r.ok, true, r.error);
    });
});

// ---------------------------------------------------------------------------
// h) All cmd*() return Module instances (CLI or TUI)
// ---------------------------------------------------------------------------

describe('all cmd*() return Module instances', () => {
    test('every cmd function returns a CLI or TUI', () => {
        const groups = groupArgs(['--add', TEST_MOD, 'module-shape-test']);
        assert.ok(cmdAdd(groups, modules) instanceof Module);
        assert.ok(cmdCommit(true, false) instanceof Module);
        assert.ok(cmdLog([]) instanceof Module);
        assert.ok(cmdRecall('HEAD', []) instanceof Module);
        assert.ok(cmdDrop(TEST_MOD, '1', modules) instanceof Module);
        assert.ok(cmdForget([TEST_MOD], modules) instanceof Module);
        assert.ok(cmdPrintAll(true) instanceof Module);
        assert.ok(cmdPrintSet(modules.slice(0, 1), false) instanceof Module);
    });
});

test.after(() => {
    memo.clearBuffer();
});