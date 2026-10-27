#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { exit, store, ExitSignal } from '../lib/runtime/core.ts';
import { CLI, defineMeta } from '../lib/runtime/CLI.ts';
import {
    Interface,
    TUI
} from '../lib/runtime/TUI.ts';
import {
    listAllModules,
    resolveModule,
    promptModuleChoices
} from '../lib/runtime/discovery.ts';
// Terminal helpers — free functions (the legacy `cli` singleton was deleted).
import { isInteractive } from '../lib/runtime/Module.ts';
import { memo } from '../lib/memo.ts';
import { models } from '../lib/models.ts';
import { ide } from '../lib/ide.ts';
import { languages } from '../lib/runtime/Language.ts';
import {
    introspectFile,
    buildGraph,
    traceBinding,
    Trace,
    formatFileSummary,
    formatTrace,
    resolveOneStep
} from '../lib/introspect.ts';
import type {
    FileIntrospection,
    FileBindings,
    Graph,
    GraphModule
} from '../lib/introspect.ts';
import type { Module } from '../lib/runtime/Module.ts';

// REQUEST: runDocumentationPass loads and caches opencode output. On ctrl-c:
// - Allow current opencode call to finish
// - Return the last successful result
// - No cleanup needed for this module
// Meta suggestion: { retryOnFailure: false, cleanup: 'none' }


/** A main() function extracted by a language primitive. */
interface MainFunction {
    /** The function's source lines. */
    bodyLines: string[];
    /** 1-indexed start line. */
    startLine: number;
    /** 1-indexed end line. */
    endLine: number;
    /** The function's name. */
    name?: string;
}

/** A code segment produced by the main() segmentation pass. */
interface Segment {
    /** The segment's source lines. */
    lines: string[];
    /** The 1-indexed start line, or null when unmatched. */
    startLine: number | null;
    /** The number of lines in the segment. */
    lineCount: number;
}

/** A public member extracted by a language primitive. */
interface PublicMember {
    /** The member's name. */
    name: string;
    /** The member's kind (const | function | class | ...). */
    kind: string;
    /** 1-indexed start line. */
    startLine: number;
    /** 1-indexed end line. */
    endLine: number;
    /** The member's source lines. */
    lines: string[];
}


/**
 * Build a one-file Graph for the 1-step resolution pass. The graph only
 * needs the file's own introspection — the resolution step reads the
 * file's imports and declarations, not the wider dependency graph.
 */
function makeSingleFileGraph(file: FileIntrospection): Graph {
    return {
        modules: new Map<string, GraphModule>(),
        files: new Map<string, FileIntrospection>([[file.relPath, file]]),
        bindings: new Map<string, FileBindings>(),
        byExport: new Map()
    };
}

function runOpencodeHeadless(prompt: string, model: string): string {
    const { status, stdout } = ide.spawnHeadless(prompt, model);
    if (status !== 0) {
        console.error(`analyze: opencode run exited with status ${status}`);
    }
    return stdout;
}

function segmentMainFunction(
    mainFunc: MainFunction,
    model: string,
    relPath: string
): string[][] {
    const codeBlock = mainFunc.bodyLines.join('\n');
    const instruction = `You are a code analysis assistant.

Below is the body of a main() function from the module ${relPath}.
Your task is to segment this function into non-overlapping spans by
splitting on whitespace-only lines (blank lines within the function).

Return ONLY a JSON list of lists. Each inner list corresponds to one
span (a group of consecutive non-blank lines between blank-line separators).
Each entry in an inner list is a single line of code from the main() body,
preserved exactly (with original indentation).

Do not include any explanation, markdown fences, or commentary.
Output only the JSON array of arrays of strings.

Code:
\`\`\`
${codeBlock}
\`\`\``;

    const raw = runOpencodeHeadless(instruction, model);
    if (!raw) return [];

    let jsonText = raw;
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    const startIdx = jsonText.indexOf('[');
    const endIdx = jsonText.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        console.error('analyze: could not parse JSON spans from opencode output');
        return [];
    }
    jsonText = jsonText.slice(startIdx, endIdx + 1);

    try {
        const spans = JSON.parse(jsonText);
        if (!Array.isArray(spans)) return [];
        return spans.filter((s) => Array.isArray(s));
    } catch (err) {
        console.error(
            `analyze: failed to parse segment JSON: ${err instanceof Error ? err.message : String(err)}`
        );
        return [];
    }
}

function annotateSegmentsWithLineNumbers(
    segments: string[][],
    mainFunc: MainFunction
): Segment[] {
    const bodyLines = mainFunc.bodyLines;
    const bodyAbsStart = mainFunc.startLine;
    const annotated: Segment[] = [];
    let cursor = 0;

    for (const seg of segments) {
        if (seg.length === 0) {
            annotated.push({ startLine: null, lineCount: 0, lines: [] });
            continue;
        }
        const firstTrim = seg[0].trim();
        let matchedStart = -1;
        for (let i = cursor; i < bodyLines.length; i++) {
            if (bodyLines[i].trim() === firstTrim) {
                matchedStart = i;
                break;
            }
        }
        if (matchedStart === -1) {
            console.error(
                `analyze: segment "${firstTrim.slice(0, 40)}" not matched in body; falling back to cursor ${cursor}`
            );
            matchedStart = cursor;
        }
        const startLine = bodyAbsStart + matchedStart;
        annotated.push({ startLine, lineCount: seg.length, lines: seg });
        cursor = matchedStart + seg.length;
    }
    return annotated;
}

function documentBlock(
    codeLines: string[],
    model: string,
    relPath: string,
    index: number,
    total: number,
    contextLabel: string
): string {
    const code = codeLines.join('\n');
    const instruction = `You are a code documentation assistant.

Below is ${contextLabel} ${index + 1} of ${total} from the module ${relPath}.

Document this code block as a single concise sentence or short paragraph
describing what it does. Do not include the code itself in your output.
Do not use markdown fences. Return only the documentation text.

Code:
\`\`\`
${code}
\`\`\``;
    return runOpencodeHeadless(instruction, model);
}

function displaySegmentedDocs(segments: Segment[], docs: string[], relPath: string): void {
    console.log();
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const lines = seg.lines;
        const doc = docs[i] || '(no documentation)';
        const lineLabel =
            seg.startLine != null
                ? `${relPath}:${seg.startLine} (+${seg.lineCount})`
                : `(+${seg.lineCount})`;
        for (let j = 0; j < lines.length; j++) console.log(`  | ${lines[j]}`);
        console.log(`  +---> ${lineLabel}: ${doc}`);
        console.log();
    }
}

function displayMemberDocs(
    members: PublicMember[],
    docs: string[],
    relPath: string
): void {
    console.log();
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const doc = docs[i] || '(no documentation)';
        const lineLabel = `${relPath}:${m.startLine} (+${m.endLine - m.startLine + 1})`;
        for (const line of m.lines) console.log(`  | ${line}`);
        console.log(`  +---> ${lineLabel} [${m.kind} ${m.name}]: ${doc}`);
        console.log();
    }
}

function analyzeMain(
    mainFunc: MainFunction,
    model: string,
    relPath: string
): { segments: Segment[]; docs: string[] } {
    console.log(
        `\nSegmenting main() (lines ${mainFunc.startLine}-${mainFunc.endLine}) via opencode...`
    );
    const rawSegments = segmentMainFunction(mainFunc, model, relPath);
    if (rawSegments.length === 0) {
        console.log('analyze: no segments produced; skipping documentation.');
        return { segments: [], docs: [] };
    }
    const segments = annotateSegmentsWithLineNumbers(rawSegments, mainFunc);
    console.log(`\nDocumenting ${segments.length} block(s) via opencode...`);
    const docs: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        process.stdout.write(`  block ${i + 1}/${segments.length} ... `);
        const doc = documentBlock(
            segments[i].lines,
            model,
            relPath,
            i,
            segments.length,
            'code block'
        );
        docs.push(doc);
        console.log(doc ? `${doc.substring(0, 70)}${doc.length > 70 ? '...' : ''}` : '(no output)');
    }
    return { segments, docs };
}

function analyzePublicMembers(
    members: PublicMember[],
    model: string,
    relPath: string
): { members: PublicMember[]; docs: string[] } {
    console.log(`\nDocumenting ${members.length} public member(s) via opencode...`);
    const docs: string[] = [];
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        process.stdout.write(`  ${m.kind} ${m.name} (${i + 1}/${members.length}) ... `);
        const doc = documentBlock(m.lines, model, relPath, i, members.length, `public ${m.kind}`);
        docs.push(doc);
        console.log(doc ? `${doc.substring(0, 70)}${doc.length > 70 ? '...' : ''}` : '(no output)');
    }
    return { members, docs };
}

/**
 * Print a condensed source-map summary of a file using the introspect
 * layer. Replaces the old printIntelligence function.
 */
async function printIntelligence(
    relPath: string,
    content: string,
    ext: string
): Promise<{
    imports: string[];
    mainFunc: MainFunction | null;
    members: PublicMember[];
}> {
    const modules = listAllModules();
    const resolved = resolveModule(relPath, modules);
    if (!resolved) throw new Error(`Module not found: ${relPath}`);
    const absPath = resolved.module.abs;

    const file = await introspectFile(absPath);

    const oneStepResults: Record<string, Awaited<ReturnType<typeof resolveOneStep>>> = {};
    const graph = makeSingleFileGraph(file);
    for (const decl of file.declarations) {
        oneStepResults[decl.name] = await resolveOneStep(decl, file, graph);
    }

    console.log(formatFileSummary(file, { oneStepResults }));

    const imports = file.imports.map((imp) => imp.name);
    const mainFunc = await languages.extractMainFunction(content, ext);
    const members: PublicMember[] = file.declarations.map((d) => ({
        name: d.name,
        kind: d.kind,
        startLine: d.startLine,
        endLine: d.endLine,
        lines: d.lines
    }));

    return { imports, mainFunc, members };
}

/**
 * Run the full opencode documentation pass: segment main(), document each
 * block / member, display, and optionally memoize. Requires --document.
 */
async function runDocumentationPass(
    relPath: string,
    content: string,
    ext: string,
    { verbose, yes, model }: { verbose?: boolean; yes?: boolean; model: string }
): Promise<void> {
    const imports = await languages.parseImports(content, ext);
    if (imports.length > 0) {
        const importMemoStr = `imports: ${imports.join('; ')}`;
        memo.remember(relPath, importMemoStr);
        if (verbose) console.log(`  ${importMemoStr}`);
    }

    if (!model) {
        console.error('analyze: no model available; cannot run opencode analysis');
        exit(1);
        return;
    }

    const mainFunc = await languages.extractMainFunction(content, ext);
    let segments: Segment[] = [];
    let docs: string[] = [];
    let members: PublicMember[] = [];
    let memberDocs: string[] = [];
    let usedFallback = false;

    if (mainFunc) {
        const result = analyzeMain(mainFunc, model, relPath);
        segments = result.segments;
        docs = result.docs;
        if (segments.length === 0) {
            console.log(`\n✓ Analysis complete for ${relPath}`);
            return;
        }
        displaySegmentedDocs(segments, docs, relPath);
    } else {
        members = await languages.extractPublicMembers(content, ext);
        if (members.length === 0) {
            console.log(
                `\n✓ No main() and no public members found in ${relPath}; nothing to analyze.`
            );
            console.log(`✓ Analysis complete for ${relPath}`);
            return;
        }
        console.log(`\nNo main() found; analyzing ${members.length} public member(s).`);
        usedFallback = true;
        const result = analyzePublicMembers(members, model, relPath);
        memberDocs = result.docs;
        displayMemberDocs(members, memberDocs, relPath);
    }

    const blockCount = usedFallback ? members.length : segments.length;
    const interactive = isInteractive();

    const memoize = () => {
        if (usedFallback) {
            for (let i = 0; i < members.length; i++) {
                const m = members[i];
                const doc = memberDocs[i] || '(no documentation)';
                memo.remember(relPath, `${m.startLine}: ${doc}`);
            }
        } else {
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const doc = docs[i] || '(no documentation)';
                const prefix = seg.startLine != null ? `${seg.startLine}` : `block-${i + 1}`;
                memo.remember(relPath, `${prefix}: ${doc}`);
            }
        }
        console.log(`\n✓ Memoized ${blockCount} block(s) for ${relPath}`);
    };

    let memoized = false;
    if (yes) {
        memoize();
        memoized = true;
    } else if (interactive) {
        const iface = Interface.createInterface('analyze');
        const confirmed = await iface.confirm(
            `Memoize ${blockCount} block(s) of documentation to ${relPath}?`,
            false
        );
        if (confirmed) {
            memoize();
            memoized = true;
        }
    }

    console.log(`\n✓ Analysis complete for ${relPath}${memoized ? '' : ' (not memoized)'}`);
}

/**
 * Load and analyse a module.
 *
 * Default mode prints code intelligence (imports, main(), public members)
 * as a neat list with no opencode calls. Pass `document: true` to run the
 * opencode documentation pass (segment, document, memoize).
 *
 * If `moduleRef` is null, launches a TUI select to pick a module.
 */
async function load(
    moduleRef: string | null,
    options: { verbose?: boolean; yes?: boolean; document?: boolean; model?: string } = {}
): Promise<unknown> {
    const verbose = options.verbose || false;
    const yes = options.yes || false;
    const document = options.document || false;

    let resolved;
    if (moduleRef) {
        resolved = resolveModule(moduleRef, listAllModules());
    } else {
        const modules = listAllModules();
        if (modules.length === 0) {
            console.error('analyze: no modules found.');
            return exit(1);
        }
        if (!isInteractive()) {
            return exit('analyze: selecting a module requires an interactive terminal.');
        }
        const iface = Interface.createInterface('analyze');
        const choices = modules.map((m) => ({
            name: m.path,
            message: m.path
        }));
        const selection = await iface.select('Select a module to analyze:', choices, {
            nonInteractiveBehavior: 'fail'
        });
        if (typeof selection !== 'string') return selection;
        resolved = resolveModule(selection, modules);
    }
    if (!resolved) throw new Error(`Module not found: ${moduleRef}`);
    const mod = resolved.module;
    const modulePath = mod.abs;
    const relPath = mod.path;
    const ext = path.extname(modulePath).toLowerCase();
    const content = fs.readFileSync(modulePath, 'utf-8');

    console.log(`Semantic analysis of: ${relPath} (${ext.replace(/^\./, '')})`);

    if (!document) {
        // TODO(whole-object): pass the resolved Module (mod) instead of dismembered relPath/content/ext — see §lib-classes
        return printIntelligence(relPath, content, ext);
    }

    const model = options.model || models.resolveDefault();
    // TODO(whole-object): pass the resolved Module (mod) instead of dismembered relPath/content/ext — see §lib-classes
    return runDocumentationPass(relPath, content, ext, { verbose, yes, model });
}

const meta = defineMeta({
    name: 'analyze',
    description:
        'Analyze a module: print a condensed source map (imports, declarations with 1-step resolution, exports). Accepts one or multiple modules. Pass --trace <module::name> to walk the full dependency chain. Pass --usage <module::name> to launch a TUI showing all project-wide references to that binding. Pass --document for an opencode documentation pass.',
    usage: 'node index.js analyze [module...] [--trace <name>] [--usage <name>] [--graph] [--oneline] [--document] [--yes] [-v] [--clear-cache]',
    args: [{ name: 'module', required: false }],
    options: [
        {
            flag: '--trace <name>',
            description: 'Trace a binding chain (module::name or just name)'
        },
        {
            flag: '--usage <name>',
            description:
                'Launch TUI showing all project-wide references to a binding (module::name)'
        },
        { flag: '--graph', description: 'Print the resolved import graph' },
        { flag: '--oneline', description: 'Condensed one-line summary per module' },
        {
            flag: '--document',
            description: 'Run opencode documentation pass (segment, document, memoize)'
        },
        { flag: '--model <id>', description: 'Model id for the opencode documentation pass' },
        { flag: '--clear-cache', description: 'Clear the introspect tool cache' },
        { flag: '-v, --verbose', description: 'Verbose output' },
        { flag: '-y, --yes', description: 'Skip confirmation prompts' }
    ]
});

export { meta };

export default new CLI(
    'analyze.ts',
    async (opts, positional) => {
        const args = Array.isArray(positional) ? positional : [];
        const verbose = !!opts.verbose;
        const yes = !!opts.yes;
        const document = !!opts.document;
        const oneline = !!opts.oneline;
        const showGraph = !!opts.graph;
        const traceName = opts.trace || null;
        const usageName = opts.usage || null;
        const clearCache = !!opts.clearCache;

        try {
            if (clearCache) {
                return exit(
                    new TUI(
                        'analyze.ts',
                        async () => {
                            const iface = Interface.createInterface('analyze');
                            const confirmed = await iface.confirm(
                                'Clear the introspect tool cache? This will reset all module binding analyses.',
                                false
                            );
                            if (!confirmed)
                                return exit(0, () => console.log('introspect: cache not cleared.'));
                            store.clearIntrospectCache();
                            console.log('introspect: cache cleared');
                        },
                        meta
                    )
                );
            }

            if (traceName) {
                const traceParts = traceName.split('::');
                const traceModule = traceParts[0].trim();
                const traceBinding = traceParts.slice(1).join('::').trim();

                if (!traceModule) {
                    console.error(
                        'analyze: --trace requires a module path (e.g., --trace scripts/list.ts::listModules)'
                    );
                    return exit(1);
                }

                // TODO(whole-object): use discovery's resolveModule() instead of this hand-rolled endsWith re-resolution — see §lib-classes
                const module = listAllModules().find(
                    (m) => m.path === traceModule || m.abs.endsWith(traceModule)
                );
                if (!module) {
                    console.error(`analyze: module "${traceModule}" not found`);
                    return exit(1);
                }

                // TODO(whole-object): pass the resolved Module instead of the traceModule string (runTrace re-resolves it) — see §lib-classes
                return await runTrace([traceModule], traceName);
            }

            if (usageName) {
                const usageParts = usageName.split('::');
                if (usageParts.length < 2) {
                    console.error(
                        'analyze: --usage requires a module::name (e.g., --usage lib/core.ts::exit)'
                    );
                    return exit(1);
                }
                const usageModule = usageParts[0].trim();

                // TODO(whole-object): use discovery's resolveModule() instead of this hand-rolled endsWith re-resolution — see §lib-classes
                const module = listAllModules().find(
                    (m) => m.path === usageModule || m.abs.endsWith(usageModule)
                );
                if (!module) {
                    console.error(`analyze: module "${usageModule}" not found`);
                    return exit(1);
                }

                // TODO(whole-object): pass the Module (module) as the seed instead of module.path — see §lib-classes
                const graph = await buildGraph([module.path], { codebaseScope: true });
                const trace = new Trace(graph, usageName);
                const result = trace.usage();

                console.log(`\nUsage trace: ${usageName}`);
                console.log(
                    `  ${result.producers.length} producer(s), ${result.consumers.length} consumer(s), ${result.reExportChains.length} re-export chain(s)\n`
                );

                if (result.producers.length > 0) {
                    console.log('Producers:');
                    for (const p of result.producers) {
                        console.log(`  ${p.module}:${p.line} (${p.type})`);
                    }
                }

                if (result.consumers.length > 0) {
                    console.log('\nConsumers:');
                    for (const c of result.consumers) {
                        console.log(`  ${c.module}:${c.line} (via ${c.via})`);
                    }
                }

                if (result.reExportChains.length > 0) {
                    console.log('\nRe-export chains:');
                    for (const c of result.reExportChains) {
                        console.log(`  ${c.from} → ${c.to} (${c.binding})`);
                    }
                }

                const references = result.references.filter((r) => r.line !== null);
                if (references.length === 0) {
                    console.log('\nNo file:line references found.');
                    return exit(0);
                }

                console.log(`\n${references.length} file:line reference(s) found.`);

                if (yes) {
                    for (const ref of references) {
                        const content = `usage-ref: ${ref.file}:${ref.line} (${ref.kind}${ref.via ? ', via ' + ref.via : ''}) → ${usageName}`;
                        memo.remember(module.path, content);
                    }
                    console.log(`Memoized ${references.length} reference(s) on ${module.path}.`);
                } else if (isInteractive()) {
                    const iface = Interface.createInterface('analyze');
                    const memoize = await iface.confirm(
                        'Memoize these references on the target module?',
                        true
                    );
                    if (memoize) {
                        for (const ref of references) {
                            const content = `usage-ref: ${ref.file}:${ref.line} (${ref.kind}${ref.via ? ', via ' + ref.via : ''}) → ${usageName}`;
                            memo.remember(module.path, content);
                        }
                        console.log(
                            `Memoized ${references.length} reference(s) on ${module.path}.`
                        );
                    }
                }

                return exit(0);
            }

            if (document) {
                const moduleArg = args.length > 0 ? args[0] : null;
                await load(moduleArg, { verbose, yes, document, model: opts.model });
                return exit(0);
            }

            const moduleArgs = args.length > 0 ? args : null;

            if (showGraph) {
                return await runGraph(moduleArgs);
            }

            return await runSummary(moduleArgs, { oneline });
        } catch (err) {
            console.error('Error:', err instanceof Error ? err.message : String(err));
            return exit(1);
        }
    },
    meta
).supportsDirectRunning();

async function resolveModuleList(
    moduleArgs: string[] | null
): Promise<Module[] | ExitSignal | null> {
    if (!moduleArgs) {
        const modules = listAllModules();
        if (modules.length === 0) {
            console.error('analyze: no modules found.');
            return null;
        }
        const choices = modules.map((m) => ({ name: m.path, message: m.path }));
        const selection = await promptModuleChoices('Select a module to analyze:', choices, {
            limit: 12
        });
        const resolved = resolveModule(selection, modules);
        return resolved ? [resolved.module] : null;
    }

    const modules = listAllModules();
    const resolved = moduleArgs
        .map((arg: string) => {
            const r = resolveModule(arg, modules);
            return r ? r.module : null;
        })
        .filter((m): m is Module => m !== null);

    if (resolved.length === 0) {
        console.error('analyze: no modules resolved from args');
        return null;
    }

    return resolved;
}

async function runSummary(
    moduleArgs: string[] | null,
    { oneline }: { oneline: boolean }
): Promise<unknown> {
    const modules = await resolveModuleList(moduleArgs);
    if (modules instanceof ExitSignal) return modules;
    if (!modules) return exit(1);

    for (const mod of modules) {
        const file = await introspectFile(mod.abs);

        const oneStepResults: Record<string, Awaited<ReturnType<typeof resolveOneStep>>> = {};
        const graph = makeSingleFileGraph(file);
        for (const decl of file.declarations) {
            oneStepResults[decl.name] = await resolveOneStep(decl, file, graph);
        }

        console.log(formatFileSummary(file, { oneline, oneStepResults }));
        console.log();
    }

    return exit(0);
}

async function runTrace(
    moduleArgs: string[] | null,
    traceName: string
): Promise<unknown> {
    const modules = await resolveModuleList(moduleArgs);
    if (modules instanceof ExitSignal) return modules;
    if (!modules) return exit(1);

    const seeds = modules.map((m) => m.path);
    // TODO(whole-object): pass the Module[] (modules) as seeds instead of pre-dismembered m.path strings — see §lib-classes
    const graph = await buildGraph(seeds, { codebaseScope: true });

    const result = await traceBinding(graph, traceName);
    console.log(formatTrace(result));

    if (result.issues && result.issues.length > 0) {
        console.error(`\n${result.issues.length} issue(s) found in trace chain`);
        return exit(1);
    }

    return exit(0);
}

async function runGraph(moduleArgs: string[] | null): Promise<unknown> {
    const modules = await resolveModuleList(moduleArgs);
    if (modules instanceof ExitSignal) return modules;
    if (!modules) return exit(1);

    const seeds = modules.map((m) => m.path);
    // TODO(whole-object): pass the Module[] (modules) as seeds instead of pre-dismembered m.path strings — see §lib-classes
    const graph = await buildGraph(seeds, { codebaseScope: false });

    console.log(`\nResolved import graph (${graph.modules.size} modules):\n`);
    for (const [relPath, mod] of graph.modules) {
        const file = graph.files.get(relPath);
        const impCount = file ? file.imports.length : 0;
        const expCount = file ? file.exports.length : 0;
        const declCount = file ? file.declarations.length : 0;
        console.log(
            `  ${relPath}  (${impCount} imports, ${declCount} declarations, ${expCount} exports)`
        );
    }
    console.log();

    return exit(0);
}
