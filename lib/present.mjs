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
 * Editor resolution respects $VSCODE_BIN, $VISUAL, $EDITOR, falling
 * back to 'code'. VS Code uses `-g file:line:col` goto syntax; other
 * editors use `+<line> file`.
 */

import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { git } from './git.mjs';
import { rarebert } from './projects.mjs';

// ─── Editor resolution ─────────────────────────────────────────

/**
 * Resolve the user's editor of choice. Checks in order:
 *   1. $VSCODE_BIN (explicit override for remote/devcontainer)
 *   2. $VISUAL (POSIX convention, may include args)
 *   3. $EDITOR (POSIX convention, may include args)
 *   4. 'code' (VS Code CLI — the project default)
 *
 * Returns { bin, baseArgs, kind } where kind is 'code' or 'generic'.
 * $EDITOR or $VISUAL may be set to 'code' with flags like '--wait';
 * we detect this so the `-g` goto syntax is used instead of `+line`.
 */
function resolveEditor() {
    const candidates = [process.env.VSCODE_BIN, process.env.VISUAL, process.env.EDITOR];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const parts = candidate.split(/\s+/);
        const bin = parts[0];
        const baseArgs = parts.slice(1);
        const isCode = path.basename(bin) === 'code';
        return { bin, baseArgs, kind: isCode ? 'code' : 'generic' };
    }
    return { bin: 'code', baseArgs: [], kind: 'code' };
}

// ─── Slide presentation ────────────────────────────────────────

/**
 * Open a file at a specific line in the editor. When `wait` is true,
 * blocks until the user closes the tab (`--wait` for VS Code). When
 * false, launches and returns immediately (fire-and-forget).
 */
function openAtLine(filePath, line, column, wait) {
    const editor = resolveEditor();
    let bin, args;

    if (editor.kind === 'code') {
        const gotoArg = `${filePath}:${line}:${column || 1}`;
        const flags = editor.baseArgs.filter((f) => wait || f !== '--wait');
        if (wait && !flags.includes('--wait')) flags.push('--wait');
        if (!flags.includes('-r')) flags.push('-r');
        args = [...flags, '-g', gotoArg];
        bin = editor.bin;
    } else {
        args = [...editor.baseArgs, `+${line}`, filePath];
        bin = editor.bin;
    }

    const result = spawnSync(bin, args, {
        cwd: rarebert.root,
        stdio: 'inherit'
    });

    if (result.error) {
        console.error(`present: failed to launch editor: ${result.error.message}`);
        console.error(`  Tried: ${bin} ${args.join(' ')}`);
        process.exit(1);
    }
}

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
    const editor = resolveEditor();
    const filePath = path.isAbsolute(slide.file)
        ? slide.file
        : path.join(rarebert.root, slide.file);

    const hasEnd = slide.endLine && slide.endLine !== slide.line;
    const supportsBlockView = editor.kind === 'code';

    if (hasEnd && supportsBlockView) {
        openAtLine(filePath, slide.line, slide.column, false);
        openAtLine(filePath, slide.endLine, slide.column, true);
    } else {
        openAtLine(filePath, slide.line, slide.column, true);
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
        console.error(`present: index ${index} out of range (0–${total - 1})`);
        process.exit(1);
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
        console.error(`present: git diff failed (exit ${r.status})`);
        process.exit(1);
    }
    const slides = parseDiff(r.stdout);
    if (slides.length === 0) {
        console.error(`present: no changes found in ${base}..${head}`);
        process.exit(1);
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

export {
    resolveEditor,
    openAtLine,
    presentSlide,
    present,
    presentOne,
    parseDiff,
    generateSlides,
    readPresentation
};