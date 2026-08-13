#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { home, rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { Git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';
import { languages } from '../lib/languages.mjs';
import { ide } from '../lib/ide.mjs';
import { models } from '../lib/models.mjs';
import { Module } from '../lib/modules.mjs';

const SUPPORT_TEMPLATE_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'lib',
    'support-template.json'
);

const meta = {
    name: 'update',
    description:
        'Update rarebert: `update self` fetches and merges origin into the local install branch; `update language <lang>` scaffolds a new lib/supports/lang{ext}.js support module for an additional language.',
    usage: 'node index.js update <self|language> [lang] [--force] [--model <id>]',
    options: [
        { flag: '--force', description: 'overwrite an existing language support module' },
        { flag: '--model <id>', description: 'opencode model for generating the support module' }
    ]
};

// ---------------------------------------------------------------------------
// self: fetch + merge origin/<branch> into the rarebert install
// ---------------------------------------------------------------------------

/**
 * Fetch from origin and fast-forward merge into the current branch of
 * the rarebert *install* (home.root), not the user's current project.
 * This mirrors upgrades.mjs — which diffs a project against origin —
 * but pulls changes into the local install so new rarebert features
 * land without a separate `git pull` in the install dir.
 *
 * Refuses on a dirty working tree so the merge doesn't clobber local
 * edits. Reports ahead/behind before merging.
 */
function updateSelf() {
    const installGit = new Git(home.root);

    const dirty = installGit.statusPorcelain();
    if (dirty.length > 0) {
        console.error('update self: install working tree is dirty; commit or stash first.');
        console.error(installGit.statusSummary());
        return exit(1);
    }

    const { branch, upstream, aheadBehind } = installGit.branchInfo();
    console.log(`install:   ${home.root}`);
    console.log(`branch:    ${branch}`);
    console.log(`upstream:  ${upstream}`);
    console.log(`ahead/behind: ${aheadBehind}`);

    const fetchResult = installGit.git('fetch', ['origin'], { stdio: 'inherit' });
    if (!fetchResult.ok) {
        console.error(`update self: git fetch origin exited with status ${fetchResult.status}`);
        return exit(1);
    }
    console.log('✓ fetched origin');

    const mergeRef = `origin/${branch}`;
    const mergeResult = installGit.git('merge', ['--ff-only', mergeRef], { stdio: 'inherit' });
    if (!mergeResult.ok) {
        console.error(
            `update self: git merge --ff-only ${mergeRef} exited with status ${mergeResult.status}`
        );
        console.error(
            'update self: non-fast-forward; run `git pull` or `git rebase` manually to resolve.'
        );
        return exit(1);
    }

    console.log(`✓ updated ${branch} to ${mergeRef}`);
    return exit(0);
}

// ---------------------------------------------------------------------------
// language: scaffold a new lib/supports/lang{ext}.js support module
// ---------------------------------------------------------------------------

/**
 * Load the support-module scaffold template from its JSON sidecar and
 * substitute `{{LANG}}` / `{{EXT}}` / `{{LANG_LABEL}}`. Keeping the
 * template out of update.mjs avoids the binding extractor mistaking
 * the template's `import` lines for real imports of this module.
 */
function loadSupportTemplate(vars) {
    const raw = JSON.parse(fs.readFileSync(SUPPORT_TEMPLATE_PATH, 'utf-8'));
    const order = [
        'header',
        'imports',
        'linesObject',
        'sectionsArray',
        'templateCtor',
        'parseImports',
        'extractMain',
        'extractMembers',
        'extractBindings',
        'languageInstance',
        'exports'
    ];
    let out = '';
    for (const key of order) {
        let chunk = raw[key] ?? '';
        for (const [k, v] of Object.entries(vars)) {
            chunk = chunk.replaceAll(`{{${k}}}`, v);
        }
        out += chunk + '\n';
    }
    return out;
}

/**
 * Scaffold a JS language-support module at lib/supports/lang{ext}.js
 * inside the rarebert install (home.root). The built-in JS support
 * modules take precedence over JSON templates in the languages
 * registry, so writing one here is the canonical way to add full
 * analysis support for a new language.
 *
 * After scaffolding, an opencode headless pass fills in the TODO parser
 * bodies. If the language already has a JS support module and --force
 * is not set, refuse.
 */
async function updateLanguage(langArg, options = {}) {
    const name = languages.parseExt(langArg).toLowerCase();
    const ext = name;
    const jsPath = languages.jsSupportPathFor(ext);
    const label = labelForExt(ext);

    // jsSupportPathFor resolves against home.supportsDir (the install),
    // which is what we want — language support ships with rarebert.
    if (fs.existsSync(jsPath) && !options.force) {
        console.error(
            `update language: ${home.relPath(jsPath)} already exists (use --force to overwrite the JS support module)`
        );
        return exit(1);
    }

    // Build a camelCase identifier prefix from the extension:
    // ts -> Ts, rb -> Rb, go -> Go, dotnet -> Dotnet.
    const langIdent = name.charAt(0).toUpperCase() + name.slice(1);

    const content = loadSupportTemplate({
        LANG: langIdent,
        EXT: ext,
        LANG_LABEL: label
    });

    fs.mkdirSync(path.dirname(jsPath), { recursive: true });
    fs.writeFileSync(jsPath, content);
    const rel = home.relPath(jsPath);
    console.log(`✓ scaffolded language support: ${rel}`);

    // Warm the registry cache so the new language is immediately visible.
    languages.instanceCache.delete(name);

    // Run an opencode headless pass to implement the TODO parsers.
    const modelArg = options.model;
    const model = await models.resolve(modelArg);
    if (model) {
        console.log(`\nImplementing ${label} parsers via opencode (model: ${model})...`);
        const instruction = `You are implementing a language-support module for rarebert.

The file ${rel} was just scaffolded with TODO stubs for four analysis
functions. Implement each one for ${label} (.${ext}):

1. ${langIdent}ParseImports(content) — parse ${label} import statements and
   return notated strings using the notation documented in the file header.
2. ${langIdent}ExtractMainFunction(content) — locate the main() function body
   and return { startLine, endLine, bodyLines } or null.
3. ${langIdent}ExtractPublicMembers(content) — extract exported top-level
   members as { name, kind, startLine, endLine, lines }[].
4. ${langIdent}ExtractBindings(content) — extract { exports, imports } where
   exports is { [name]: { line, type } } and imports is
   [ { binding, localName, source, line, kind } ].

Reference the existing support modules for the expected shapes:
  lib/supports/langmjs.js (ESM JS), lib/supports/langjs.js (CommonJS),
  lib/supports/langpy.js (Python).

Edit only ${rel}. Keep the Template lines/sections and the Language
instance export shape intact. Do not change the import notation scheme.`;

        const { status, stdout } = ide.spawnHeadless(instruction, model);
        if (status !== 0) {
            console.error(`update language: opencode run exited with status ${status}`);
        }
        if (stdout) console.log(stdout);
    } else {
        console.log('\nNo model resolved; skipping opencode implementation pass.');
        console.log(`Edit ${rel} to fill in the TODO parser stubs.`);
    }

    console.log(`\nNext: \`make check\` to verify, then \`make analyze ${rel}\` to document.`);
    return exit(0);
}

function labelForExt(ext) {
    const map = { ts: 'TypeScript', js: 'JavaScript', mjs: 'ESM JavaScript', py: 'Python' };
    return map[ext] ?? ext.toUpperCase();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(opts = {}, positional = []) {
    const args = Array.isArray(positional) ? positional : [];
    const sub = args[0];

    if (sub === 'self') {
        return updateSelf();
    }

    if (sub === 'language') {
        const langArg = args[1];
        if (!langArg) {
            console.error('Usage: node index.js update language <lang> [--force] [--model <id>]');
            return exit(1);
        }
        return updateLanguage(langArg, { force: !!opts.force, model: opts.model });
    }

    // No subcommand: interactive dispatch.
    if (!cli.isInteractive()) {
        console.error('Usage: node index.js update <self|language> [lang] [--force] [--model <id>]');
        return exit(1);
    }

    const choice = await cli.select('What would you like to update?', [
        { name: 'self', message: 'rarebert itself — fetch + merge origin' },
        { name: 'language', message: 'a language — scaffold support for a new language' }
    ]);

    if (choice === 'self') return updateSelf();

    const langInput = await cli.input('Language to add (e.g. ts, rb, go):', {
        validate: (v) => (v.trim() ? true : 'Language is required')
    });
    return updateLanguage(langInput, { force: !!opts.force, model: opts.model });
}

export { updateSelf, updateLanguage, main };

const module = new Module('update.mjs', main, meta);
export default module;
module.supportsDirectRunning(import.meta.url);