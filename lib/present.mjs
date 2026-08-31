/**
 * lib/present.mjs — Presentation engine for change review.
 *
 * Generates slides from git diffs and opens them in the user's editor,
 * blocking on each until the user closes the tab. When a slide has
 * both a start and end line, the start is launched fire-and-forget
 * and the end is opened with --wait — so both positions are in the
 * editor's jump list and closing the end-line tab advances.
 *
 * Reusable parts:
 *   - generateSlides(base, head) → presentation JSON from a git range
 *   - presentSlide(slide) → open one slide in $EDITOR, block until closed
 *   - present(presentation) → play all slides back-to-back
 *   - presentOne(presentation, index) → open a single slide by index
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

import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { git } from './git.mjs';
import { rarebert } from './projects.mjs';
import { cli } from './module.mjs';
import { tui } from './tui.mjs';
import { exit } from './core.mjs';
import { ide } from './ide.mjs';
import { DIAMOND, GREEN_TICK } from './symbols.mjs';

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

// ─── Script-level helpers (hoisted from scripts/present.mjs) ───

async function promptInstruction() {
    if (!cli.isInteractive()) {
        console.error('Non-interactive; pass --instruction <text> to provide an instruction.');
        return cli.nonInteractive('cannot prompt for instruction.');
    }
    const instruction = await tui.input('What should opencode explain?', { initial: '' });
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

export {
    presentSlide,
    present,
    presentOne,
    parseDiff,
    generateSlides,
    readPresentation,
    promptInstruction,
    buildOpencodePrompt,
    buildPresentation,
    extractJson,
    walkSlides
};
