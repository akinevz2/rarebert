#!/usr/bin/env node
// ---------------------------------------------------------------------------
// install.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: installed rarebert from the repo by driving npm.
// Defaults: npm prefix ~/.local/share/rarebert, binary symlink ~/.local/bin.
// Resolved the prefix (--prefix) and bin dir (--bin-dir), then either ran the
// install directly (force, or empty target) or, if the prefix was non-empty,
// returned exit(new TUI(...)) escalating to an interactive Interface flow that
// confirmed the overwrite before proceeding.
//
// Install steps (performInstall): mkdir the prefix, spawn
// `npm install --prefix <dir> --ignore-scripts` from the repo root with
// stdio inherit, then symlink <repo>/index.js as "<binDir>/rarebert",
// reporting whether the bin dir is already on PATH. Finished with an
// onboarding step (backend.ensureConfig()), suggesting `make onboard` if the
// config wasn't ready.
//
// CLI surface (original meta):
//   usage: 'node index.js install [--prefix <dir>] [--bin-dir <dir>] [--force]'
//   options:
//     --prefix <dir>  — npm prefix to install into
//     --bin-dir <dir> — directory for the rarebert symlink (default: ~/.local/bin)
//     --force         — overwrite an existing prefix directory
//
// Exports beyond the default: performInstall (the install driver) — had no
// importers among surviving modules. Dependencies: home (Project), TUI/
// Interface, backend, exit (core.ts), fs/os/path/child_process.
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'install',
    description:
        'Install rarebert: npm prefix defaults to ~/.local/share/rarebert, binary symlinked into ~/.local/bin (unimplemented)',
    usage: 'node index.js install [--prefix <dir>] [--bin-dir <dir>] [--force]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('install: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('install.ts', main, meta).supportsDirectRunning();
export { main, meta };
