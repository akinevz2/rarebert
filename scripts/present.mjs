#!/usr/bin/env node
/**
 * scripts/present.mjs — Interactive presentation builder + editor walker.
 *
 * Prompts the user for an instruction (the "particularity of the request"),
 * launches opencode headlessly to build a presentation JSON object whose
 * slides are keyed to file:line ranges, then walks the user's editor
 * through each slide in indexed mode: print the per-slide explanation,
 * navigate to file:line (blocking on tab-close), advance to the next
 * index, and continue until all slides are exhausted.
 *
 * Reuses lib/present.mjs for the editor-navigation primitives
 * (presentSlide blocks via --wait until the tab closes).
 */

import { models } from '../lib/models.mjs';
import { cli, AbortError } from '../lib/cli.mjs';
import { ide } from '../lib/ide.mjs';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import * as present from '../lib/present.mjs';
import { Module } from '../lib/modules.mjs';

const meta = {
    name: 'present',
    description:
        "Prompt for an instruction, run opencode headlessly to build a presentation JSON of file:line slides explaining the request, then walk the user's editor through each slide in indexed mode — printing the per-slide explanation, navigating to file:line, and advancing on tab-close",
    usage: 'node index.js present [model] [--instruction <text>] [--base <ref>] [--head <ref>] [--file <path>]',
    options: [
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

/**
 * Prompt the user for the instruction describing what opencode should
 * explain. Returns the trimmed string, or null if the user entered
 * nothing. Throws AbortError on ctrl-c.
 */
async function promptInstruction() {
    if (!cli.isInteractive()) {
        console.error('Non-interactive; pass --instruction <text> to provide an instruction.');
        cli.nonInteractive('cannot prompt for instruction.');
    }
    const instruction = await cli.input('What should opencode explain?', { initial: '' });
    return instruction.trim() || null;
}

/**
 * Build the opencode prompt that asks for a presentation JSON object.
 * The instruction is the user's free-text request; the base/head refs
 * scope the diff context opencode should examine.
 */
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
        '    { "file": "<relative path>", "line": <number>, "endLine": <number|null>, "summary": "<1-2 sentence explanation of what this slide shows and why it matters for the request>" }',
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

/**
 * Run opencode headlessly to generate the presentation JSON. Returns
 * the parsed object, or null on failure. The opencode stdout is expected
 * to be a raw JSON object (markdown fences are stripped if present).
 */
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

/**
 * Extract a JSON object from text that may be raw JSON, wrapped in
 * markdown fences, or surrounded by stray prose. Returns null on
 * parse failure.
 */
function extractJson(text) {
    if (!text) return null;
    // Strip markdown code fences if present.
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

/**
 * Walk the user's editor through each slide in indexed mode. For each
 * slide: print the per-slide explanation (summary), then call
 * present.presentSlide() which opens the editor at file:line with --wait
 * and blocks until the user closes the tab. On tab-close, advance to
 * the next index and continue.
 */
function walkSlides(presentation) {
    const total = presentation.slides.length;
    console.log(`\n◆ ${presentation.title || 'Presentation'}  (${total} slides)\n`);

    for (let i = 0; i < total; i++) {
        const slide = presentation.slides[i];
        const span =
            slide.endLine && slide.endLine !== slide.line
                ? `${slide.line}-${slide.endLine}`
                : `${slide.line}`;
        console.log(`\n── slide ${i + 1}/${total} ─ ${slide.file}:${span} ──`);
        if (slide.summary) console.log(slide.summary);
        // presentSlide blocks until the editor tab closes (--wait).
        present.presentSlide(slide);
    }

    console.log(`\n✓ presentation complete (${total} slides)`);
}

async function main(opts, positional) {
    const model = await models.resolve(positional[0]);

    let presentation;
    if (opts.file) {
        presentation = present.readPresentation(opts.file);
    } else {
        const instruction = opts.instruction
            ? String(opts.instruction).trim()
            : await promptInstruction();
        if (!instruction) {
            console.error('present: no instruction provided');
            return exit(1);
        }
        presentation = await buildPresentation(instruction, model, opts);
    }

    if (!presentation) return exit(1);

    walkSlides(presentation);
    return exit(0);
}

const module = new Module('present.mjs', main, meta);
export default module;
module.supportsDirectRunning(import.meta.url);
