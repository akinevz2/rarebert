#!/usr/bin/env node

import path from 'path';
import { rarebert, home } from './lib/projects.mjs';
import { listModules } from './scripts/list.mjs';
import { backend } from './lib/backend.mjs';
import { Module, CLI, cli } from './lib/module.mjs';
import { exit, Runtime } from './lib/core.mjs';

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
async function runModule(ref, _args = []) {
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
        throw new Error('Module not found: ' + ref);
    }

    const mod = await import('file://' + home.absPath(script.path));
    const exported = mod.default;

    if (!(exported instanceof Module)) {
        throw new Error(
            `${script.path}: default export must be a Module instance, got ${exported?.constructor?.name ?? typeof exported}`
        );
    }

    return exported;
}

const HELP_COMMANDS = new Set(['--help', '-h', 'help']);

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
    cli.installSignalHandlers();

    // opts should always be forwarded to the called module
    // after parsing them using Commander.js library.

    if (opts.core) {
        rarebert.redirect(home.root);
    }

    // Commander.js parsing for the command and its arguments
    const program = cli.createCommand(meta);
    program.allowUnknownOption(true);
    program.allowExcessArguments(true);

    try {
        await program.parseAsync(['node', 'rarebert', ...positional]);
    } catch (err) {
        if (err?.code === 'commander.help') return exit(0);
        return exit(err.message || String(err));
    }

    const parsedCmd = program.args[0];
    const parsedArgs = program.args.slice(1);

    if (!parsedCmd || HELP_COMMANDS.has(parsedCmd)) {
        await listModules([program.args[0], ...program.args.slice(1)].filter(Boolean));
        return exit(0);
    }

    await maybeOnboard(parsedCmd);

    // Resolve the ref to a Module and hand it back to the Runtime for
    // re-execution. exit(0, () => mod) makes complete() return the Module,
    // so Runtime loops and invokes mod.runner with the SAME args (forwarded
    // from this invocation), then drives guard/invoke/decide/cleanup itself.
    try {
        const mod = await runModule(parsedCmd, parsedArgs);
        return exit(0, () => mod);
    } catch (err) {
        console.error(err.message || err);
        return exit(err.message || String(err));
    }
}

const module = new CLI('index.js', main, meta);

cli.installSignalHandlers();

module.supportsDirectRunning(import.meta.url);

export { main };

export default module;