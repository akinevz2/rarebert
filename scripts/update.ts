#!/usr/bin/env node
// ---------------------------------------------------------------------------
// update.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: two subcommands under one module, dispatched by
// positional[0], plus an interactive select fallback when run without a
// subcommand on a TTY:
//   - `update self` → updateSelf(): guarded by a clean-tree check
//     (statusPorcelain on the install repo — refused when dirty), printed
//     branch/upstream/aheadBehind (branchInfo), then
//     `git fetch origin` + `git merge --ff-only origin/<branch>` via the Git
//     class, with explicit error reports (exit 1) on fetch failure and on
//     non-fast-forward merge (advising a manual pull/rebase).
//   - `update language <lang>` → updateLanguage(lang, { force, model }):
//     resolved the language ext (languages.parseExt), refused to overwrite
//     an existing lib/supports/lang<ext>.js without --force, then scaffolded
//     it from lib/supports/template.json.
//   - bare invocation (TTY only) → Interface select between the two targets,
//     then an input prompt for the language name when updating a language.
//
// loadSupportTemplate(vars) was the shared template renderer: it read
// lib/supports/template.json (keyed chunks: header, imports, linesObject,
// sectionsArray, templateCtor, parseImports, extractMain, extractMembers,
// extractBindings, languageInstance, exports in that fixed order) and
// substituted {{KEY}} placeholders. labelForExt(map) mapped ext → display
// label (ts: 'TypeScript', js: 'JavaScript', mjs: 'ESM JavaScript',
// py: 'Python'). The language flow optionally ran a headless opencode pass
// (spawnHeadless) to fill in the four TODO parser stubs, then suggested
// `make check` + `make analyze`.
//
// CLI surface (original meta):
//   usage: 'node index.js update <self|language> [lang] [--force]
//           [--model <id>]'
//   options:
//     --force           — overwrite an existing language support module
//     -m, --model <id>  — opencode model for generating the support module
//
// Exports beyond the default: updateSelf, updateLanguage, loadSupportTemplate,
// labelForExt. The only external importer was add.ts (loadSupportTemplate),
// stubbed in the same pass, so no compat exports are preserved here.
// Dependencies: home, Git, languages, ide, models, TUI/Interface,
// isInteractive, exit (core.ts), fs/path/url.
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'update',
    description:
        'Update rarebert: `update self` fetches and merges origin into the local install branch; `update language <lang>` scaffolds a new lib/supports/lang{ext}.js support module for an additional language. (unimplemented)',
    usage: 'node index.js update <self|language> [lang] [--force] [--model <id>]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('update: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('update.ts', main, meta).supportsDirectRunning();
export { main, meta };
