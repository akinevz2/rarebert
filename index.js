#!/usr/bin/env node

import path from 'path';
import { rarebert, home } from './lib/projects.mjs';
import { listModules } from './scripts/list.mjs';
import { backend } from './lib/backend.mjs';
import { Module, CLI, cli } from './lib/module.mjs';
import { exit } from './lib/core.mjs';
import { run } from './lib/runtime.mjs';

// ---------------------------------------------------------------------------
// Dispatcher — data-driven configuration.
//
// Every decision the dispatcher makes is table-driven: which commands are
// exempt from the onboarding guard, which bare invocations resolve to the
// module listing, and which flag redirects discovery to the install prefix.
// Adding behaviour means adding data here, not branches in the flow.
// ---------------------------------------------------------------------------

const DISPATCH_CONFIG = {
    coreFlag: '--core',
    helpCommands: new Set(['--help', '-h', 'help']),
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
// Dispatcher — the composition root.
//
// Procedural flow with early returns: dispatch() reads as a flat sequence
// of guards, each returning the moment a decision is made. All behaviour
// comes from DISPATCH_CONFIG; all module running funnels through the
// Runtime (lib/runtime.mjs) — the dispatcher never terminates the process
// itself, it only returns ExitSignals.
// ---------------------------------------------------------------------------

class Dispatcher {
    constructor(config = DISPATCH_CONFIG) {
        this.config = config;
    }

    /** Bare/help invocations list modules instead of running one. */
    isListing(cmd) {
        return !cmd || this.config.helpCommands.has(cmd);
    }

    /** Whether a command is exempt from the onboarding guard. */
    skipsOnboard(cmd) {
        if (!cmd || this.config.skipOnboard.has(cmd)) return true;
        try {
            const normalized = rarebert.normalizeModuleName(path.basename(cmd, path.extname(cmd)));
            return this.config.skipOnboard.has(normalized);
        } catch {
            return false; // not a valid module name — fall through to onboarding
        }
    }

    /** Onboarding guard: ensure config + project registration. */
    async onboardIfNeeded(cmd) {
        if (this.skipsOnboard(cmd)) return;
        await backend.ensureAll();
    }

    /**
     * Resolve a scripts/ module reference by name or path.
     * Returns a { name, path } descriptor, or null when unresolvable.
     * Path references always resolve (the file may not exist yet — the
     * import step reports that); name references must match a discovered
     * module.
     */
    resolve(ref) {
        return home.resolveModuleRef(ref);
    }

    /** Import the script file and enforce the Module contract. */
    async load(script) {
        const mod = await import('file://' + home.absPath(script.path));
        const exported = mod.default;

        if (!(exported instanceof Module)) {
            throw new Error(
                `${script.path}: default export must be a Module instance, got ${exported?.constructor?.name ?? typeof exported}`
            );
        }
        return exported;
    }

    /**
     * Run one command end-to-end. Procedural, early-return flow:
     *   core redirect → listing → onboarding guard → resolve → load → run.
     * Returns ExitSignals for every failure kind; the Runtime owns
     * process termination for the success path.
     */
    async dispatch(opts = {}, positional = []) {
        // --core redirects the `rarebert` singleton to the install prefix
        // so all module discovery and the onboarding guard operate against
        // rarebert's own modules rather than the CWD project.
        if (opts.core) {
            rarebert.redirect(home.root);
        }

        const cmd = positional[0];
        const rest = positional.slice(1);

        // Bare / help invocation → module listing.
        if (this.isListing(cmd)) {
            await listModules([cmd, ...rest].filter(Boolean));
            return exit(0);
        }

        // Onboarding guard — exempt commands skip it entirely.
        await this.onboardIfNeeded(cmd);

        // Resolve → load → run.
        const script = this.resolve(cmd);
        if (!script) return exit(new Error(`Module not found: ${cmd}`));

        try {
            const exported = await this.load(script);
            await run(exported, rest);
        } catch (err) {
            // Error kind — bubble through the dispatcher's own exit()
            // machinery (abort callbacks, AbortError → 130) instead of a
            // raw process.exit().
            return exit(err);
        }
    }
}

const dispatcher = new Dispatcher();

const meta = {
    name: 'rarebert',
    description: 'Rarebert dispatcher: resolve a module by name/path and run it',
    usage: 'node index.js [--core] [module] [args...]',
    skipHelpIntercept: true,
    allowUnknownOption: true,
    options: [
        {
            flag: '--core',
            description:
                'operate against the rarebert install prefix instead of the current directory'
        }
    ]
};

async function main(opts, positional) {
    // Return the module's ExitSignal (including the Error kind from a
    // failed dispatch) so it completes through this module's own
    // exit() machinery.
    return dispatcher.dispatch(opts, positional);
}

const module = new CLI('index.js', main, meta);

cli.installSignalHandlers();

module.supportsDirectRunning(import.meta.url);

export { main, Dispatcher };
export default module;
