#!/usr/bin/env node
// ---------------------------------------------------------------------------
// status.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: an interactive staged review of project + git state.
// Built the flow AT IMPORT TIME: a single shared Interface ('status') was
// constructed at module scope, five stage TUIs were instantiated as top-level
// consts (each a TUI submodule whose main returned exit(0) to advance the
// chain, exit('exit') to terminate, or exit(n)), and the default export was a
// TUI whose main returned exit(Interface.createInterface('status')
// .stage(...).stage(...) — a five-stage chain:
//   1. stageProjectDiscovery — table of rarebert.discover() folders + their
//      discovered modules (rarebert.discoverModules)
//   2. stageGitStatus — git.statusSummary()
//   3. stageGitDiff — git.diffSummary() (colour; "(no uncommitted changes)"
//      when clean)
//   4. stageBranchRemote — git.branchInfo() (branch/upstream/aheadBehind) +
//      git.remoteInfo()
//   5. stageLaunchEdit — interactive confirm to spawn scripts/edit.ts via
//      spawnSync(process.execPath, [editScript]) with stdio inherit; skipped
//      non-interactively
// Each stage ended with promptContinue() (select:'Continue?' → next stage or
// exit to shell).
//
// Non-interactive entry: `--debug` printed the project-folder listing, git
// status summary, and branch/remote info (printDebugListing) and exited 0.
//
// CLI surface (original meta):
//   usage: 'node index.js status [--debug]'
//   options:
//     --debug — print prod-ready project discovery listing and exit
//
// NOTE: this was a TUI/flow module (default export was a TUI instance, not a
// CLI, and Interface stages were constructed at import time). This stub
// standardizes the file on the plain CLI shape (CLI + exit(new Error(...)))
// so every scripts/ file presents the same surface to discovery/launch; the
// staged-flow behavior above is retained only in this record. Had no other
// module importing from it. Dependencies: TUI/Interface, isInteractive,
// rarebert/home, git (lib/git.ts), spawnSync, exit (lib/core.ts).
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'status',
    description:
        'Show project folders and modules, then git status/diff/branch/remote, and optionally launch edit — interactive staged review (unimplemented)',
    usage: 'node index.js status [--debug]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('status: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('status.ts', main, meta).supportsDirectRunning();
export { main, meta };
