#!/usr/bin/env node

import { backend } from '../lib/backend.mjs';
import { exit } from '../lib/core.mjs';
import { CLI, TUI } from '../lib/module.mjs';

const meta = {
    name: 'onboard',
    description:
        'Interactively configure opencode.json (endpoint + model) and register the current project with rarebert (mark module-containing folders)',
    usage:
        'node index.js onboard [--force] [--base-url <url>] [--model <id>] [--provider <name>] [--editor-type <graphical|terminal>]',
    options: [
        { flag: '--force', description: 'reconfigure even if a config/project registration exists' },
        { flag: '--base-url <url>', description: 'Ollama endpoint URL (OpenAI-compatible /v1). Non-interactive when paired with --model.' },
        { flag: '--model <id>', description: 'Default model id. Non-interactive when paired with --base-url.' },
        { flag: '--provider <name>', description: 'Provider key (default: ollama).' },
        { flag: '--editor-type <graphical|terminal>', description: 'Skip the editor-type prompt.' }
    ]
};

export { meta };

export default new CLI('onboard.mjs', async (opts, positional) => {
    const force = !!opts.force || positional.includes('--force') || positional.includes('-f');

    // Non-interactive mode: both --base-url and --model required.
    if (opts.baseUrl && opts.model) {
        const provider = opts.provider || 'ollama';
        const editorType = opts.editorType || null;
        const ok = await backend.runOnboardNonInteractive({
            baseURL: opts.baseUrl,
            model: opts.model,
            provider,
            editorType,
            force
        });
        return exit(ok ? 0 : 1);
    }

    // Interactive fallback — escalate to TUI.
    return exit(new TUI('onboard.mjs', async (o = opts, p = positional) => {
        const tuiForce = !!o.force || p.includes('--force') || p.includes('-f');

        const configOk = await backend.runOnboard({ force: tuiForce });
        if (!configOk && !backend.isConfigured()) {
            return exit(1);
        }

        const projectOk = await backend.projectOnboard({ force: tuiForce });
        if (!projectOk) {
            return exit(1);
        }
    }, meta));
}, meta).supportsDirectRunning(import.meta.url);