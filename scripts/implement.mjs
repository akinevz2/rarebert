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
 * Split positional args into module paths and a trailing instruction.
 * The last positional arg is treated as the instruction prompt if it
 * does NOT resolve to a file or module via editor.resolveTargetArg.
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
    const last = positional[positional.length - 1];
    const target = editor.resolveTargetArg(last);
    if (target) {
        return { moduleArgs: positional, instruction: null };
    }
    return {
        moduleArgs: positional.slice(0, -1),
        instruction: last
    };
}

async function main(opts, positional) {
    const { moduleArgs, instruction } = splitArgs(positional, opts.prompt);
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