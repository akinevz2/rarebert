#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { PROJECT_ROOT } from '../lib/core.mjs';
import { editFile } from '../lib/editor.mjs';
import { exitIDE } from '../lib/ide.mjs';
import { readOpendeConfig, listModels, promptModel } from '../lib/models.mjs';
import { relPath } from '../lib/libs.mjs';

const REPORT_REMOTE = 'https://github.com/akinevz2/academic-report.git';
const REPORT_DIR = path.join(PROJECT_ROOT, 'report');
const SRC_DIR = path.join(REPORT_DIR, 'src');

function reportGit(args, options = {}) {
    const result = spawnSync('git', args, {
        cwd: REPORT_DIR,
        encoding: 'utf-8',
        stdio: options.stdio ?? 'pipe'
    });
    if (result.error) throw result.error;
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ok: result.status === 0
    };
}

function ensureCloned() {
    if (fs.existsSync(path.join(REPORT_DIR, '.git'))) return;
    if (fs.existsSync(REPORT_DIR)) {
        const entries = fs.readdirSync(REPORT_DIR);
        if (entries.length > 0) {
            console.error(`report/ exists but is not a git clone (contains ${entries.length} entries): ${REPORT_DIR}`);
            console.error('Remove it or clone manually before continuing.');
            process.exit(1);
        }
    }
    console.error(`cloning ${REPORT_REMOTE} -> ${relPath(REPORT_DIR)}/`);
    const result = spawnSync('git', ['clone', REPORT_REMOTE, REPORT_DIR], {
        stdio: 'inherit',
        encoding: 'utf-8'
    });
    if (result.error) {
        console.error(`git clone failed: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`git clone exited with status ${result.status}`);
        process.exit(result.status ?? 1);
    }
}

function runMake(target) {
    console.error(`$ make ${target} (cwd: ${relPath(REPORT_DIR)})`);
    const result = spawnSync('make', [target], {
        cwd: REPORT_DIR,
        stdio: 'inherit'
    });
    if (result.error) {
        console.error(`make ${target} failed: ${result.error.message}`);
        return false;
    }
    if (result.status !== 0) {
        console.error(`make ${target} exited with status ${result.status}`);
        return false;
    }
    return true;
}

function walkMarkdown(dir, acc = [], base = dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return acc; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkMarkdown(full, acc, base);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            acc.push({ path: full, rel: path.relative(REPORT_DIR, full) });
        }
    }
    return acc;
}

function listSections() {
    const sections = walkMarkdown(SRC_DIR);
    sections.sort((a, b) => a.rel.localeCompare(b.rel));
    return sections;
}

async function promptSection(sections, sectionArg) {
    if (sectionArg) {
        const norm = sectionArg.replace(/^\.?\/?/, '');
        const match = sections.find(s =>
            s.rel === norm ||
            s.rel === `src/${norm}` ||
            path.basename(s.rel) === norm ||
            s.rel.endsWith(norm)
        );
        if (!match) {
            console.error(`Report section not found: ${sectionArg}`);
            process.exit(1);
        }
        return match;
    }

    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; pass a report section path as an argument.');
        process.exit(1);
    }

    const choices = sections.map(s => ({ name: s.path, message: s.rel }));
    const prompt = new Enquirer.AutoComplete({
        name: 'section',
        message: 'Select a report section to work on',
        limit: 14,
        choices,
        suggest(input) {
            const q = (input || '').toLowerCase().trim();
            return q ? choices.filter(c => c.message.toLowerCase().includes(q)) : choices;
        }
    });

    try {
        const answer = await prompt.run();
        return sections.find(s => s.path === answer);
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

function isReportClean() {
    const r = reportGit(['status', '--porcelain']);
    return r.ok && r.stdout.trim() === '';
}

function assertCleanBeforeSwitch() {
    if (isReportClean()) return;
    const r = reportGit(['status', '--short']);
    console.error('Report working tree is not clean. Commit or resolve changes before switching to a new section:');
    process.stderr.write(r.stdout);
    process.exit(1);
}

async function resolveModel(args) {
    const modelArg = args.find(a => !a.startsWith('-') && a);
    if (modelArg) return modelArg;
    const config = readOpendeConfig();
    return await promptModel(listModels(config), config.model);
}

function runOpencode(model) {
    const args = [REPORT_DIR, '-m', model];
    console.error(`$ opencode ${args.join(' ')}`);
    const child = spawn('opencode', args, {
        stdio: 'inherit',
        cwd: REPORT_DIR
    });
    if (child.error) {
        console.error(`Failed to launch opencode: ${child.error.message}`);
        process.exit(1);
    }
    return child;
}

async function editSection(model, sectionPath, sectionRel) {
    const ideChild = runOpencode(model);
    console.error(`Opening $EDITOR ${relPath(sectionPath)}`);
    const editorChild = editFile(sectionPath);

    let finalStatus = 0;

    const editorExit = new Promise((resolve) => {
        editorChild.on('exit', (code) => resolve(code ?? 0));
    });
    const ideExit = new Promise((resolve) => {
        ideChild.on('exit', (code) => resolve(code ?? 0));
    });

    const first = await Promise.race([
        editorExit.then(code => ({ kind: 'editor', code })),
        ideExit.then(code => ({ kind: 'ide', code }))
    ]);

    if (first.kind === 'editor') {
        if (first.code !== 0) finalStatus = first.code;
        await exitIDE(ideChild);
        const ideCode = await ideExit;
        if (ideCode !== 0) finalStatus = ideCode;
    } else {
        finalStatus = first.code;
    }

    return finalStatus;
}

function commitSection(sectionPath, sectionRel) {
    const addResult = reportGit(['add', sectionPath]);
    if (!addResult.ok) {
        console.error(`git add failed: ${addResult.stderr.trim()}`);
        return false;
    }

    const staged = reportGit(['diff', ['--cached', '--name-only'].flat()]);
    if (!staged.stdout.trim()) {
        console.error('No changes to commit.');
        return true;
    }

    const message = `article: update ${sectionRel}`;
    const commitResult = reportGit(['commit', '-m', message], { stdio: 'inherit' });
    if (!commitResult.ok) {
        console.error(`git commit exited with status ${commitResult.status}`);
        return false;
    }
    console.error(`committed: ${message}`);
    return true;
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('article: Manage the academic report (clone, build, edit a section, commit)');
        console.error('  Usage: node index.js article [--preview] [section] [model]');
        console.error('  --preview   build the report then open it (make report && make open)');
        console.error('  section     path under report/src/ (e.g. introduction/introduction.md)');
        console.error('  model       opencode model id (otherwise prompted from opencode.json)');
        console.error('  Clones akinevz2/academic-report.git into ./report/ if absent,');
        console.error('  builds with `make report`, lets you pick a section, edits it in');
        console.error('  $EDITOR alongside opencode, then commits the section on exit.');
        return;
    }

    const preview = args.includes('--preview') || args.includes('-p');
    const nonFlag = args.filter(a => !a.startsWith('-') && a);
    const sectionArg = nonFlag[0];
    const modelArg = nonFlag[1];

    ensureCloned();

    if (!runMake('report')) {
        console.error('continuing despite build failure (toolchain may be missing).');
    }
    if (preview) {
        runMake('open');
    }

    assertCleanBeforeSwitch();

    const sections = listSections();
    if (sections.length === 0) {
        console.error(`No markdown sections found under ${relPath(SRC_DIR)}/.`);
        process.exit(1);
    }

    const section = await promptSection(sections, sectionArg);
    const model = await resolveModel([...(modelArg ? [modelArg] : [])]);

    const status = await editSection(model, section.path, section.rel);

    if (status !== 0) {
        console.error(`edit session exited with status ${status}.`);
    }

    commitSection(section.path, section.rel);

    process.exit(status);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { ensureCloned, runMake, listSections, promptSection, isReportClean, editSection, commitSection, main };

export default {
    name: 'article',
    description: 'Manage the academic report: clone, build, edit a section, commit',
    main
};