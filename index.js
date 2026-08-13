#!/usr/bin/env node

import path from 'path';
import { rarebert, home } from './lib/projects.mjs';
import { listModules } from './scripts/list.mjs';
import { backend } from './lib/backend.mjs';
import { Module, CLI, TUI, cli } from './lib/module.mjs';

const SKIP_ONBOARD = new Set([
    'onboard',
    'reload',
    'help',
    'h',
    '--help',
    '-h',
    'list',
    '--lib',
    '--src',
    '--scripts',
    '--script'
]);

async function maybeOnboard(cmd) {
    if (cmd && SKIP_ONBOARD.has(cmd)) return;
    try {
        const normalized = rarebert.normalizeModuleName(path.basename(cmd, path.extname(cmd)));
        if (SKIP_ONBOARD.has(normalized)) return;
    } catch {
        /* not a valid module name; fall through to onboarding */
    }
    await backend.ensureAll();
}

/**
 * Resolve a scripts/ module by name or path, import it, and run it.
 *
 * The default export must be an instance of Module (or a subclass like
 * CLI/TUI). If it isn't, the dispatcher fails — every rarebert command
 * must be a runnable Module.
 */
async function runModule(ref, args = []) {
    const scripts = home.discoverModules();

    const isPathRef = ref.includes('/') || ref.includes(path.sep) || ref.startsWith('./');

    let script;
    if (isPathRef) {
        const rel = home.relPath(path.resolve(home.root, ref));
        script = scripts.find((s) => s.path === rel || s.path === ref);
        if (!script && path.resolve(home.root, ref)) {
            script = { name: path.basename(ref, path.extname(ref)), path: rel };
        }
    } else {
        const name = home.normalizeModuleName(ref);
        script = scripts.find((s) => home.normalizeModuleName(s.name) === name);
    }

    if (!script) {
        console.error('Module not found:', ref);
        process.exit(1);
    }

    try {
        const mod = await import('file://' + home.absPath(script.path));
        const exported = mod.default;

        if (!(exported instanceof Module)) {
            console.error(
                `${script.path}: default export must be a Module instance, got ${exported?.constructor?.name ?? typeof exported}`
            );
            process.exit(1);
        }

        await exported.run(args);

        // TUI modules signal that the screen should be cleared after exit.
        if (exported instanceof TUI && exported.clearScreen) {
            process.stdout.write('\x1B[2J\x1B[H');
        }
    } catch (err) {
        console.error(err.message || err);
        process.exit(1);
    }
}

const HELP_COMMANDS = new Set(['--help', '-h', 'help']);

const meta = {
    name: 'rarebert',
    description: 'Rarebert dispatcher: resolve a module by name/path and run it',
    usage: 'node index.js [--core] [module] [args...]',
    skipHelpIntercept: true,
    allowUnknownOption: true,
    options: [
        { flag: '--core', description: 'operate against the rarebert install prefix instead of the current directory' }
    ]
};

async function main(opts, positional) {
    // --core redirects the `rarebert` singleton to the install prefix
    // so all module discovery and the onboarding guard operate against
    // rarebert's own modules rather than the CWD project.
    if (opts.core) {
        rarebert.redirect(home.root);
    }

    const cmd = positional[0];
    const rest = positional.slice(1);

    if (!cmd || HELP_COMMANDS.has(cmd)) {
        return listModules([cmd, ...rest].filter(Boolean));
    }

    await maybeOnboard(cmd);

    await runModule(cmd, rest);
}

const module = new CLI('index.js', main, meta);

cli.installSignalHandlers();

module.supportsDirectRunning(import.meta.url);

export { main };
export default module;