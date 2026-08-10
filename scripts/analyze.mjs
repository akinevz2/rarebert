#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { listAllModules } from '../lib/modules.mjs';
import { memo } from '../lib/memo.mjs';
import { models } from '../lib/models.mjs';
import { opencode } from '../lib/opencode.mjs';
import { languages } from '../lib/languages.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

const meta = {
    name: 'analyze',
    description:
        'Analyze a module: record imports (foo::mod / foo<-mod / mod notation), segment the main() function into whitespace-delimited blocks via opencode, document each block, and memoize the documentation. Falls back to documenting public members when no main() exists.',
    usage: 'node index.js analyze <module> [--yes] [-v]',
    options: [
        { flag: 'yes', label: '', description: 'memoize documentation without confirmation' },
        { flag: 'v, verbose', label: '', description: 'show verbose output' }
    ]
};

/**
 * Run opencode headlessly (non-interactive) with a given prompt.
 * Returns the trimmed stdout string.
 */
function runOpencodeHeadless(prompt, model) {
    const args = ['run', prompt, '-m', model, '--auto'];
    console.log(`$ opencode run "<prompt: ${prompt.length} bytes>" -m ${model} --auto`);
    const result = spawnSync(opencode.resolve(), args, {
        cwd: rarebert.root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit']
    });
    if (result.status !== 0) {
        console.error(`analyze: opencode run exited with status ${result.status ?? 0}`);
    }
    return (result.stdout ?? '').trim();
}

/**
 * Segment the main() body into non-overlapping spans by asking opencode
 * to split on whitespace-only lines. Returns a JSON list of lists:
 * each inner list is a group of consecutive code lines (strings).
 */
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

    // Extract JSON from the response (strip markdown fences if present)
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

/**
 * Given opencode-returned segments (lists of code line strings) and the
 * main() function body, reconstruct the absolute starting line number
 * for each segment by sequentially matching lines against the body.
 *
 * Returns segments annotated as { startLine, lineCount, lines }.
 */
function annotateSegmentsWithLineNumbers(segments, mainFunc) {
    const bodyLines = mainFunc.bodyLines;
    const bodyAbsStart = mainFunc.startLine; // 1-indexed absolute
    const annotated = [];
    let cursor = 0; // index into bodyLines

    for (const seg of segments) {
        if (seg.length === 0) {
            annotated.push({ startLine: null, lineCount: 0, lines: [] });
            continue;
        }
        const firstTrim = seg[0].trim();

        // Advance cursor past blank lines and non-matching lines until we
        // find the segment's first line. This tolerates opencode dropping
        // or lightly normalising whitespace-only separator lines.
        let matchedStart = -1;
        for (let i = cursor; i < bodyLines.length; i++) {
            if (bodyLines[i].trim() === firstTrim) {
                matchedStart = i;
                break;
            }
        }
        if (matchedStart === -1) {
            // Fallback: use the current cursor position.
            matchedStart = cursor;
        }

        const startLine = bodyAbsStart + matchedStart;
        annotated.push({
            startLine,
            lineCount: seg.length,
            lines: seg
        });
        cursor = matchedStart + seg.length;
    }

    return annotated;
}

/**
 * Ask opencode to document a single code block as a single sentence or
 * short paragraph. Returns the trimmed documentation string.
 */
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

/**
 * Display the code lines with an ASCII pipe pointing at the opencode summary.
 * Each block header is `module_path.ext:startLine (+lineCount)`.
 */
function displaySegmentedDocs(segments, docs, relPath) {
    console.log();
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const lines = seg.lines;
        const doc = docs[i] || '(no documentation)';
        const lineLabel =
            seg.startLine != null
                ? `${relPath}:${seg.startLine} (+${seg.lineCount})`
                : `(+${seg.lineCount})`;

        for (let j = 0; j < lines.length; j++) {
            console.log(`  | ${lines[j]}`);
        }
        console.log(`  +---> ${lineLabel}: ${doc}`);
        console.log();
    }
}

/**
 * Display public-member docs (no-main fallback) with the same layout.
 */
function displayMemberDocs(members, docs, relPath) {
    console.log();
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const doc = docs[i] || '(no documentation)';
        const lineLabel = `${relPath}:${m.startLine} (+${m.endLine - m.startLine + 1})`;

        for (const line of m.lines) {
            console.log(`  | ${line}`);
        }
        console.log(`  +---> ${lineLabel} [${m.kind} ${m.name}]: ${doc}`);
        console.log();
    }
}

/**
 * Resolve a module reference (path, name, or relative path) to an
 * absolute path. Throws if not found.
 */
function resolveModulePath(moduleRef) {
    if (!moduleRef) throw new Error('Module reference is required');

    if (fs.existsSync(path.resolve(moduleRef))) {
        return path.resolve(moduleRef);
    }
    if (rarebert.relPath(moduleRef)) {
        const found = listAllModules().find((m) => m.path === moduleRef || m.name === moduleRef);
        if (found) return found.abs;
    }
    throw new Error(`Module not found: ${moduleRef}`);
}

/**
 * Segment + document a main() function. Returns { segments, docs } where
 * each segment is annotated with startLine / lineCount.
 */
async function analyzeMain(mainFunc, model, relPath) {
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
    const docs = [];
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

/**
 * Document each public member when no main() exists. Returns { members, docs }.
 */
async function analyzePublicMembers(members, model, relPath) {
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

async function load(moduleRef, options = {}) {
    const verbose = options.verbose || false;
    const yes = options.yes || false;

    const modulePath = resolveModulePath(moduleRef);
    const relPath = rarebert.relPath(modulePath);
    const ext = path.extname(modulePath).toLowerCase();
    const content = fs.readFileSync(modulePath, 'utf-8');

    console.log(`Semantic analysis of: ${relPath} (${ext.replace(/^\./, '')})`);

    // --- Imports (delegated to the language support module) ---
    const imports = await languages.parseImports(content, ext);
    if (imports.length > 0) {
        const importMemoStr = `imports: ${imports.join('; ')}`;
        memo.remember(modulePath, importMemoStr);
        if (verbose) console.log(`  ${importMemoStr}`);
    }

    const model = await models.resolve(null);
    if (!model) {
        console.error('analyze: no model available; cannot run opencode analysis');
        return exit(1);
    }

    // --- Segment main() and document each block ---
    const mainFunc = await languages.extractMainFunction(content, ext);
    let segments = [];
    let docs = [];
    let members = [];
    let memberDocs = [];
    let usedFallback = false;

    if (mainFunc) {
        const result = await analyzeMain(mainFunc, model, relPath);
        segments = result.segments;
        docs = result.docs;

        if (segments.length === 0) {
            console.log(`\n✓ Analysis complete for ${relPath}`);
            return { path: modulePath, relative: relPath, language: ext, segments, docs };
        }

        displaySegmentedDocs(segments, docs, relPath);
    } else {
        // --- No main(): forward public members to opencode ---
        members = await languages.extractPublicMembers(content, ext);
        if (members.length === 0) {
            console.log(
                `\n✓ No main() and no public members found in ${relPath}; nothing to analyze.`
            );
            console.log(`✓ Analysis complete for ${relPath}`);
            return { path: modulePath, relative: relPath, language: ext, segments: [], docs: [] };
        }

        console.log(`\nNo main() found; analyzing ${members.length} public member(s).`);
        usedFallback = true;
        const result = await analyzePublicMembers(members, model, relPath);
        memberDocs = result.docs;

        displayMemberDocs(members, memberDocs, relPath);
    }

    // --- Memoization flow ---
    // Non-interactive without --yes: finish (no memoize)
    // Non-interactive with --yes: memoize without confirmation
    // Interactive without --yes: prompt for confirmation
    // Interactive with --yes: memoize without confirmation
    const interactive = cli.isInteractive();
    const blockCount = usedFallback ? members.length : segments.length;

    const memoize = () => {
        if (usedFallback) {
            for (let i = 0; i < members.length; i++) {
                const m = members[i];
                const doc = memberDocs[i] || '(no documentation)';
                memo.remember(modulePath, `${m.startLine}: ${doc}`);
            }
        } else {
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const doc = docs[i] || '(no documentation)';
                const prefix = seg.startLine != null ? `${seg.startLine}` : `block-${i + 1}`;
                memo.remember(modulePath, `${prefix}: ${doc}`);
            }
        }
        console.log(`\n✓ Memoized ${blockCount} block(s) for ${relPath}`);
    };

    if (!interactive) {
        if (!yes) {
            console.log(`\n✓ Analysis complete for ${relPath} (non-interactive, not memoized)`);
            return { path: modulePath, relative: relPath, language: ext, segments, docs };
        }
        memoize();
        return { path: modulePath, relative: relPath, language: ext, segments, docs };
    }

    // Interactive
    if (yes) {
        memoize();
        return { path: modulePath, relative: relPath, language: ext, segments, docs };
    }

    const confirmed = await cli.confirm(
        `Memoize ${blockCount} block(s) of documentation to ${relPath}?`,
        false
    );
    if (!confirmed) {
        console.log(`\n✓ Analysis complete for ${relPath} (not memoized)`);
        return { path: modulePath, relative: relPath, language: ext, segments, docs };
    }

    memoize();
    return { path: modulePath, relative: relPath, language: ext, segments, docs };
}

async function main(args = []) {
    if (args.length === 0) {
        console.error('Usage: node index.js analyze <module> [--yes] [-v]');
        return exit(1);
    }

    const moduleArg = args.find((a) => !a.startsWith('-') && a);
    const verbose = args.includes('-v') || args.includes('--verbose');
    const yes = args.includes('--yes') || args.includes('-y');

    if (!moduleArg) {
        console.error('Usage: node index.js analyze <module> [--yes] [-v]');
        return exit(1);
    }

    try {
        await load(moduleArg, { verbose, yes });
    } catch (err) {
        console.error('Error:', err.message);
        return exit(1);
    }

    return exit(0);
}

export { load, main };

export default {
    name: 'analyze',
    description:
        'Analyze a module: record imports (foo::mod / foo<-mod / mod notation), segment the main() function into whitespace-delimited blocks via opencode, document each block, and memoize the documentation. Falls back to documenting public members when no main() exists.',
    usage: 'node index.js analyze <module> [--yes] [-v]',
    options: [
        { flag: 'yes', label: '', description: 'memoize documentation without confirmation' },
        { flag: 'v, verbose', label: '', description: 'show verbose output' }
    ],
    main: cli.run(meta, main)
};
