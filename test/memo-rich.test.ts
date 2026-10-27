import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseMemoContent,
    renderMemoEntry,
    memoEntryKey,
    memoShapes
} from '../lib/memo.ts';

// Rich memos: pre-definable, reusable memo shapes interleaved with plain
// string memos in a sidecar's content array.

describe('rich memos: parseMemoContent', () => {
    test('@see-line(<line>, <issue>) parses into a ShapeEntry', () => {
        const entry = parseMemoContent('@see-line(42, race in flush ordering)');
        assert.deepEqual(entry, { shape: 'see-line', line: 42, issue: 'race in flush ordering' });
    });

    test('final string field consumes remaining args verbatim (commas re-joined)', () => {
        const entry = parseMemoContent('@smell(7, long function, no early exit, duplicated logic)');
        assert.deepEqual(entry, {
            shape: 'smell',
            line: 7,
            smell: 'long function, no early exit, duplicated logic'
        });
    });

    test('plain strings pass through untouched', () => {
        assert.equal(parseMemoContent('always flush memos before process exit'), 'always flush memos before process exit');
    });

    test('unknown shape keeps the authored text verbatim', () => {
        assert.equal(parseMemoContent('@nope(1, mystery)'), '@nope(1, mystery)');
    });

    test('arity mismatch keeps the authored text verbatim', () => {
        assert.equal(parseMemoContent('@see-line(not-a-number, issue)'), '@see-line(not-a-number, issue)');
        assert.equal(parseMemoContent('@see-line()'), '@see-line()');
    });
});

describe('rich memos: renderMemoEntry', () => {
    test('shape entry renders through the registry formatter', () => {
        assert.equal(
            renderMemoEntry({ shape: 'see-line', line: 42, issue: 'race in flush ordering' }),
            'line 42: race in flush ordering'
        );
    });

    test('plain string renders as itself', () => {
        assert.equal(renderMemoEntry('plain memo'), 'plain memo');
    });

    test('object entry with unknown shape falls back to JSON', () => {
        assert.equal(
            renderMemoEntry({ shape: 'unknown-shape', x: 1 }),
            '{"shape":"unknown-shape","x":1}'
        );
    });
});

describe('rich memos: memoEntryKey (canonical dedup)', () => {
    test('key order is irrelevant for shape entries', () => {
        assert.equal(
            memoEntryKey({ shape: 'see-line', line: 42, issue: 'x' }),
            memoEntryKey({ issue: 'x', shape: 'see-line', line: 42 })
        );
    });

    test('different fields produce different keys', () => {
        assert.notEqual(
            memoEntryKey({ shape: 'see-line', line: 42, issue: 'x' }),
            memoEntryKey({ shape: 'see-line', line: 43, issue: 'x' })
        );
    });
});

describe('rich memos: registry', () => {
    test('every registered shape renders its own entries', () => {
        for (const shape of Object.values(memoShapes)) {
            const entry = { shape: shape.id } as Record<string, unknown>;
            for (const field of shape.fields) {
                entry[field.name] = field.type === 'int' ? 1 : field.type === 'float' ? 1.5 : 'text';
            }
            assert.ok(typeof renderMemoEntry(entry) === 'string');
            assert.ok(renderMemoEntry(entry).length > 0);
        }
    });
});
