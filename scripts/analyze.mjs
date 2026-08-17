#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { store } from '../lib/core.mjs';
import { CLI, cli, listAllModules, resolveModule, promptModuleChoices, TUI } from '../lib/module.mjs';
import { load } from '../lib/analyze.mjs';
import {
    introspectFile,
    buildGraph,
    traceBinding,
    formatFileSummary,
    formatTrace,
    resolveOneStep
} from '../lib/introspect.mjs';

const meta = {
    name: 'analyze',
    description:
        'Analyze a module: print a condensed source map (imports, declarations with 1-step resolution, exports). Accepts one or multiple modules. Pass --trace <module::name> to walk the full dependency chain. Pass --document for an opencode documentation pass.',
    usage: 'node index.js analyze [module...] [--trace <name>] [--graph] [--oneline] [--document] [--yes] [-v] [--clear-cache]',
    args: [{ name: 'module', required: false }],
    options: [
        { flag: '--trace <name>', description: 'Trace a binding chain (module::name or just name)' },
        { flag: '--graph', description: 'Print the resolved import graph' },
        { flag: '--oneline', description: 'Condensed one-line summary per module' },
        { flag: '--document', description: 'Run opencode documentation pass (segment, document, memoize)' },
        { flag: '--clear-cache', description: 'Clear the introspect tool cache' },
        { flag: '-v, --verbose', description: 'Verbose output' },
        { flag: '-y, --yes', description: 'Skip confirmation prompts' }
    ]
};

export { meta };

export default new CLI('analyze.mjs', async (opts = {}, positional = []) => {
    const args = Array.isArray(positional) ? positional : [];
    const verbose = !!opts.verbose;
    const yes = !!opts.yes;
    const document = !!opts.document;
    const oneline = !!opts.oneline;
    const showGraph = !!opts.graph;
    const traceName = opts.trace || null;
    const clearCache = !!opts.clearCache;

    try {
        if (clearCache) {
            return exit(new TUI('analyze.mjs', async (opts = {}, positional = []) => {
                const confirmed = await cli.confirm(
                    'Clear the introspect tool cache? This will reset all module binding analyses.',
                    false
                );
                if (!confirmed) return exit(0, () => console.log('introspect: cache not cleared.'));
                store.clearIntrospectCache();
                console.log('introspect: cache cleared');
            }, meta));
        }

        if (traceName) {
            const traceParts = traceName.split('::');
            const traceModule = traceParts[0].trim();
            const traceBinding = traceParts.slice(1).join('::').trim();

            if (!traceModule) {
                console.error('analyze: --trace requires a module path (e.g., --trace scripts/list.mjs::listModules)');
                return exit(1);
            }

            const module = listAllModules().find((m) => m.path === traceModule || m.abs.endsWith(traceModule));
            if (!module) {
                console.error(`analyze: module "${traceModule}" not found`);
                return exit(1);
            }

            return await runTrace([traceModule], traceName);
        }

        if (document) {
            const moduleArg = args.length > 0 ? args[0] : null;
            await load(moduleArg, { verbose, yes, document });
            return exit(0);
        }

        const moduleArgs = args.length > 0 ? args : null;

        if (showGraph) {
            return await runGraph(moduleArgs);
        }

        return await runSummary(moduleArgs, { oneline });
    } catch (err) {
        console.error('Error:', err.message);
        return exit(1);
    }
}, meta).supportsDirectRunning(import.meta.url);

async function resolveModuleList(moduleArgs) {
    if (!moduleArgs) {
        const modules = listAllModules();
        if (modules.length === 0) {
            console.error('analyze: no modules found.');
            return null;
        }
        const choices = modules.map((m) => ({ name: m.path, message: m.path }));
        const selection = await promptModuleChoices('Select a module to analyze:', choices, { limit: 12 });
        const resolved = resolveModule(selection, modules);
        return resolved ? [resolved.module] : null;
    }

    const modules = listAllModules();
    const resolved = moduleArgs.map((arg) => {
        const r = resolveModule(arg, modules);
        return r ? r.module : null;
    }).filter(Boolean);

    if (resolved.length === 0) {
        console.error('analyze: no modules resolved from args');
        return null;
    }

    return resolved;
}

async function runSummary(moduleArgs, { oneline }) {
    const modules = await resolveModuleList(moduleArgs);
    if (!modules) return exit(1);

    for (const mod of modules) {
        const file = await introspectFile(mod.abs);

        const oneStepResults = {};
        const graph = { files: new Map([[file.relPath, file]]) };
        for (const decl of file.declarations) {
            oneStepResults[decl.name] = await resolveOneStep(decl, file, graph);
        }

        console.log(formatFileSummary(file, { oneline, oneStepResults }));
        console.log();
    }

    return exit(0);
}

async function runTrace(moduleArgs, traceName) {
    const modules = await resolveModuleList(moduleArgs);
    if (!modules) return exit(1);

    const seeds = modules.map((m) => m.path);
    const graph = await buildGraph(seeds, { codebaseScope: true });

    const result = await traceBinding(graph, traceName);
    console.log(formatTrace(result));

    if (result.issues && result.issues.length > 0) {
        console.error(`\n${result.issues.length} issue(s) found in trace chain`);
        return exit(1);
    }

    return exit(0);
}

async function runGraph(moduleArgs) {
    const modules = await resolveModuleList(moduleArgs);
    if (!modules) return exit(1);

    const seeds = modules.map((m) => m.path);
    const graph = await buildGraph(seeds, { codebaseScope: false });

    console.log(`\nResolved import graph (${graph.modules.size} modules):\n`);
    for (const [relPath, mod] of graph.modules) {
        const file = graph.files.get(relPath);
        const impCount = file ? file.imports.length : 0;
        const expCount = file ? file.exports.length : 0;
        const declCount = file ? file.declarations.length : 0;
        console.log(`  ${relPath}  (${impCount} imports, ${declCount} declarations, ${expCount} exports)`);
    }
    console.log();

    return exit(0);
}