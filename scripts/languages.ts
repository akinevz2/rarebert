#!/usr/bin/env node
// ---------------------------------------------------------------------------
// languages.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: a toolkit for the supported module languages (the
// templates that power module scaffolding, kept under lib/supports/). With no
// subcommand (or `list`/`--list`) it printed the installed language list via
// languages.show(). With `install <lang> [--force]` it drove installFromArgs:
// resolve/validate the language ext, confirm overwrite if already installed
// (declining politely in non-interactive runs), then
// languages.install(name, { force }) and a summary printout (template path,
// line count, section keys). Interactive fallback installNewLanguage prompted
// for a language name and confirmed overwrite via an Interface.
//
// CLI surface (original meta):
//   usage: 'node index.js languages [install <lang> [--force]]'
//   options:
//     --force — overwrite an existing template
//   (no positional args were declared in meta; `install` was dispatched by
//   inspecting positional[0] in main)
//
// Exports beyond the default (helper functions imported elsewhere at the
// time): chooseLanguage (interactive language select used by add.ts /
// project.ts; guarded by isInteractive → nonInteractive), installNewLanguage
// (interactive install), installFromArgs (opts/positional-driven install).
// Their only importers were add.ts and project.ts, both stubbed in the same
// slim-down, so no compat re-exports are preserved here.
// Dependencies: TUI/Interface, Module terminal helpers, languages
// (lib/runtime/Language.ts), exit (core.ts).
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'languages',
    description:
        'Install or list supported module languages (templates under lib/supports/) (unimplemented)',
    usage: 'node index.js languages [install <lang> [--force]]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('languages: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('languages.ts', main, meta).supportsDirectRunning();
export { main, meta };
