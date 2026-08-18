#!/usr/bin/env node

import { cli, CLI, TUI } from '../lib/module.mjs';
import { editor } from '../lib/editor.mjs';
import { models } from '../lib/models.mjs';
import { exit } from '../lib/core.mjs';
import { runHeadless, runInteractive } from '../lib/implement.mjs';

const meta = {
    name: 'implement',
    description:
        'Default refactor/bugfix workflow: accept a list of module paths and an instruction prompt, then run opencode interactively (launching `opencode <project>`) or non-interactively (`opencode run --auto`) with the local default model. The instruction is either the final positional argument (if it does not resolve to a file/module) or the --prompt flag.',
    usage:
        'node scripts/implement.mjs <module-path>... [--prompt <instruction>] [instruction]',
    args: [{ name: 'module-path', required: false }],
    options: [
        {
            flag: '--prompt <text>',
            description:
                'instruction prompt for opencode (if omitted, the last positional arg that does not resolve to a file is used)'
        },
        {
            flag: '-m, --model <id>',
            description: 'opencode model id (overrides the default from opencode.json)'
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
    const { moduleArgs, instruction, error } = splitArgs(positional, opts.prompt);
    if (error) {
        return exit(1, () => console.error(`implement: ${error}`));
    }
    const model = opts.model || models.resolveDefault();

    if (!cli.isInteractive()) {
        if (moduleArgs.length === 0) {
            return exit(1, () =>
                console.error(
                    'implement: non-interactive mode requires module path arguments.'
                )
            );
        }
        if (!instruction) {
            return exit(1, () =>
                console.error(
                    'implement: non-interactive mode requires an instruction prompt ' +
                        '(--prompt <text> or a trailing string arg).'
                )
            );
        }
        return runHeadless({ fileArgs: moduleArgs, model, instruction });
    }

    return exit(new TUI('implement.mjs', async (o = opts, p = positional) => {
        const fileArgs = moduleArgs.length > 0 ? moduleArgs : [];
        const prompt = instruction || (await cli.input('Instruction for opencode:', {
            initial: fileArgs.length === 1 ? `Implement the module in ${fileArgs[0]}` : ''
        }));
        if (!prompt || !prompt.trim()) {
            return exit(1, () => console.error('implement: no instruction provided.'));
        }
        await runInteractive({ fileArgs, model, instruction: prompt.trim() });
    }, meta));
}

export default new CLI('implement.mjs', main, meta).supportsDirectRunning(import.meta.url);