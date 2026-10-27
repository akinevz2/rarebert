#!/usr/bin/env node
// ---------------------------------------------------------------------------
// add.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: interactive scaffolding of a new module. The user picked
// a project folder (rarebert.discover()), optionally a language for src/
// (delegating to languages.ts#chooseLanguage), and a module name (validated
// with rarebert.normalizeModuleName). src/ modules could also multi-select
// libraries from lib/<lang>/ to build a preamble imports block. After
// scaffolding it git-added everything, spawned the user's editor, then ran a
// one-shot headless opencode implement pass on the new file.
//
// CLI surface (original meta):
//   usage: 'node index.js add [--model <id>] [--force]'
//   options:
//     -m, --model <id>  — opencode model id (overrides the default from
//                         opencode.json)
//     --force           — overwrite an installed language template
//     -l, --language <lang> — create a language-support module
//         (lib/supports/lang<ext>.js): scaffold → editor → one-shot opencode
//         implement → interactive opencode amend, with validation between
//         passes (loadLanguage + parseImports/extractMainFunction/
//         extractPublicMembers/extractBindings smoke checks).
//
// Flow: TUI wrapper → (optional --language workflow) → Interface select for
// project → choose language → prompt module name → scaffold via libs/
// languages templates → boilerplate instructions → git add -A → editor →
// headless opencode run. Notable dependencies: temporary files (.ts), TUI,
// libs (lib/runtime/libs.ts), editor, ide, git, models, languages, backend,
// chooseLanguage (languages.ts), loadSupportTemplate (update.ts).
//
// The module exited via exit(code) from the runtime; its main returned
// exit(new TUI(...)) so the Runtime drove the interactive chain.
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'add',
    description:
        'Scaffold a new module: pick project, pick language, then git add, edit, and run opencode headlessly to implement (unimplemented)',
    usage: 'node index.js add [--model <id>] [--force]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('add: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('add.ts', main, meta).supportsDirectRunning();
export { main, meta };
