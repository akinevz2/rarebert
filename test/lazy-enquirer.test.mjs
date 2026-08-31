import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guards for two implemented checks:
//
// 1. Interface CLI-runtime guard — constructing an Interface from a CLI
//    runtime returns exit() (a nonInteractive ExitSignal) instead of an
//    instance; behaviour tests live in interface.test.mjs.
//
// 2. Lazy enquirer loading — mirroring how createCommand(meta) pulls in
//    commander at runtime, enquirer may only be imported dynamically
//    inside TUI class-member methods (via createInterface()) or the
//    standalone promptModuleChoices helper. lib/module.mjs must never
//    statically import it.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(ROOT, 'lib', 'module.mjs'), 'utf-8');

describe('lazy enquirer loading (lib/module.mjs)', () => {
    test('no static enquirer import at module scope', () => {
        assert.doesNotMatch(source, /from\s+'enquirer'/);
        assert.doesNotMatch(source, /require\(\s*'enquirer'\s*\)/);
    });

    test('every enquirer specifier is a dynamic import(…)', () => {
        const specifiers = [...source.matchAll(/['"]enquirer['"]/g)];
        assert.ok(specifiers.length > 0, 'module.mjs should reference enquirer');
        for (const match of specifiers) {
            const before = source.slice(Math.max(0, match.index - 24), match.index).trimEnd();
            assert.match(
                before,
                /import\($/,
                `enquirer specifier at offset ${match.index} is not a dynamic import`
            );
        }
    });

    test('TUI.createInterface is the lazy loader the prompt methods use', () => {
        assert.match(
            source,
            /async createInterface\(\)\s*\{\s*const \{ default: Enquirer \} = await import\('enquirer'\);/
        );
        const uses = [...source.matchAll(/this\.createInterface\(\)/g)].length;
        assert.ok(uses >= 3, 'confirm/input/select must load enquirer via createInterface()');
    });
});
