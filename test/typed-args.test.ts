import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Arguments, CLI, defineMeta } from '../lib/runtime/CLI.ts';
import type { Args } from '../lib/runtime/CLI.ts';

// The zod-backed argv engine (successor to Commander's createCommand/
// parseArgv). One permanent scenario per Commander-parity behavior the
// live modules rely on, plus the Arguments contract shared by every main.

const metaBase = defineMeta({
    name: 'probe',
    description: 'probe',
    options: [
        { flag: '-m, --model <id>', description: 'model id' },
        { flag: '--verbose', description: 'verbose' },
        { flag: '--no-memos', description: 'disable memos' },
        { flag: '--skip-integrity', description: 'skip integrity' },
        { flag: '--trace <name>', description: 'trace' }
    ]
});
void metaBase;


describe('argv engine (CLI.parseModuleArgv — Command/er parity)', () => {
    test('composite short + value, boolean, negation default, kebab→camel', () => {
        const p = CLI.parseModuleArgv(metaBase, ['-m', 'glm:9b', '--verbose', '--skip-integrity']);
        assert.deepEqual(p.positional, []);
        assert.equal(p.opts.model, 'glm:9b');
        assert.equal(p.opts.verbose, true);
        assert.equal(p.opts.memos, true); // negation default: true
        assert.equal(p.opts.skipIntegrity, true); // camelCase key
        assert.equal(p.opts.trace, undefined);
    });

    test('--flag=value and --no-x flip the negated default', () => {
        const p = CLI.parseModuleArgv(metaBase, ['--model=glm:9b', '--no-memos']);
        assert.equal(p.opts.model, 'glm:9b');
        assert.equal(p.opts.memos, false);
    });

    test('short attached value (-mvalue); value-taking short at argv end errors', () => {
        const p = CLI.parseModuleArgv(metaBase, ['-mglm:9b', '/dev/null']);
        assert.equal(p.opts.model, 'glm:9b');
        assert.throws(
            () => CLI.parseModuleArgv(metaBase, ['-m']),
            /argument missing/
        );
    });

    test('-- terminator makes everything after it verbatim positional', () => {
        const p = CLI.parseModuleArgv(metaBase, ['--', '--model', '-x', 'a b c']);
        assert.deepEqual(p.positional, ['--model', '-x', 'a b c']);
        assert.equal(p.opts.model, undefined);
    });

    test('allowUnknownOption: unknown flags + values stay verbatim in positional (memo contract)', () => {
        const meta = defineMeta({
            name: 'memo',
            description: '',
            allowUnknownOption: true,
            options: [{ flag: '--fresh', description: '' }]
        });
        const p = CLI.parseModuleArgv(meta, ['--add', 'analyze', '--fresh', 'log text', '-q']);
        assert.deepEqual(p.positional, ['--add', 'analyze', 'log text', '-q']);
        assert.equal(p.opts.fresh, true);
    });

    test('unknown option rejects with the Commander message shape', () => {
        assert.throws(
            () => CLI.parseModuleArgv(metaBase, ['--known']),
            /error: unknown option '--known'/
        );
        assert.throws(
            () => CLI.parseModuleArgv(metaBase, ['-z']),
            /error: unknown option '-z'/
        );
        assert.throws(
            () => CLI.parseModuleArgv(metaBase, ['--trace']),
            /error: option '--trace <name>' argument missing/
        );
    });

    test('required positional enforcement', () => {
        const meta = defineMeta({
            name: 'm',
            description: '',
            args: [{ name: 'target', required: true }],
            options: []
        });
        const p = CLI.parseModuleArgv(meta, ['x']);
        assert.deepEqual(p.positional, ['x']);
        assert.throws(
            () => CLI.parseModuleArgv(meta, []),
            /error: missing required argument 'target'/
        );
    });

    test('allowUnknownOption gate: without it unknown flags reject', () => {
        const meta = defineMeta({
            name: 'm',
            description: '',
            args: [{ name: 'target', required: true }],
            options: []
        });
        assert.throws(
            () => CLI.parseModuleArgv(meta, ['x', '--unknown-flag', 'y']),
            /error: unknown option '--unknown-flag'/
        );
        const tolerant = defineMeta({ ...meta, allowUnknownOption: true });
        const p = CLI.parseModuleArgv(tolerant, ['x', '--unknown-flag', 'y']);
        assert.equal(p.positional.length, 3);
    });

    test('int/float/array/choices coercion, defaults, invalid-value complaints', () => {
        const meta = defineMeta({
            name: 'k',
            description: '',
            options: [
                { flag: '--depth <n>', type: 'int', default: 3 },
                { flag: '--rate <r>', type: 'float' },
                { flag: '--tags <csv>', type: 'array' },
                { flag: '--mode <m>', choices: ['json', 'markdown'] },
                { flag: '--repeat <t>', type: 'array', default: [] }
            ]
        });
        const p = CLI.parseModuleArgv(meta, [
            '--depth', '7', '--rate', '0.5', '--tags', 'a, b', '--mode', 'json'
        ]);
        assert.equal(typeof p.opts.depth, 'number');
        assert.equal(p.opts.depth, 7);
        assert.equal(p.opts.rate, 0.5);
        assert.deepEqual(p.opts.tags, ['a', 'b']);
        assert.equal(p.opts.mode, 'json');
        assert.throws(
            () => CLI.parseModuleArgv(meta, ['--mode', 'yaml']),
            /Must be one of: json, markdown/
        );
        assert.throws(
            () => CLI.parseModuleArgv(meta, ['--depth', 'abc']),
            /Must be an integer/
        );
        const absent = CLI.parseModuleArgv(meta, []);
        assert.equal(absent.opts.depth, 3); // meta default
        assert.deepEqual(absent.opts.repeat, []);
    });

    test('helpText renders usage, description, Options and Arguments blocks', () => {
        const p = CLI.parseModuleArgv(metaBase, []);
        assert.ok(p.helpText.startsWith('Usage: probe [options]'));
        assert.ok(p.helpText.includes('Options:'));
        assert.ok(p.helpText.includes('-m, --model <id>'));
        assert.ok(p.helpText.includes('--no-memos'));
    });
});

describe('Arguments (parsed main-callback contract)', () => {
    test('is an Array subclass of the positional args with opts merged', () => {
        const parsed = CLI.parseModuleArgv(metaBase, ['file1', 'file2', '--verbose']);
        // The typed seam: `Args<M>` is the Arguments contract ∩ the meta's
        // declared opts, so `args.verbose` is checked against metaBase.
        const args = Arguments.fromInvocation(parsed, parsed.positional) as Args<typeof metaBase>;
        assert.ok(args instanceof Arguments);
        assert.ok(Array.isArray(args));
        assert.equal(args.length, 2);
        assert.equal(args[0], 'file1');
        assert.equal(args[1], 'file2');
        assert.equal(args.verbose, true); // merged opts
        assert.equal(args.model, undefined);
        assert.deepEqual(args.opts, { verbose: true, memos: true });
    });

    test('has(flag) checks raw argv; help() returns the rendered help', () => {
        const parsed = CLI.parseModuleArgv(metaBase, ['file1', '--verbose']);
        const args = Arguments.fromInvocation(parsed, parsed.positional) as Args<typeof metaBase>;
        assert.equal(args.has('--verbose'), true);
        assert.equal(args.has('--model'), false);
        assert.equal(args.has('--nope'), false);
        assert.equal(args.help(), parsed.helpText);
    });

    test('empty positional yields an empty Arguments with opts merged', () => {
        const parsed = CLI.parseModuleArgv(metaBase, ['--verbose']);
        const args = Arguments.fromInvocation(parsed, parsed.positional) as Args<typeof metaBase>;
        assert.equal(args.length, 0);
        assert.equal(args.verbose, true);
    });
});
