#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exit } from '../lib/core.mjs';
import { cli, CLI, TUI, Interface } from '../lib/module.mjs';
import { home } from '../lib/projects.mjs';
import { Git } from '../lib/git.mjs';
import { languages } from '../lib/languages.mjs';
import { ide } from '../lib/ide.mjs';
import { models } from '../lib/models.mjs';

// REQUEST: updateSelf and updateLanguage functions need cleanup on ctrl-c.
// updateSelf: No cleanup needed - git operations are atomic.
// updateLanguage: On ctrl-c during opencode run, allow current response to complete.
// Meta suggestion for updateSelf: { retryOnFailure: false, cleanup: 'none' }
// Meta suggestion for updateLanguage: { retryOnFailure: false, cleanup: 'none' }

const SUPPORT_TEMPLATE_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'lib',
    'supports',
    'template.json'
);

function labelForExt(ext) {
    const map = { ts: 'TypeScript', js: 'JavaScript', mjs: 'ESM JavaScript', py: 'Python' };
    return map[ext] ?? ext.toUpperCase();
}

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

async function updateLanguage(langArg, options = {}) {
    const name = languages.parseExt(langArg).toLowerCase();
    const ext = name;
    const jsPath = languages.jsSupportPathFor(ext);
    const label = labelForExt(ext);

    if (fs.existsSync(jsPath) && !options.force) {
        console.error(
            `update language: ${home.relPath(jsPath)} already exists (use --force to overwrite)`
        );
        return exit(1);
    }

    const langIdent = name.charAt(0).toUpperCase() + name.slice(1);
    const content = loadSupportTemplate({ LANG: langIdent, EXT: ext, LANG_LABEL: label });

    fs.mkdirSync(path.dirname(jsPath), { recursive: true });
    fs.writeFileSync(jsPath, content);
    const rel = home.relPath(jsPath);
    console.log(`✓ scaffolded language support: ${rel}`);

    languages.instanceCache.delete(name);

    const model = options.model ? await models.resolve(options.model) : models.resolveDefault();
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
4. ${langIdent}ExtractBindings(content) — extract { exports, imports }.

Reference the existing support modules:
  lib/supports/langmjs.js, langjs.js, langpy.js.

Edit only ${rel}. Keep the Template lines/sections and Language export intact.`;

        const { status, stdout } = ide.spawnHeadless(instruction, model);
        if (status !== 0)
            console.error(`update language: opencode run exited with status ${status}`);
        if (stdout) console.log(stdout);
    } else {
        console.log('\nNo model resolved; skipping opencode implementation pass.');
        console.log(`Edit ${rel} to fill in the TODO parser stubs.`);
    }

    console.log(`\nNext: \`make check\` to verify, then \`make analyze ${rel}\` to document.`);
    return exit(0);
}

const meta = {
    name: 'update',
    description:
        'Update rarebert: `update self` fetches and merges origin into the local install branch; `update language <lang>` scaffolds a new lib/supports/lang{ext}.js support module for an additional language.',
    usage: 'node index.js update <self|language> [lang] [--force] [--model <id>]',
    options: [
        { flag: '--force', description: 'overwrite an existing language support module' },
        {
            flag: '-m, --model <id>',
            description: 'opencode model for generating the support module'
        }
    ]
};

export { meta, updateSelf, updateLanguage, loadSupportTemplate, labelForExt };

export default new CLI(
    'update.mjs',
    async (opts = {}, positional = []) => {
        const args = Array.isArray(positional) ? positional : [];
        const sub = args[0];

        if (sub === 'self') return updateSelf();

        if (sub === 'language') {
            const langArg = args[1];
            if (!langArg) {
                console.error(
                    'Usage: node index.js update language <lang> [--force] [--model <id>]'
                );
                return exit(1);
            }
            return updateLanguage(langArg, { force: !!opts.force, model: opts.model });
        }

        if (!cli.isInteractive()) {
            console.error(
                'Usage: node index.js update <self|language> [lang] [--force] [--model <id>]'
            );
            return exit(1);
        }

        return exit(
            new TUI(
                'update.mjs',
                async (opts, positional) => {
                    const iface = Interface.createInterface('update');
                    const choice = await iface.select('What would you like to update?', [
                        { name: 'self', message: 'rarebert itself — fetch + merge origin' },
                        {
                            name: 'language',
                            message: 'a language — scaffold support for a new language'
                        }
                    ]);

                    if (choice === 'self') return updateSelf();

                    const langInput = await iface.input('Language to add (e.g. ts, rb, go):', {
                        validate: (v) => (v.trim() ? true : 'Language is required')
                    });
                    return updateLanguage(langInput, { force: !!opts.force, model: opts.model });
                },
                meta
            )
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
