#!/usr/bin/env node
// ---------------------------------------------------------------------------
// onboard.ts — STUB (implementation removed in the Bunli-migration slim-down).
//
// Original behavior: interactive configuration of opencode.json (Ollama
// endpoint + models) and registration of the current project's
// module-containing folders with rarebert. Kept all Interface/Enquirer
// construction here in scripts/ per the lib-purity directive — lib/backend.ts
// stayed pure-data (bare data readers/writers only).
//
// Flow: runOnboard — if not configured, prompt for base URL (validated
// http(s) URL, empty = existing or DEFAULT_BASE_URL), probe <url>/models via
// backend.fetchModels; if unreachable, persist a partial config
// (backend.writePartialConfig) and tell the user to start Ollama and re-run.
// If reachable: MultiSelect models (with a __custom__ manual entry),
// promptDefaultModel, optional display names (promptModelDisplayNames),
// promptEditorType (graphical vs terminal editor — persisted via
// backend.setEditorType so `make open` knew whether to run the opencode TUI
// in parallel), then backend.buildConfig + backend.writeConfig.
// projectOnboard — scan cwd via backend.scanCandidateFolders, MultiSelect
// which folders to track, backend.registerFolders(cwd, folders); skipped for
// rarebert's own install root and already-onboarded cwd.
//
// CLI surface (original meta):
//   usage: 'node index.js onboard [--force] [--base-url <url>] [--model <id>]
//           [--provider <name>] [--editor-type <graphical|terminal>]'
//   options:
//     --force                          — reconfigure even if a config/project
//                                        registration exists
//     --base-url <url>                 — Ollama endpoint URL (OpenAI-compatible
//                                        /v1). Non-interactive when paired
//                                        with --model.
//     --model <id>                     — default model id. Non-interactive
//                                        when paired with --base-url.
//     --provider <name>                — provider key (default: ollama)
//     --editor-type <graphical|terminal> — skip the editor-type prompt
//
// With both --base-url and --model given, main ran runOnboardNonInteractive
// (direct buildConfig/writeConfig, no prompts, then projectOnboard).
// Otherwise it returned exit(new TUI(...)) for the interactive flow.
// Dependencies: backend (DEFAULT_BASE_URL, DEFAULT_PROVIDER), home/rarebert,
// store, TUI/Interface, AbortError, isInteractive, exit (core.ts).
// ---------------------------------------------------------------------------

import { CLI, type Args, type Positional } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'onboard',
    description:
        'Interactively configure opencode.json (endpoint + model) and register the current project with rarebert (mark module-containing folders) (unimplemented)',
    usage: 'node index.js onboard [--force] [--base-url <url>] [--model <id>] [--provider <name>] [--editor-type <graphical|terminal>]',
    options: [], // original flags preserved in the docblock above
    args: []     // original positional declarations preserved in the docblock above
};

async function main(_opts: Args<typeof meta>, _positional: Positional<typeof meta>) {
    return exit(new Error('onboard: unimplemented - see the documented original behavior in this file\'s header (recoverable from git history).'));
}

export default new CLI('onboard.ts', main, meta).supportsDirectRunning();
export { main, meta };
