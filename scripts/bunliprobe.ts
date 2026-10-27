#!/usr/bin/env bun
// bunliprobe.ts — Bunli runtime-behavior probe (Phase 0 of the Bunli migration).
//
// Keeps diagnostic Bunli behavior probes INSIDE rarebert as a maintained,
// discoverable module instead of throwaway scratch scripts.
//
// Each scenario boots an in-process Bunli CLI (inline config override — no
// bunli.config.ts dependency, cwd-independent) with one synthetic `probecmd`
// command and drives cli.run(argv) / cli.execute(...) with caller-supplied
// argv, then dumps exactly what the handler receives (flags / positional /
// runtime.args / context keys).
//
// One scenario per process: Bunli's error paths (bare / help / unknown
// command) may process.exit() internally — that behavior IS the measurement,
// visible via the SENTINEL markers and the process exit code.
//
// Scenarios:
//   args     — declared option + mixed flags/positionals → handler view
//   noopts   — zero declared options (unknown-flag tolerance probe)
//   bare     — cli.run([]) with no argv at all
//   help     — cli.run(['--help', ...])
//   helpword — cli.run(['help', ...])
//   missing  — cli.run(['nosuchcommand']) → exact error text + exit code
//   execute  — cli.execute via alias, canonical name, and guarded unknown
//   helpdeep — per-command --help interception (declared options display)
//   dashh    — per-command -h interception
//   coreprefix — unknown token BEFORE the command name (treated as one)

import { z } from 'zod';
import { createCLI, defineCommand, option } from '@bunli/core';
import { CLI, type Args } from '../lib/runtime/CLI.ts';
import { EXIT_FAIL } from '../lib/runtime/core.ts';
import { exit } from '../lib/runtime/core.ts';

const meta = {
    name: 'bunliprobe',
    description: 'Probe Bunli CLI runtime behaviors for the migration',
    usage: 'bunliprobe <args|noopts|bare|help|helpword|missing|execute|helpdeep|dashh|coreprefix> [argv...]',
    // Diagnostic module — accept arbitrary flags so probe scenarios can
    // exercise unknown-flag handling through the full dispatcher chain.
    allowUnknownOption: true,
    options: [],
};

function safeJson(v: unknown): string {
    try {
        return JSON.stringify(v, (_k, x) =>
            x instanceof Error ? { name: x.name, message: x.message } : typeof x === 'bigint' ? String(x) : x,
        2);
    } catch {
        return String(v);
    }
}

function makeCommand(withOptions: boolean): any {
    return defineCommand({
        name: 'probecmd',
        description: 'internal probe command',
        ...(withOptions
            ? {
                  options: {
                      known: option(z.string().optional(), {
                          short: 'k',
                          description: 'declared probe option',
                      }),
                  },
              }
            : {}),
        handler: (ctx: any) => {
            console.log('--- handler received ---');
            console.log('flags     ', JSON.stringify(ctx.flags));
            console.log('positional', JSON.stringify(ctx.positional));
            console.log('runtime   ', JSON.stringify(ctx.runtime));
            console.log('ctx keys  ', JSON.stringify(Object.keys(ctx)));
            console.log('signal.aborted', Boolean(ctx.signal?.aborted));
        },
    });
}

async function boot(withOptions: boolean): Promise<any> {
    const cli = await createCLI({ name: 'bunliprobe', version: '0.0.0' } as any);
    cli.command(makeCommand(withOptions));
    return cli;
}

const scenarios: Record<string, (argv: string[]) => unknown> = {
    args: (argv) => boot(true).then((c) => c.run(['probecmd', ...argv])),
    noopts: (argv) => boot(false).then((c) => c.run(['probecmd', ...argv])),
    bare: () => boot(true).then((c) => c.run([])),
    help: (argv) => boot(true).then((c) => c.run(['--help', ...argv])),
    helpword: (argv) => boot(true).then((c) => c.run(['help', ...argv])),
    missing: (argv) => boot(false).then((c) => c.run(['nosuchcommand', ...argv])),
    helpdeep: (argv) => boot(true).then((c) => c.run(['probecmd', '--help', ...argv])),
    dashh: (argv) => boot(false).then((c) => c.run(['probecmd', '-h', ...argv])),
    coreprefix: (argv) => boot(false).then((c) => c.run(['--core', 'probecmd', ...argv])),
    execute: async (argv) => {
        const cli = await boot(true);
        console.log('--- execute via alias "sp"');
        await cli.execute('sp', argv.length ? argv : ['one', 'two', '--known', 'K']);
        console.log('--- execute canonical name');
        await cli.execute('probecmd', argv.length ? argv : ['three']);
        console.log('--- execute unknown, guarded');
        try {
            await cli.execute('nosuchthing', ['x']);
            console.log('execute(nosuchthing): did NOT throw');
        } catch (e) {
            console.log('execute(nosuchthing) threw:', safeJson(e));
        }
        console.log('STILL_ALIVE');
    },
};

/**
 * Run one probe scenario. Formula: scenario name + raw argv slice;
 * argv is forwarded verbatim after the 'probecmd' command name
 * (scenario itself never reaches Bunli's parser).
 */
export async function main(args: Args<typeof meta>, positional: string[] = []): Promise<unknown> {
    const [scenario, ...rest] = positional.length ? positional : ['args'];
    const fn = scenarios[scenario];
    if (!fn) {
        console.error(
            `bunliprobe: unknown scenario "${scenario}" — choose one of ${Object.keys(scenarios).join(', ')}`,
        );
        return exit(1);
    }
    console.log(`bunliprobe: scenario=${scenario} argv=${JSON.stringify(rest)}`);
    console.log('SENTINEL_BEFORE_RUN');
    if (scenario === 'execute') {
        await (fn as (argv: string[]) => Promise<void>)(rest);
    } else {
        await (fn as (argv: string[]) => Promise<void>)(rest);
    }
    console.log('SENTINEL_AFTER_RUN');
    return exit(0);
}

export default new CLI('bunliprobe.ts', main, meta).supportsDirectRunning();
export { meta };

// Direct-run bootstrap — probe-only import.meta.main guard. The generic
// cross-runtime supportsDirectRunning mechanism was intentionally deprecated
// (import.meta.url is not portable); this Bun-native flag is scoped to this
// diagnostic module and harmless if the migration's entry later supersedes it.
if (import.meta.main) {
    await main({}, process.argv.slice(2));
}
