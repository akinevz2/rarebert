import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeChainDepths,
    compareDagGroups,
    stronglyConnectedComponents
} from '../lib/depgraph.ts';

// The DAG ordering specification (original memo spec):
//   1. PRIMARY: reference-chain depth, deepest first — modules imported
//      through longer chains print higher.
//   2. SECONDARY: memo age, oldest first.
//   ⇒ the last row printed is always the youngest, least-referenced memo.

describe('depgraph: computeChainDepths (importer-chain metric)', () => {
    test('a chain A→B→C: the lib leaf C is deepest, the top-level script A is 0', () => {
        // importersOf: who imports each node
        const importersOf = new Map([
            ['A', [] as string[]],
            ['B', ['A']],
            ['C', ['B']]
        ]);
        const depths = computeChainDepths(['A', 'B', 'C'], importersOf);
        assert.equal(depths.get('C'), 2);
        assert.equal(depths.get('B'), 1);
        assert.equal(depths.get('A'), 0);
    });

    test('diamond (shared dependency is NOT extra depth): D=2, B=C=1, A=0', () => {
        const importersOf = new Map([
            ['A', [] as string[]],
            ['B', ['A']],
            ['C', ['A']],
            ['D', ['B', 'C']]
        ]);
        const depths = computeChainDepths(['A', 'B', 'C', 'D'], importersOf);
        assert.equal(depths.get('D'), 2);
        assert.equal(depths.get('B'), 1);
        assert.equal(depths.get('C'), 1);
        assert.equal(depths.get('A'), 0);
    });

    test('independent node (nothing imports it) is depth 0', () => {
        const importersOf = new Map([
            ['X', [] as string[]],
            ['B', ['A']],
            ['A', [] as string[]]
        ]);
        const depths = computeChainDepths(['X', 'B', 'A'], importersOf);
        assert.equal(depths.get('X'), 0);
    });

    test('cycles terminate deterministically (mutual import → finite, stable depths)', () => {
        const importersOf = new Map([
            ['A', ['B']],
            ['B', ['A']]
        ]);
        // Longest-path depth is ill-defined inside a cycle; the guard pins
        // a deterministic value (back-edges contribute 0, first-visited
        // member scores via its importer chain). The contract under test:
        // termination + finite, reproducible values.
        const first = computeChainDepths(['A', 'B'], importersOf);
        const second = computeChainDepths(['A', 'B'], importersOf);
        assert.deepEqual([...first.entries()], [...second.entries()]);
        assert.ok(first.get('A')! >= 0 && first.get('B')! >= 0);
        assert.ok(first.get('A')! < 48 && first.get('B')! < 48);
    });
});

describe('depgraph: compareDagGroups (spec ordering)', () => {
    test('depth is the primary key: deeper rows sort first', () => {
        const shallow = { depth: 0, lastModified: 1000 };
        const deep = { depth: 3, lastModified: 9999 };
        assert.ok(compareDagGroups(deep, shallow) < 0); // deep before shallow
        assert.ok(compareDagGroups(shallow, deep) > 0);
    });

    test('age is the secondary key: within a depth, oldest first', () => {
        const older = { depth: 1, lastModified: 1000 };
        const younger = { depth: 1, lastModified: 2000 };
        assert.ok(compareDagGroups(older, younger) < 0);
        assert.ok(compareDagGroups(younger, older) > 0);
    });

    test('full tie → 0 (stable sort preserves emission order)', () => {
        const a = { depth: 2, lastModified: 500 };
        const b = { depth: 2, lastModified: 500 };
        assert.equal(compareDagGroups(a, b), 0);
    });

    test('composite spec sort: deepest top, last row = youngest depth-0', () => {
        // spec scenario: young deep chain must print BEFORE an old shallow root
        const rows = [
            { path: 'old-shallow', depth: 0, lastModified: 1000 },
            { path: 'young-chain-leaf', depth: 2, lastModified: 3000 },
            { path: 'young-chain-root', depth: 0, lastModified: 3000 }
        ];
        const sorted = [...rows].sort(compareDagGroups);
        assert.deepEqual(
            sorted.map((r) => r.path),
            ['young-chain-leaf', 'old-shallow', 'young-chain-root']
        );
        // the spec invariant: last = youngest AND least-referenced
        const last = sorted[sorted.length - 1];
        assert.equal(last.depth, 0);
        assert.equal(last.lastModified, 3000);
    });
});

describe('depgraph: stronglyConnectedComponents', () => {
    test('mutual import is one SCC', () => {
        const importsOf = new Map([
            ['A', ['B']],
            ['B', ['A']],
            ['C', ['B']]
        ]);
        const sccs = stronglyConnectedComponents(['A', 'B', 'C'], importsOf);
        assert.equal(sccs.length, 1);
        assert.deepEqual([...sccs[0]].sort(), ['A', 'B']);
    });

    test('shared dependency is NOT a cycle (diamond has no SCC)', () => {
        const importsOf = new Map([
            ['A', ['B', 'C']],
            ['B', ['D']],
            ['C', ['D']],
            ['D', []]
        ]);
        const sccs = stronglyConnectedComponents(['A', 'B', 'C', 'D'], importsOf);
        assert.equal(sccs.length, 0);
    });

    test('three-node cycle is one SCC of three', () => {
        const importsOf = new Map([
            ['A', ['B']],
            ['B', ['C']],
            ['C', ['A']]
        ]);
        const sccs = stronglyConnectedComponents(['A', 'B', 'C'], importsOf);
        assert.equal(sccs.length, 1);
        assert.equal(sccs[0].length, 3);
    });
});
