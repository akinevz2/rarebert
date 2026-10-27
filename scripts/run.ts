#!/usr/bin/env node
// ---------------------------------------------------------------------------
// run.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: ran a module by name or path reference, defaulting to
// src/main.py. Resolution order in main(opts, positional):
//   - no argument → run src/main.py with node (error out if missing)
//   - explicit .py extension → findPyModule (src/<name>.py or an absolute
//     path), run with python3
//   - explicit .js/.mjs/.ts extension → findJsModule (rarebert-normalized
//     lookup over listAllModules() from lib/runtime/discovery.ts), run with
//     process.execPath
//   - bare name → try findJsModule, then findPyModule, error when neither
//     matches
// Extra argv after the module argument was forwarded verbatim to the child.
//
// runProcess(cmd, args) echoed `$ <cmd> <args>` then spawned with
// stdio: 'inherit', cwd: rarebert.root; on child 'exit' it called
// process.exit(code) directly (the documented escape hatch in that module),
// and on spawn 'error' it returned exit('Failed to launch ...'). It contained
// the process-spawning helpers merged from lib/run.ts (this script was that
// lib module's only consumer; lib/run.ts no longer exists). Per the exit
// directive, the bare `return;` statements after runProcess were left as-is
// because runProcess terminated the process itself.
//
// CLI surface (original meta):
//   usage: 'node index.js run <module> [args...]'
//   options: [] (none)
//   args: [] (none declared; <module> and args... were read from positional)
//
// Exports beyond the default: none (meta only). No other module imported
// from run.ts. Dependencies: rarebert (Project), listAllModules (discovery),
// exit (lib/core.ts), fs/path/child_process.
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'run',
    description: 'Run a module (defaults to src/main.py); forwards extra args (unimplemented)',
    usage: 'node index.js run <module> [args...]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('run: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('run.ts', main, meta).supportsDirectRunning();
export { main, meta };
