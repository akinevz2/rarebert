import fs from 'fs';
import path from 'path';
import { exit } from './core.mjs';
import { listAllModules, resolveModule, cli, TUI } from './module.mjs';
import { memo } from './memo.mjs';
import { models } from './models.mjs';
import { ide } from './ide.mjs';
import { languages } from './languages.mjs';
import { introspectFile, formatFileSummary, resolveOneStep } from './introspect.mjs';

// Prompt helpers ride on a TUI class instance created at runtime — there is
// no shared tui singleton (see the TUI class in lib/module.mjs).
const tui = new TUI('analyze.mjs');

// REQUEST: runDocumentationPass loads and caches opencode output. On ctrl-c:
// - Allow current opencode call to finish
// - Return the last successful result
// - No cleanup needed for this module
// Meta suggestion: { retryOnFailure: false, cleanup: 'none' }

// REQUEST: runDocumentationPass loads and caches opencode output. On ctrl-c:
// - Allow current opencode call to finish
// - Return the last successful result
// - No cleanup needed for this module
// Meta suggestion: { retryOnFailure: false, cleanup: 'none' }

function runOpencodeHeadless(prompt, model) {
    const { status, stdout } = ide.spawnHeadless(prompt, model);
    if (status !== 0) {
        console.error(`analyze: opencode run exited with status ${status}`);
    }
    return stdout;
}

function segmentMainFunction(mainFunc, model, relPath) {
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
        console.error(`analyze: failed to parse segment JSON: ${err.message}`);
        return [];
    }
}

function annotateSegmentsWithLineNumbers(segments, mainFunc) {
    const bodyLines = mainFunc.bodyLines;
    const bodyAbsStart = mainFunc.startLine;
    const annotated = [];
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
            console.error(`analyze: segment "${firstTrim.slice(0, 40)}" not matched in body; falling back to cursor ${cursor}`);
            matchedStart = cursor;
        }
        const startLine = bodyAbsStart + matchedStart;
        annotated.push({ startLine, lineCount: seg.length, lines: seg });
        cursor = matchedStart + seg.length;
    }
    return annotated;
}

function documentBlock(codeLines, model, relPath, index, total, contextLabel) {
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

function displaySegmentedDocs(segments, docs, relPath) {
    console.log();
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const lines = seg.lines;
        const doc = docs[i] || '(no documentation)';
        const lineLabel = seg.startLine != null
            ? `${relPath}:${seg.startLine} (+${seg.lineCount})`
            : `(+${seg.lineCount})`;
        for (let j = 0; j < lines.length; j++) console.log(`  | ${lines[j]}`);
        console.log(`  +---> ${lineLabel}: ${doc}`);
        console.log();
    }
}

function displayMemberDocs(members, docs, relPath) {
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

function analyzeMain(mainFunc, model, relPath) {
    console.log(`\nSegmenting main() (lines ${mainFunc.startLine}-${mainFunc.endLine}) via opencode...`);
    const rawSegments = segmentMainFunction(mainFunc, model, relPath);
    if (rawSegments.length === 0) {
        console.log('analyze: no segments produced; skipping documentation.');
        return { segments: [], docs: [] };
    }
    const segments = annotateSegmentsWithLineNumbers(rawSegments, mainFunc);
    console.log(`\nDocumenting ${segments.length} block(s) via opencode...`);
    const docs = [];
    for (let i = 0; i < segments.length; i++) {
        process.stdout.write(`  block ${i + 1}/${segments.length} ... `);
        const doc = documentBlock(segments[i].lines, model, relPath, i, segments.length, 'code block');
        docs.push(doc);
        console.log(doc ? `${doc.substring(0, 70)}${doc.length > 70 ? '...' : ''}` : '(no output)');
    }
    return { segments, docs };
}

function analyzePublicMembers(members, model, relPath) {
    console.log(`\nDocumenting ${members.length} public member(s) via opencode...`);
    const docs = [];
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
async function printIntelligence(relPath, content, ext) {
    const modules = listAllModules();
    const resolved = resolveModule(relPath, modules);
    if (!resolved) throw new Error(`Module not found: ${relPath}`);
    const absPath = resolved.module.abs;

    const file = await introspectFile(absPath);

    const oneStepResults = {};
    const graph = { files: new Map([[file.relPath, file]]) };
    for (const decl of file.declarations) {
        oneStepResults[decl.name] = await resolveOneStep(decl, file, graph);
    }

    console.log(formatFileSummary(file, { oneStepResults }));

    const imports = file.imports.map((imp) => imp.name);
    const mainFunc = await languages.extractMainFunction(content, ext);
    const members = file.declarations.map((d) => ({ name: d.name, kind: d.kind, startLine: d.startLine, endLine: d.endLine }));

    return { imports, mainFunc, members };
}

/**
 * Run the full opencode documentation pass: segment main(), document each
 * block / member, display, and optionally memoize. Requires --document.
 */
async function runDocumentationPass(relPath, content, ext, { verbose, yes, model }) {
    const imports = await languages.parseImports(content, ext);
    if (imports.length > 0) {
        const importMemoStr = `imports: ${imports.join('; ')}`;
        memo.remember(relPath, importMemoStr);
        if (verbose) console.log(`  ${importMemoStr}`);
    }

    if (!model) {
        console.error('analyze: no model available; cannot run opencode analysis');
        return exit(1);
    }

    const mainFunc = await languages.extractMainFunction(content, ext);
    let segments = [];
    let docs = [];
    let members = [];
    let memberDocs = [];
    let usedFallback = false;

    if (mainFunc) {
        const result = analyzeMain(mainFunc, model, relPath);
        segments = result.segments;
        docs = result.docs;
        if (segments.length === 0) {
            console.log(`\n✓ Analysis complete for ${relPath}`);
            return { path: relPath, relative: relPath, language: ext, segments, docs };
        }
        displaySegmentedDocs(segments, docs, relPath);
    } else {
        members = await languages.extractPublicMembers(content, ext);
        if (members.length === 0) {
            console.log(`\n✓ No main() and no public members found in ${relPath}; nothing to analyze.`);
            console.log(`✓ Analysis complete for ${relPath}`);
            return { path: relPath, relative: relPath, language: ext, segments: [], docs: [] };
        }
        console.log(`\nNo main() found; analyzing ${members.length} public member(s).`);
        usedFallback = true;
        const result = analyzePublicMembers(members, model, relPath);
        memberDocs = result.docs;
        displayMemberDocs(members, memberDocs, relPath);
    }

    const blockCount = usedFallback ? members.length : segments.length;
    const interactive = cli.isInteractive();

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
        const confirmed = await tui.confirm(`Memoize ${blockCount} block(s) of documentation to ${relPath}?`, false);
        if (confirmed) {
            memoize();
            memoized = true;
        }
    }

    console.log(`\n✓ Analysis complete for ${relPath}${memoized ? '' : ' (not memoized)'}`);
    return { path: relPath, relative: relPath, language: ext, segments, docs };
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
async function load(moduleRef, options = {}) {
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
        const choices = modules.map((m) => ({
            name: m.path,
            message: m.path
        }));
        const selection = await tui.select('Select a module to analyze:', choices, {
            nonInteractiveBehavior: 'fail'
        });
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
        return printIntelligence(relPath, content, ext);
    }

    const model = options.model || models.resolveDefault();
    return runDocumentationPass(relPath, content, ext, { verbose, yes, model });
}

export {
    runOpencodeHeadless,
    segmentMainFunction,
    annotateSegmentsWithLineNumbers,
    documentBlock,
    displaySegmentedDocs,
    displayMemberDocs,
    analyzeMain,
    analyzePublicMembers,
    printIntelligence,
    runDocumentationPass,
    load
};
export default { load };