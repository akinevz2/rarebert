#!/usr/bin/env node

import { models } from '../lib/models.mjs';
import { exit } from '../lib/core.mjs';
import { CLI, cli, TUI } from '../lib/module.mjs';
import * as present from '../lib/present.mjs';

const meta = {
    name: 'present',
    description:
        "Prompt for an instruction, run opencode headlessly to build a presentation JSON of file:line slides explaining the request, then walk the user's editor through each slide in indexed mode — printing the per-slide explanation, navigating to file:line, and advancing on tab-close",
    usage: 'node index.js present [--model <id>] [--instruction <text>] [--base <ref>] [--head <ref>] [--file <path>]',
    options: [
        {
            flag: '-m, --model <id>',
            description: 'opencode model id (overrides the default from opencode.json)'
        },
        {
            flag: '--instruction <text>',
            description: 'non-interactive instruction (skip the prompt)'
        },
        {
            flag: '--base <ref>',
            description: 'git base ref for diff context passed to opencode (default: HEAD~1)'
        },
        {
            flag: '--head <ref>',
            description: 'git head ref for diff context passed to opencode (default: HEAD)'
        },
        {
            flag: '--file <path>',
            description: 'load a presentation JSON from a file instead of calling opencode'
        }
    ]
};

export { meta, runPresent };

async function runPresent(opts, positional) {
    const model = opts.model ? await models.resolve(opts.model) : models.resolveDefault();

    let presentation;
    if (opts.file) {
        presentation = present.readPresentation(opts.file);
    } else {
        const instruction = opts.instruction
            ? String(opts.instruction).trim()
            : await present.promptInstruction();
        if (!instruction) {
            return exit(1, () => console.error('present: no instruction provided'));
        }
        presentation = await present.buildPresentation(instruction, model, opts);
    }

    if (!presentation) return exit(1);

    return exit(0, () => present.walkSlides(presentation));
}

export default new CLI(
    'present.mjs',
    async (opts, positional) => {
        if (opts.instruction || opts.file) {
            return exit(await runPresent(opts, positional));
        }

        if (!cli.isInteractive()) {
            return exit(1, () =>
                console.error(
                    'present: --instruction or --file required for non-interactive mode, or run from a TTY.'
                )
            );
        }

        return exit(
            0,
            new TUI(
                'present.mjs',
                async (opts, positional) => {
                    return runPresent(opts, positional);
                },
                meta
            )
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
