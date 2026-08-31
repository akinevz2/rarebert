#!/usr/bin/env node

/**
 * scripts/present.mjs — Presentation engine for change review (merged from
 * lib/present.mjs, its only consumer).
 *
 * Generates slides from git diffs and opens them in the user's editor,
 * blocking on each until the user closes the tab. When a slide has
 * both a start and end line, the start is launched fire-and-forget
 * and the end is opened with --wait — so both positions are in the
 * editor's jump list and closing the end-line tab advances.
 *
 * Editor resolution and line-goto launching live in lib/ide.mjs
 * (ide.resolveEditor, ide.openAtLine).
 *
 * REQUEST: buildPresentation() and walkSlides() should be converted to TUI submodules.
 * walkSlides iterates through slides - should be a TUI that presents each slide and
 * handles navigation. On ctrl-c:
 * - Allow user to exit gracefully (exit 0 on single ctrl-c)
 * - Double ctrl-c terminates immediately
 * Meta suggestion: { retryOnFailure: false, cleanup: 'none' }
 */

import fs from 'fs';
import path from 'path';
import { models } from '../lib/models.mjs';
import { exit } from '../lib/core.mjs';
import { CLI, cli, TUI, Interface } from '../lib/module.mjs';
import { git } from '../lib/git.mjs';
import { rarebert } from '../lib/projects.mjs';
import { ide } from '../lib/ide.mjs';
import { DIAMOND, GREEN_TICK } from '../lib/symbols.mjs';

// ─── Slide presentation ────────────────────────────────────────

/**
 * Present a single slide. If the slide has both `line` and `endLine`,
 * launches at the start line (fire-and-forget) then opens at the end
 * line with --wait (blocks until closed). Both positions land in the
 * editor's jump list — the user can use Ctrl-O/Ctrl-I to visualise
 * the span. Closing the end-line tab is the signal to advance.
 *
 * For single-line slides or terminal editors, just opens and blocks.
 */
function presentSlide(slide) {
    const editor = ide.resolveEditor();
    const filePath = path.isAbsolute(slide.file)
        ? slide.file
        : path.join(rarebert.root, slide.file);

    const hasEnd = slide.endLine && slide.endLine !== slide.line;
    const supportsBlockView = editor.kind === 'code';

    if (hasEnd && supportsBlockView) {
        ide.openAtLine(filePath, slide.line, slide.column, false);
        ide.openAtLine(filePath, slide.endLine, slide.column, true);
    } else {
        ide.openAtLine(filePath, slide.line, slide.column, true);
    }
}

/**
 * Play all slides in a presentation back-to-back, blocking on each.
 */
function present(presentation) {
    for (const slide of presentation.slides) {
        presentSlide(slide);
    }
}

/**
 * Open a single slide by index, block until closed.
 */
function presentOne(presentation, index) {
    const total = presentation.slides.length;
    if (index < 0 || index >= total) {
        return exit(`present: index ${index} out of range (0–${total - 1})`);
    }
    presentSlide(presentation.slides[index]);
}

// ─── Diff-to-slides ────────────────────────────────────────────

/**
 * Parse `git diff --unified=0` output into presentation slides.
 * Each hunk becomes one slide with the file path and the new-side
 * line range.
 */
function parseDiff(diff) {
    const slides = [];
    const lines = diff.split('\n');
    let currentFile = null;

    for (const line of lines) {
        const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (fileMatch) {
            currentFile = fileMatch[2];
            continue;
        }

        const srcMatch = line.match(/^--- (.+)$/);
        if (srcMatch && srcMatch[1] !== '/dev/null') {
            currentFile = srcMatch[1].replace(/^a\//, '');
            continue;
        }

        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch && currentFile) {
            const startLine = parseInt(hunkMatch[1], 10);
            const count = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
            const endLine = count > 1 ? startLine + count - 1 : startLine;

            if (count > 0) {
                slides.push({
                    file: currentFile,
                    line: startLine,
                    endLine: endLine > startLine ? endLine : undefined
                });
            }
        }
    }

    return slides;
}

/**
 * Generate a presentation JSON object from a git diff range.
 *
 * @param {string} base — starting ref (default: HEAD~1)
 * @param {string} head — ending ref (default: HEAD)
 * @returns {object} presentation JSON { title, slides }
 */
function generateSlides(base = 'HEAD~1', head = 'HEAD') {
    const r = git.git('diff', [base, head, '--unified=0']);
    if (!r.ok) {
        return exit(`present: git diff failed (exit ${r.status})`);
    }
    const slides = parseDiff(r.stdout);
    if (slides.length === 0) {
        return exit(`present: no changes found in ${base}..${head}`);
    }
    return {
        title: `Changes: ${base}..${head}`,
        slides
    };
}

// ─── JSON I/O ──────────────────────────────────────────────────

/**
 * Read a presentation JSON from a file path or '-' (stdin).
 */
function readPresentation(source) {
    let raw;
    if (source === '-') {
        raw = fs.readFileSync(0, 'utf-8');
    } else {
        raw = fs.readFileSync(source, 'utf-8');
    }
    return JSON.parse(raw);
}

// ─── Script-level helpers ──────────────────────────────────────

async function promptInstruction() {
    if (!cli.isInteractive()) {
        console.error('Non-interactive; pass --instruction <text> to provide an instruction.');
        return cli.nonInteractive('cannot prompt for instruction.');
    }
    const iface = Interface.createInterface('present');
    const instruction = await iface.input('What should opencode explain?', { initial: '' });
    return instruction.trim() || null;
}

function buildOpencodePrompt(instruction, opts) {
    const base = opts.base || 'HEAD~1';
    const head = opts.head || 'HEAD';
    return [
        'You are a presentation builder for a code-review walkthrough.',
        `The user wants explained: "${instruction}"`,
        '',
        `Examine the git diff range ${base}..${head} and the current codebase state.`,
        'Produce a JSON presentation object that walks the user through the aspects',
        'of their request, navigating their editor to the relevant file:line positions.',
        '',
        'Output ONLY a raw JSON object with this exact shape (no markdown fences, no prose):',
        '{',
        '  "title": "<short title>",',
        '  "slides": [',
        '    { "file": "<relative path>", "line": <number>, "endLine": <number|null>, "summary": "<1-2 sentence explanation>" }',
        '  ]',
        '}',
        '',
        'Rules:',
        '- file paths must be relative to the project root',
        '- line/endLine must be valid line numbers in the current file state',
        '- order slides logically to tell the story of the request',
        '- 3-12 slides is ideal; fewer for simple requests',
        '- each summary must explain the particularity of that aspect relative to the request',
        '- if endLine equals line or is unknown, set it to null'
    ].join('\n');
}

async function buildPresentation(instruction, model, opts) {
    const prompt = buildOpencodePrompt(instruction, opts);
    console.log(`present: building presentation via opencode (${model})…`);
    const { status, stdout } = ide.spawnHeadless(prompt, model, { cwd: rarebert.root });
    if (status !== 0) {
        console.error(`present: opencode exited with status ${status}`);
        return null;
    }
    const json = extractJson(stdout);
    if (!json) {
        console.error('present: could not parse presentation JSON from opencode output');
        if (stdout) console.error(stdout.slice(0, 500));
        return null;
    }
    if (!Array.isArray(json.slides) || json.slides.length === 0) {
        console.error('present: opencode returned no slides');
        return null;
    }
    return json;
}

function extractJson(text) {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    try {
        return JSON.parse(candidate.trim());
    } catch {
        /* fall through to brace extraction */
    }
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

function walkSlides(presentation) {
    const total = presentation.slides.length;
    console.log(`\n${DIAMOND} ${presentation.title || 'Presentation'}  (${total} slides)\n`);

    for (let i = 0; i < total; i++) {
        const slide = presentation.slides[i];
        const span =
            slide.endLine && slide.endLine !== slide.line
                ? `${slide.line}-${slide.endLine}`
                : `${slide.line}`;
        console.log(`\n── slide ${i + 1}/${total} ─ ${slide.file}:${span} ──`);
        if (slide.summary) console.log(slide.summary);
        presentSlide(slide);
    }

    console.log(`\n${GREEN_TICK} presentation complete (${total} slides)`);
}

const meta = {
    name: 'present',
    description:
        "Prompt for an instruction, run opencode headlessly to build a presentation JSON of file:line slides explaining the request, then walk the user's editor through each slide in indexed mode — printing the per-slide explanation, navigating to file:line, and advancing on tab-close",
    usage: 'node index.js present [--model <id>] [--instruction <text>] [--base <ref>] [--head <ref>] [--file <path>]',
    options: [
        {
            flag: '-m, --model <id>',
            description: 'opencode model id (overrides the default from opencode.json)'
        },
        {
            flag: '--instruction <text>',
            description: 'non-interactive instruction (skip the prompt)'
        },
        {
            flag: '--base <ref>',
            description: 'git base ref for diff context passed to opencode (default: HEAD~1)'
        },
        {
            flag: '--head <ref>',
            description: 'git head ref for diff context passed to opencode (default: HEAD)'
        },
        {
            flag: '--file <path>',
            description: 'load a presentation JSON from a file instead of calling opencode'
        }
    ]
};

export { meta, runPresent };

async function runPresent(opts, positional) {
    const model = opts.model ? await models.resolve(opts.model) : models.resolveDefault();

    let presentation;
    if (opts.file) {
        presentation = readPresentation(opts.file);
    } else {
        const instruction = opts.instruction
            ? String(opts.instruction).trim()
            : await promptInstruction();
        if (!instruction) {
            return exit('present: no instruction provided');
        }
        presentation = await buildPresentation(instruction, model, opts);
    }

    if (!presentation) return exit(1);

    return exit(() => walkSlides(presentation));
}

export default new CLI(
    'present.mjs',
    async (opts, positional) => {
        if (opts.instruction || opts.file) {
            return exit(await runPresent(opts, positional));
        }

        if (!cli.isInteractive()) {
            return exit(
                'present: --instruction or --file required for non-interactive mode, or run from a TTY.'
            );
        }

        return exit(
            new TUI(
                'present.mjs',
                async (opts, positional) => {
                    return runPresent(opts, positional);
                },
                meta
            )
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
