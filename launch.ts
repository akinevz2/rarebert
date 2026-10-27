#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// launch.ts — the Bunli composition root (thin router).
//
// Bunli owns ONLY command routing. Every module handoff passes the
// post-command argv VERBATIM (ctx.runtime.args) to the legacy Runtime:
// run(exported, rest) → Module.execute → Commander parses exactly as
// before → Arguments / MainCallback / flows / TUI machinery unchanged.
// No script module needed a rewrite for this migration.
//
// Probe-verified Bunli facts underpinning this design
// (scripts/bunliprobe.ts — Phase 0 spike):
//   - ctx.runtime.args = the argv after the command name, verbatim —
//     known flags, unknown flags, and `--` everything, in original order.
//   - Unknown flags are silently tolerated (stripped from ctx.flags;
//     ctx.positional order collapses — we discard both).
//   - Bare invocation and --help/-h print Bunli help and exit 0 — the
//     root help doubles as the command (module) listing.
//   - The literal word `help` is NOT built-in → registered below with
//     the legacy listing behavior (h alias preserved).
//   - An unknown token BEFORE the command name is treated as a command
//     name (CommandNotFoundError, exit 1) → `--core` is therefore
//     filtered from argv in-process before cli.run(), so the legacy
//     `rarebert --core <module>` placement keeps working.
//
// Known divergences from the legacy dispatcher (all documented):
//   - Unknown module → `Command 'x' not found` (+available list), exit 1.
//     On non-TTY output it arrives as a JSON error object on stdout;
//     legacy printed `Module not found: x` on stderr. Exit code is
//     identical (1).
//   - `rarebert scripts/foo.ts` path refs go through the `exec` command:
//     `rarebert exec scripts/foo.ts [args...]` (unknown-bare-token
//     routing cannot be intercepted without Bunli internals).
//   - `--lib/--src/--scripts/--script` listing filters were dead tokens
//     on the legacy resolve path (they never matched a module); they are
//     dropped rather than carried forward.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { createCLI, defineCommand, option } from '@bunli/core';
import type { Options } from '@bunli/core';
import { z } from 'zod';
import { run, exit } from './lib/runtime/core.ts';
import { Module, installSignalHandlers } from './lib/runtime/Module.ts';
import type { ModuleMeta } from './lib/runtime/CLI.ts';
import { rarebert, home } from './lib/runtime/Project.ts';
import { Script } from './lib/runtime/Script.ts';
import { memo } from './lib/memo.ts';
import { backend } from './lib/backend.ts';
import packageJson from './package.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Data-driven dispatcher configuration (unchanged from the legacy contract):
// which commands are exempt from the onboarding guard. Adding behaviour
// means adding data here, not branches in the flow.
// ---------------------------------------------------------------------------
const DISPATCH_CONFIG: DispatchConfig = {
    coreFlag: '--core',
    skipOnboard: new Set([
        'onboard',
        'reload',
        'check',
        'help',
        'h',
        '--help',
        '-h',
        'list',
        '--lib',
        '--src',
        '--scripts',
        '--script'
    ])
};

// ---------------------------------------------------------------------------
// Dispatcher — the composition-root helpers.
//
// Every module running still funnels through the Runtime
// (lib/runtime/core.ts). Failure paths return ExitSignals from the
// per-command runner's execute(), and the launcher-level run() folds
// them through complete() exactly like the legacy outer dispatch did.
// ---------------------------------------------------------------------------


/** The dispatcher's data-driven configuration. */
interface DispatchConfig {
    /** The flag that redirects the dispatcher at rarebert's own install. */
    coreFlag: string;
    /** Commands exempt from the onboarding guard. */
    skipOnboard: Set<string>;
}

/** The minimal Module-like shape the Runtime accepts. */
interface Runner {
    /** The runner's display path. */
    path: string;
    /** Runs the module with the given argv. */
    execute(args?: string[]): unknown;
}

class Dispatcher {
    /** The dispatcher's data-driven configuration. */
    config: DispatchConfig;

    constructor(config: DispatchConfig = DISPATCH_CONFIG) {
        this.config = config;
    }

    /** Whether a command is exempt from the onboarding guard. */
    skipsOnboard(cmd: string | undefined): boolean {
        if (!cmd || this.config.skipOnboard.has(cmd)) return true;
        try {
            const normalized = rarebert.normalizeModuleName(path.basename(cmd, path.extname(cmd)));
            return this.config.skipOnboard.has(normalized);
        } catch {
            return false; // not a valid module name — fall through to onboarding
        }
    }

    /** Onboarding guard: ensure config + project registration. */
    async onboardIfNeeded(cmd: Script | string | undefined): Promise<void> {
        const name = cmd instanceof Script ? cmd.name : cmd;
        if (this.skipsOnboard(name)) return;
        await backend.ensureAll();
    }

    /**
     * Resolve a scripts/ module reference by name or path.
     * Returns a { name, path } descriptor, or null when unresolvable.
     * Path references always resolve (the file may not exist yet — the
     * import step reports that); name references must match a discovered
     * module.
     */
    resolve(ref: string): Script | null {
        return home.resolveModuleRef(ref);
    }

    /** Import the script file and enforce the Module contract. */
    async load(script: Script): Promise<Module> {
        const mod = await import(script.importUrl);
        const exported = mod.default;

        if (!(exported instanceof Module)) {
            throw new Error(
                `${script.path}: default export must be a Module instance, got ${exported?.constructor?.name ?? typeof exported}`
            );
        }
        return exported;
    }

    /**
     * Load-and-guard + memo preload + run one module end-to-end.
     *
     * `preloaded` passes an already-imported default export (the eager
     * Bunli registration imports every module at boot); null forces a
     * dynamic import (`exec`, unloaded modules). Returns an ExitSignal
     * for the error kind so the launcher-level run() folds it through
     * the exit machinery — never a raw process.exit().
     */
    async runModule(
        script: Script,
        rest: string[],
        preloaded: Module | null = null
    ): Promise<unknown> {
        await this.onboardIfNeeded(script);
        try {
            const exported = preloaded ?? (await this.load(script));
            // Memo auto-reminder: preload the running module's memo trail
            // and register the flush-on-exit cascade (the loadForRun
            // contract). Never crash dispatch on memo-system trouble.
            try {
                await memo.loadForRun(script);
            } catch {
                /* memo system unavailable */
            }
            await run(exported, rest);
        } catch (err) {
            return exit(err as Error);
        }
    }
}

const dispatcher = new Dispatcher();

// ---------------------------------------------------------------------------
// Bunli option declarations — display only.
//
// The real argument semantics stay with Commander (inside each module's
// own CLI runner). Declaring Bunli options from the ModuleMeta buys two
// things at zero behavioral cost: they appear in `--help` output, and
// runtime.args keeps every token verbatim either way (probe-verified).
// Every option is a schema-free passthrough (z.string().optional() for
// value flags, z.coerce.boolean().optional() for boolean flags) so Bunli
// never rejects or coerces a value Commander would own.
// ---------------------------------------------------------------------------

function camelCase(name: string): string {
    return name.replace(/-([a-z])/g, (_all: string, c: string) => c.toUpperCase());
}

function bunliOptionsFor(meta: Partial<ModuleMeta> = {}): Options {
    const out: Options = {};
    for (const opt of Array.isArray(meta.options) ? meta.options : []) {
        const raw = opt.flag ?? '';
        const parts = raw.split(',').map((p: string) => p.trim()).filter(Boolean);
        const longPart = parts.find((p: string) => p.startsWith('--')) ?? raw;
        const name = (longPart.replace(/^--/, '').split(/\s+/)[0] || '').trim();
        if (!name) continue;

        const hasValue = /\s[<\[]/.test(raw) || Boolean(opt.label) || opt.type === 'int' || opt.type === 'float';
        const shorts = parts
            .filter((p: string) => !p.startsWith('--') && p.startsWith('-'))
            .map((p: string) => p.replace(/^-+/, ''))
            .filter(Boolean);
        const hint = { description: opt.description, ...(shorts.length ? { short: shorts[0] } : {}) };

        out[camelCase(name)] = hasValue
            ? option(z.string().optional(), hint)
            : option(z.coerce.boolean().optional(), hint);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Per-command runners. A runner is the minimal Module-like the Runtime
// accepts ({ path, execute(args) }); execute returns the ExitSignal (or
// handing off to run(), which process-exits itself on success).
// ---------------------------------------------------------------------------

/** Runner for one eagerly-registered module command. */
function makeRunner(
    script: Script,
    preloaded: Module | null,
    loadError: string | null
): Runner {
    return {
        path: `launch:${script.name}`,
        async execute(args: string[] = []) {
            if (loadError) {
                return exit(new Error(`${script.path}: ${loadError}`));
            }
            return dispatcher.runModule(script, args, preloaded);
        },
    };
}

/** Legacy `help` word — data-driven module listing, exit code 0. */
const helpRunner: Runner = {
    path: 'launch:help',
    async execute(args: string[] = []) {
        await rarebert.listModules(args);
        return exit(0);
    },
};

/** `exec` — the escape hatch for the legacy path-ref invocation form. */
const execRunner: Runner = {
    path: 'launch:exec',
    async execute(args: string[] = []) {
        const [ref, ...rest] = args;
        if (!ref) return exit(new Error('exec: missing module reference'));
        const script = dispatcher.resolve(ref);
        if (!script) return exit(new Error(`Module not found: ${ref}`));
        return dispatcher.runModule(script, rest, null);
    },
};

// ---------------------------------------------------------------------------
// Composition: one Bunli command per discovered module, plus the help
// and exec services. A failed module import registers a command whose
// handler reports the load error — boot never dies on one bad script.
// ---------------------------------------------------------------------------

function wrapModuleCommand(
    script: Script,
    preloaded: Module | null,
    loadError: string | null
) {
    const meta = (preloaded?.meta ?? {}) as Partial<ModuleMeta>;
    return defineCommand({
        name: script.name,
        description: loadError ? `${script.name} — (failed to load: ${loadError})` : meta.description ?? script.name,
        options: loadError ? {} : bunliOptionsFor(meta),
        handler: (ctx) => run(makeRunner(script, preloaded, loadError), ctx.runtime.args),
    });
}

const helpCommand = defineCommand({
    name: 'help',
    description: 'List discoverable modules (the legacy dispatcher listing)',
    alias: ['h'],
    options: {},
    handler: (ctx) => run(helpRunner, ctx.runtime.args),
});

const execCommand = defineCommand({
    name: 'exec',
    description: 'Run a module by name or path reference',
    options: {},
    handler: (ctx) => run(execRunner, ctx.runtime.args),
});

installSignalHandlers();

const { name, version } = packageJson;

// Legacy `--core <module>` placement: Bunli treats a pre-command token as
// the command name, so the core flag is consumed in-process before routing.
const initialArgv = process.argv.slice(2);
if (initialArgv.includes(DISPATCH_CONFIG.coreFlag)) {
    rarebert.redirect(home.root);
}
const routedArgv = initialArgv.filter((a) => a !== DISPATCH_CONFIG.coreFlag);

const cli = await createCLI({ name, version });

const modules = home.discoverModules();
for (const descriptor of modules) {
    const script = new Script(descriptor.name, descriptor.path, home.root);
    let preloaded: Module | null = null;
    let loadError: string | null = null;
    try {
        preloaded = await dispatcher.load(script);
    } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
    }
    cli.command(wrapModuleCommand(script, preloaded, loadError));
}
cli.command(helpCommand);
cli.command(execCommand);

await cli.run(routedArgv);

export { Dispatcher, DISPATCH_CONFIG, bunliOptionsFor };
