#!/usr/bin/env node

import { cli, CLI, TUI } from '../lib/module.mjs';
import { tui } from '../lib/tui.mjs';
import { editor } from '../lib/editor.mjs';
import { models } from '../lib/models.mjs';
import { exit } from '../lib/core.mjs';
import { runHeadless, runInteractive } from '../lib/implement.mjs';
import fs from 'fs';

const meta = {
    name: 'implement',
    description: `Default refactor/bugfix workflow. Accept a list of module paths and an instruction prompt, then run opencode to implement the changes — interactively (launching the opencode TUI) when run from a terminal, or non-interactively (opencode run --auto) when piped or scripted. The instruction is the final positional argument if it does not resolve to a file/module, or the --prompt flag.\n\nThe model id is '<provider>/<model>' as declared under 'provider' in opencode.jsonc — e.g. 'ollama/laguna-xs-2.1:q8_0'. The provider name is whatever key is used under 'provider' in the config, not necessarily 'ollama'. The default model is resolved via models.resolveDefault() (reads opencode.jsonc, prefers config.model, falls back to first-provider/first-model); the -m/--model flag overrides it. If the specified model is not found, models.validateModel() returns a descriptive error and the process exits with status 1. opencode run is synchronous (spawnSync) — local ollama models can take 5-15 minutes per invocation as the LLM reads files, reasons, and writes code. A long-running command is normal, not a failure; only an immediate error (connection refused, model not found) indicates the backend is unavailable.`,
    usage: 'node scripts/implement.mjs <module-path>... [--prompt <text> | --prompt-file <path>] [instruction]',
    args: [{ name: 'module-path', required: false }],
    options: [
        {
            flag: '--prompt <text>',
            description:
                'instruction prompt for opencode (if omitted, the last positional arg that does not resolve to a file is used)'
        },
        {
            flag: '--prompt-file <path>',
            description:
                'read instruction from a file (avoids overshadowing the model context with a large inline prompt; the model is pointed to the file and can re-read it)'
        },
        {
            flag: '-m, --model <id>',
            description:
                "opencode model id in 'provider/model' format (overrides the default from opencode.json). Local ollama models are slow — allow 5-15 min per call, do not timeout"
        }
    ]
};

export { meta };

/**
 * Split positional args into module paths and an instruction prompt.
 * Scans ALL positionals: any arg that does NOT resolve to a file or
 * module via editor.resolveTargetArg is treated as the instruction.
 *  - Exactly one non-resolving arg → instruction, the rest are module paths
 *  - Multiple non-resolving args → returns { error } for main() to surface
 *  - No non-resolving args → instruction is null (all positionals are modules)
 * If --prompt is set, it always takes precedence and all positionals
 * are treated as module paths.
 */
function splitArgs(positional, promptFlag) {
    if (promptFlag) {
        return { moduleArgs: positional, instruction: promptFlag };
    }
    if (positional.length === 0) {
        return { moduleArgs: [], instruction: null };
    }
    const moduleArgs = [];
    const nonResolving = [];
    for (const arg of positional) {
        if (editor.resolveTargetArg(arg)) {
            moduleArgs.push(arg);
        } else {
            nonResolving.push(arg);
        }
    }
    if (nonResolving.length === 0) {
        return { moduleArgs, instruction: null };
    }
    if (nonResolving.length === 1) {
        return { moduleArgs, instruction: nonResolving[0] };
    }
    return {
        moduleArgs: positional,
        instruction: null,
        error: 'ambiguous: multiple non-file arguments found, use --prompt for the instruction'
    };
}

async function main(opts, positional) {
    let instruction = null;
    let promptFile = null;

    if (opts.promptFile) {
        if (!fs.existsSync(opts.promptFile)) {
            return exit(1, () => console.error(`implement: --prompt-file not found: ${opts.promptFile}`));
        }
        promptFile = opts.promptFile;
        // Minimal prompt: point the model to the instruction file without
        // inlining its contents (avoids overshadowing the model's context
        // with a large instruction competing with file contents it loads).
        const fileLabel = positional.length > 0 ? positional.join(', ') : 'the specified files';
        instruction = `we're refactoring ${fileLabel}. refactoring instructions have been stored in ${opts.promptFile}. Feel free to re-read the contents of ${opts.promptFile} but ignore adjacent files in system/ unless necessary.`;
    }

    const { moduleArgs, instruction: posInstruction, error } = splitArgs(positional, opts.prompt);
    if (error) {
        return exit(1, () => console.error(`implement: ${error}`));
    }
    if (!instruction) instruction = posInstruction;
    const model = opts.model || models.resolveDefault();

    if (!cli.isInteractive()) {
        if (moduleArgs.length === 0) {
            return exit(1, () =>
                console.error('implement: non-interactive mode requires module path arguments.')
            );
        }
        if (!instruction) {
            return exit(1, () =>
                console.error(
                    'implement: non-interactive mode requires an instruction prompt ' +
                        '(--prompt <text>, --prompt-file <path>, or a trailing string arg).'
                )
            );
        }
        return runHeadless({ fileArgs: moduleArgs, model, instruction });
    }

    return exit(
        new TUI(
            'implement.mjs',
            async (o = opts, p = positional) => {
                const fileArgs = moduleArgs.length > 0 ? moduleArgs : [];
                const prompt =
                    instruction ||
                    (await tui.input('Instruction for opencode:', {
                        initial:
                            fileArgs.length === 1 ? `Implement the module in ${fileArgs[0]}` : ''
                    }));
                if (!prompt || !prompt.trim()) {
                    return exit(1, () => console.error('implement: no instruction provided.'));
                }
                await runInteractive({ fileArgs, model, instruction: prompt.trim() });
            },
            meta
        )
    );
}

export default new CLI('implement.mjs', main, meta).supportsDirectRunning(import.meta.url);
