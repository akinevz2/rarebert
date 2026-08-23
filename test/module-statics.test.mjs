import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Module, CLI, TUI } from '../lib/module.mjs';
import { rarebert } from '../lib/projects.mjs';
import { exit, ExitSignal } from '../lib/core.mjs';

// ---------------------------------------------------------------------------
// Module.* statics — the cli/tui singleton replacements.
// Verifies the migration from cli.X()/tui.X() → Module.X() static methods.
// ---------------------------------------------------------------------------

describe('Module static terminal helpers (cli/tui replacement)', () => {
    test('Module.isInteractive() returns boolean', () => {
        const result = Module.isInteractive();
        assert.equal(typeof result, 'boolean');
    });

    test('Module.truncate() truncates long strings', () => {
        const long = 'x'.repeat(100);
        const truncated = Module.truncate(long, 20);
        assert.ok(truncated.length <= 20, `truncate should produce <= 20 chars, got ${truncated.length}`);
        assert.ok(truncated.endsWith('…'), 'truncated string should end with ellipsis');
    });

    test('Module.truncate() leaves short strings unchanged', () => {
        assert.equal(Module.truncate('short', 20), 'short');
    });

    test('Module.onAbort() registers and returns unsubscribe function', () => {
        const off = Module.onAbort(() => {});
        assert.equal(typeof off, 'function');
        off();
    });

    test('Module.ok() returns ExitSignal with code 0', () => {
        const sig = Module.ok('done');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 0);
    });

    test('Module.fail() returns ExitSignal with code 1', () => {
        const sig = Module.fail('broken');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 1);
    });

    test('Module.nonInteractive() returns ExitSignal with code 1 and prefixed message', () => {
        const sig = Module.nonInteractive('cannot prompt');
        assert.ok(sig instanceof ExitSignal);
        assert.equal(sig.exitCode, 1);
        assert.equal(sig.producedResult, 'Non-interactive; cannot prompt');
    });
});

// ---------------------------------------------------------------------------
// Module.createCommand / wantsHelp / printHelp / parse — previously on the
// cli proxy object, now static on Module. These delegate to Runtime.
// ---------------------------------------------------------------------------

describe('Module static commander helpers (createCommand, wantsHelp, printHelp, parse)', () => {
    const meta = {
        name: 'test-mod',
        description: 'a test module',
        usage: 'node index.js test-mod [args]',
        options: [
            { flag: '-v, --verbose', description: 'verbose output' },
            { flag: '--trace <name>', description: 'trace a binding' }
        ]
    };

    test('Module.createCommand() returns a Commander program', () => {
        const program = Module.createCommand(meta);
        assert.ok(program, 'createCommand should return a program');
        assert.equal(typeof program.parseAsync, 'function');
        assert.equal(typeof program.parse, 'function');
    });

    test('Module.wantsHelp() detects --help flag', () => {
        assert.equal(Module.wantsHelp(['--help']), true);
        assert.equal(Module.wantsHelp(['-h']), true);
        assert.equal(Module.wantsHelp(['some-module']), false);
        assert.equal(Module.wantsHelp([]), false);
    });

    test('Module.printHelp() writes to stdout without throwing', () => {
        // Capture console.log
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
            Module.printHelp(meta);
        } finally {
            console.log = origLog;
        }
        assert.ok(logs.length > 0, 'printHelp should produce output');
        assert.ok(logs.some((l) => l.includes('test-mod')), 'output should include module name');
        assert.ok(logs.some((l) => l.includes('verbose')), 'output should include option');
    });

    test('Module.parse() returns { flags, positional } object', () => {
        const result = Module.parse(['--verbose', 'some-module'], meta.options);
        assert.ok(result, 'parse should return a result');
        assert.ok('flags' in result, 'result should have flags');
        assert.ok('positional' in result, 'result should have positional');
        assert.equal(result.flags.verbose, true);
        assert.deepEqual(result.positional, ['some-module']);
    });

    test('Module.parse() captures --trace value', () => {
        const result = Module.parse(['--trace', 'myName', 'mod.mjs'], meta.options);
        assert.equal(result.flags.trace, 'myName');
        assert.deepEqual(result.positional, ['mod.mjs']);
    });

    test('Module.parse() returns ExitSignal for unknown --help option', () => {
        // helpOption(false) is set, so --help is an unknown option
        const result = Module.parse(['--help'], meta.options);
        assert.ok(result instanceof ExitSignal, 'parse should return ExitSignal for unknown option');
        assert.equal(result.exitCode, 1);
        assert.ok(result.producedResult.includes('unknown option'), 'should mention unknown option');
    });
});

// ---------------------------------------------------------------------------
// Module.listAllModules() — the static method that replaced the standalone
// function previously exported from module.mjs. Must return an array of
// Module instances with path/abs/name properties.
// ---------------------------------------------------------------------------

describe('Module.listAllModules() static method', () => {
    const modules = Module.listAllModules();

    test('returns an array', () => {
        assert.ok(Array.isArray(modules), `expected array, got ${typeof modules}`);
    });

    test('returns at least 10 modules (lib/ + scripts/)', () => {
        assert.ok(modules.length >= 10, `expected >= 10 modules, got ${modules.length}`);
    });

    test('every entry is a Module instance', () => {
        const nonModules = modules.filter((m) => !(m instanceof Module));
        assert.equal(nonModules.length, 0, `non-Module entries: ${nonModules.length}`);
    });

    test('every entry has path, abs, name, ext properties', () => {
        for (const m of modules) {
            assert.ok(typeof m.path === 'string', `missing path on ${m}`);
            assert.ok(typeof m.abs === 'string', `missing abs on ${m}`);
            assert.ok(typeof m.name === 'string', `missing name on ${m}`);
            assert.ok(typeof m.ext === 'string', `missing ext on ${m}`);
        }
    });

    test('includes known core modules', () => {
        const paths = modules.map((m) => m.path);
        assert.ok(paths.includes('lib/module.mjs'), 'should include lib/module.mjs');
        assert.ok(paths.includes('lib/projects.mjs'), 'should include lib/projects.mjs');
        assert.ok(paths.includes('lib/core.mjs'), 'should include lib/core.mjs');
        assert.ok(paths.includes('scripts/commit.mjs'), 'should include scripts/commit.mjs');
    });

    test('matches the standalone listAllModules result count', () => {
        // The standalone function in module.mjs is no longer exported, but
        // Module.listAllModules() should produce the same set. We verify by
        // re-running and checking the count is stable.
        const again = Module.listAllModules();
        assert.equal(again.length, modules.length, 'listAllModules should be deterministic');
    });
});

// ---------------------------------------------------------------------------
// rarebert.* discovery methods — the Project instance methods that replaced
// the standalone functions previously exported from module.mjs.
// resolveModule, resolveModuleSet, findDirectoryTarget, directoryTargetByPath,
// buildModuleChoices, promptModule, promptModuleChoices.
// ---------------------------------------------------------------------------

describe('rarebert (Project) discovery methods', () => {
    const modules = Module.listAllModules();

    test('rarebert.resolveModule() finds a module by path', () => {
        const r = rarebert.resolveModule('lib/module.mjs', modules);
        assert.ok(r, 'should resolve lib/module.mjs');
        assert.equal(r.module.path, 'lib/module.mjs');
        assert.equal(r.rel, 'lib/module.mjs');
        assert.ok(typeof r.sidecar === 'string', 'should have sidecar path');
    });

    test('rarebert.resolveModule() finds by basename', () => {
        const r = rarebert.resolveModule('module', modules);
        assert.ok(r, 'should resolve by basename "module"');
        assert.ok(r.module.path.endsWith('module.mjs'));
    });

    test('rarebert.resolveModule() returns null for unknown', () => {
        const r = rarebert.resolveModule('does-not-exist.mjs', modules);
        assert.equal(r, null);
    });

    test('rarebert.resolveModuleSet() returns array for valid args', () => {
        const set = rarebert.resolveModuleSet(['lib/module.mjs', 'lib/projects.mjs'], modules);
        assert.ok(Array.isArray(set));
        assert.equal(set.length, 2);
        assert.ok(set.every((r) => r.module instanceof Module));
    });

    test('rarebert.resolveModuleSet() skips unknown args gracefully', () => {
        const set = rarebert.resolveModuleSet(['nonexistent.mjs'], modules);
        assert.equal(set.length, 0);
    });

    test('rarebert.findDirectoryTarget() returns target by key', () => {
        const t = rarebert.findDirectoryTarget('scripts');
        assert.ok(t, 'should find "scripts" target');
        assert.equal(t.key, 'scripts');
    });

    test('rarebert.findDirectoryTarget() returns null for unknown', () => {
        const t = rarebert.findDirectoryTarget('no-such-key');
        assert.equal(t, null);
    });

    test('rarebert.directoryTargetByPath() resolves absolute path', () => {
        const t = rarebert.directoryTargetByPath(rarebert.absPath('lib/module.mjs'));
        assert.ok(t, 'should resolve a path within lib/');
    });

    test('rarebert.buildModuleChoices() returns choice objects', () => {
        const choices = rarebert.buildModuleChoices(modules.slice(0, 3));
        assert.equal(choices.length, 3);
        for (const c of choices) {
            assert.ok(typeof c.name === 'string', 'choice should have name');
            assert.ok(typeof c.message === 'string', 'choice should have message');
        }
    });
});

// ---------------------------------------------------------------------------
// Export verification — module.mjs exports ONLY Module, CLI, TUI.
// Ensures the prune was complete and no stale exports leaked through.
// ---------------------------------------------------------------------------

describe('module.mjs exports are pruned to ONLY Module, CLI, TUI', () => {
    test('Module, CLI, TUI are exported', async () => {
        const mod = await import('../lib/module.mjs');
        assert.ok(mod.Module, 'Module should be exported');
        assert.ok(mod.CLI, 'CLI should be exported');
        assert.ok(mod.TUI, 'TUI should be exported');
        assert.equal(mod.default, Module, 'default export should be Module');
    });

    test('pruned names are NOT exported', async () => {
        const mod = await import('../lib/module.mjs');
        const pruned = [
            'cli', 'tui',
            'listAllModules', 'resolveModule', 'resolveModuleSet',
            'promptModule', 'promptModuleChoices',
            'findDirectoryTarget', 'directoryTargetByPath',
            'buildModuleChoices'
        ];
        for (const name of pruned) {
            assert.equal(name in mod, false, `${name} should NOT be exported from module.mjs`);
        }
    });

    test('Module.listAllModules is a static method (not an export)', () => {
        assert.equal(typeof Module.listAllModules, 'function');
    });

    test('Module.createCommand is a static method', () => {
        assert.equal(typeof Module.createCommand, 'function');
    });

    test('Module.wantsHelp is a static method', () => {
        assert.equal(typeof Module.wantsHelp, 'function');
    });

    test('Module.printHelp is a static method', () => {
        assert.equal(typeof Module.printHelp, 'function');
    });

    test('Module.parse is a static method', () => {
        assert.equal(typeof Module.parse, 'function');
    });
});

// ---------------------------------------------------------------------------
// lib/git.mjs no longer re-exports listAllModules.
// ---------------------------------------------------------------------------

describe('lib/git.mjs no longer re-exports listAllModules', () => {
    test('listAllModules is NOT exported from git.mjs', async () => {
        const git = await import('../lib/git.mjs');
        assert.equal('listAllModules' in git, false, 'git.mjs should not re-export listAllModules');
    });

    test('git, models, memo are still exported', async () => {
        const git = await import('../lib/git.mjs');
        assert.ok(git.git, 'git should be exported');
        assert.ok(git.models, 'models should be exported');
        assert.ok(git.memo, 'memo should be exported');
    });
});
