#!/usr/bin/env node
// ---------------------------------------------------------------------------
// project.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: a thin wrapper over the languages toolkit, scoped to
// "choose or install a module language before scaffolding a destination
// file". Subcommand dispatch on positional[0]:
//   - (none) | list | --list → languages.show({ label: 'project' })
//   - install [lang]         → installFromArgs(opts, positional.slice(1))
//                              (re-exported from languages.ts)
//   - choose                 → chooseLanguage() (from languages.ts), printing
//                              the chosen language to stdout
//   - anything else          → exit('Unknown subcommand: <sub>')
//
// CLI surface (original meta):
//   usage: 'node index.js project [list | install <lang> | choose]'
//   options:
//     --force — overwrite an installed template
//
// Its imports of chooseLanguage/installFromArgs from scripts/languages.ts
// were the only cross-module imports in the slim-down set; add.ts also
// imported chooseLanguage from there. Both importers were stubbed in the
// same pass, so no compat exports are preserved here.
// Dependencies: exit (lib/core.ts), languages (lib/runtime/Language.ts),
// CLI (lib/runtime/CLI.ts).
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'project',
    description:
        'Choose or install a module language before scaffolding a destination file (unimplemented)',
    usage: 'node index.js project [list | install <lang> | choose]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('project: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('project.ts', main, meta).supportsDirectRunning();
export { main, meta };
