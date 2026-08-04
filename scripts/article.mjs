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

const { Select, Input, Confirm } = Enquirer;

const REPORT_REMOTE = 'https://github.com/akinevz2/report-template.git';
const REPORT_DIR = path.join(PROJECT_ROOT, 'report');
const SRC_DIR = path.join(REPORT_DIR, 'src');
const TOC_FILENAME = 'TOC.md';
const TOC_PATH = path.join(SRC_DIR, TOC_FILENAME);
const PREAMBLE_FILENAMES = ['REPORT.md', 'TEMPLATE.md'];
const PREAMBLE_PATH = path.join(REPORT_DIR, PREAMBLE_FILENAMES.find(f => fs.existsSync(path.join(REPORT_DIR, f))) || PREAMBLE_FILENAMES[1]);

function normalizeSectionRel(name) {
    let rel = String(name).trim()
        .replace(/^\.?\/?/, '')
        .replace(/^(report\/)?src\//, '')
        .replace(/^report\//, '');
    rel = rel.split('/').filter(p => p && p !== '.' && p !== '..').join('/');
    if (!rel) throw new Error('Invalid section path');
    return rel.endsWith('.md') ? rel : `${rel}.md`;
}

function tocLinkFor(rel) {
    const label = path.basename(rel, '.md').replace(/[-_]/g, ' ');
    return `[${label}](./${rel})`;
}

function tocLinkRegex(rel) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^.*\\]\\([^)]*${escaped}\\)\\s*$\\n?`, 'gm');
}

function appendToTOC(rel) {
    const line = `${tocLinkFor(rel)}\n`;
    if (!fs.existsSync(TOC_PATH)) {
        fs.mkdirSync(path.dirname(TOC_PATH), { recursive: true });
        fs.writeFileSync(TOC_PATH, line);
        return;
    }
    const current = fs.readFileSync(TOC_PATH, 'utf-8');
    if (tocLinkRegex(rel).test(current)) return;
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(TOC_PATH, current + sep + line);
}

function removeFromTOC(rel) {
    if (!fs.existsSync(TOC_PATH)) return;
    const current = fs.readFileSync(TOC_PATH, 'utf-8');
    const next = current.replace(tocLinkRegex(rel), '');
    if (next !== current) fs.writeFileSync(TOC_PATH, next);
}

function rebuildAndOpen() {
    console.error('\n--- rebuilding report and opening updated view ---');
    if (!runMake('open')) {
        console.error('(build/open failed; continuing)');
    }
}

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

function hostGit(args, options = {}) {
    const result = spawnSync('git', args, {
        cwd: PROJECT_ROOT,
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

function isHostClean() {
    const r = hostGit(['status', '--porcelain']);
    return r.ok && r.stdout.trim() === '';
}

async function runHostCommit() {
    console.error('\n--- rarebert repo has uncommitted changes; running `make commit` ---');
    const result = spawnSync('make', ['commit'], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit'
    });
    if (result.error) {
        console.error(`make commit failed: ${result.error.message}`);
        return false;
    }
    if (result.status !== 0) {
        console.error(`make commit exited with status ${result.status}`);
        return false;
    }
    return true;
}

async function assertHostCleanOrCommit() {
    if (isHostClean()) return;
    while (!isHostClean()) {
        const r = hostGit(['status', '--short']);
        console.error('\nrarebert working tree is not clean:');
        process.stderr.write(r.stdout);
        if (process.stdin.isTTY !== true) {
            console.error('Non-interactive; aborting. Run `make commit` first.');
            process.exit(1);
        }
        const ok = await new Confirm({
            name: 'commit',
            message: 'Run `make commit` now?'
        }).run().catch(() => false);
        if (!ok) {
            console.error('Aborted. Commit or clean the rarebert repo before continuing.');
            process.exit(1);
        }
        const success = await runHostCommit();
        if (!success) process.exit(1);
    }
    console.error('rarebert working tree is clean.');
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
        stdio: 'inherit',
        env: { ...process.env, PWD: REPORT_DIR }
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
    const sections = walkMarkdown(SRC_DIR).filter(s => s.rel !== `src/${TOC_FILENAME}`);
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

function currentBranch() {
    const r = reportGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.ok ? r.stdout.trim() : '';
}

function branchExists(name) {
    const r = reportGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return r.ok && r.status === 0;
}

async function promptBranch() {
    const cur = currentBranch();
    if (cur && cur !== 'template' && cur !== 'HEAD') {
        console.error(`on branch: ${cur}`);
        return;
    }
    const fallback = `article/${new Date().toISOString().slice(0, 10)}`;
    let name;
    if (process.stdin.isTTY === true) {
        const input = new Input({
            name: 'branch',
            message: 'New branch name (off template):',
            default: fallback,
            validate: v => (v && v.trim() && /^\S+$/.test(v.trim()) ? true : 'Branch name is required (no spaces)')
        });
        try { name = (await input.run()).trim(); }
        catch { console.error('\nAborted.'); process.exit(130); }
    } else {
        name = fallback;
    }

    let res;
    if (branchExists(name)) {
        res = reportGit(['checkout', name]);
    } else {
        res = reportGit(['checkout', '-b', name, 'template']);
    }
    if (!res.ok) {
        console.error(`git checkout failed: ${res.stderr.trim() || res.stdout.trim()}`);
        process.exit(1);
    }
    console.error(`switched to branch: ${name}`);
}

function isReportClean() {
    const r = reportGit(['status', '--porcelain']);
    return r.ok && r.stdout.trim() === '';
}

function assertReportClean() {
    if (isReportClean()) return;
    const r = reportGit(['status', '--short']);
    console.error('Report working tree is not clean. Commit or resolve changes before editing:');
    process.stderr.write(r.stdout);
    process.exit(1);
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

    if (finalStatus === 0) rebuildAndOpen();
    return finalStatus;
}

async function editPreamble(model) {
    if (!fs.existsSync(PREAMBLE_PATH)) {
        console.error(`Preamble file not found: ${relPath(PREAMBLE_PATH)}`);
        return 1;
    }
    console.error(`Editing preamble: ${relPath(PREAMBLE_PATH)}`);
    const status = await editSection(model, PREAMBLE_PATH, path.relative(REPORT_DIR, PREAMBLE_PATH));
    if (status !== 0) console.error(`edit session exited with status ${status}.`);
    await confirmCommit('update preamble');
    return status;
}

function sectionExists(name) {
    try {
        const rel = normalizeSectionRel(name);
        if (rel === TOC_FILENAME) return TOC_PATH;
        const full = path.join(SRC_DIR, rel);
        return fs.existsSync(full) ? full : null;
    } catch { return null; }
}

async function manageSections() {
    const sections = listSections();
    console.error('\n=== Sections ===');
    if (sections.length === 0) {
        console.error('(none)');
    } else {
        sections.forEach(s => console.error(`  ${s.rel}`));
    }
    console.error(`  src/${TOC_FILENAME} (table of contents, auto-managed)`);

    const actionPrompt = new Select({
        name: 'action',
        message: 'Manage sections',
        choices: [
            { name: 'add', message: 'Add a new section' },
            { name: 'remove', message: 'Remove a section' },
            { name: 'back', message: 'Back to menu' }
        ]
    });
    let action;
    try { action = await actionPrompt.run(); }
    catch { return; }

    if (action === 'add') {
        const namePrompt = new Input({
            message: 'New section name (created under src/, e.g. methods/data.md):',
            validate: v => {
                if (!v || !v.trim()) return 'Section name is required';
                try { normalizeSectionRel(v); return true; }
                catch (e) { return e.message; }
            }
        });
        const name = (await namePrompt.run()).trim();
        let rel;
        try { rel = normalizeSectionRel(name); }
        catch (e) { console.error(`Error: ${e.message}`); return; }

        if (rel === TOC_FILENAME) {
            console.error(`'${TOC_FILENAME}' is reserved for the table of contents.`);
            return;
        }

        const full = path.join(SRC_DIR, rel);
        if (fs.existsSync(full)) {
            console.error(`Already exists: ${relPath(full)}`);
            return;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const title = path.basename(rel, '.md').replace(/[-_]/g, ' ');
        fs.writeFileSync(full, `# ${title}\n\n`);
        console.error(`Created: ${relPath(full)}`);

        console.error(`Linking ${rel} in src/${TOC_FILENAME}...`);
        appendToTOC(rel);
        rebuildAndOpen();
    } else if (action === 'remove') {
        if (sections.length === 0) { console.error('Nothing to remove.'); return; }
        const choices = sections.map(s => ({ name: s.path, message: s.rel }));
        const pick = new Select({ name: 'section', message: 'Remove which section?', choices });
        const picked = await pick.run();
        const section = sections.find(s => s.path === picked);
        const rel = section.rel;
        const ok = await new Confirm({ name: 'ok', message: `Delete ${rel}?` }).run();
        if (!ok) { console.error('Cancelled.'); return; }
        fs.unlinkSync(picked);
        console.error(`Removed: ${rel}`);
        removeFromTOC(section.rel.replace(/^src\//, ''));
        rebuildAndOpen();
    }
}

async function makeTodoNote() {
    const sections = listSections();
    const targetPrompt = new Select({
        name: 'target',
        message: 'Append TODO to which section?',
        choices: [
            ...sections.map(s => ({ name: s.path, message: s.rel })),
            { name: 'NOTES.md', message: 'report/NOTES.md (scratch pad)' }
        ]
    });
    let target;
    try { target = await targetPrompt.run(); } catch { return; }

    const isNotes = target === 'NOTES.md';
    const full = isNotes ? path.join(REPORT_DIR, 'NOTES.md') : target;
    if (!isNotes && path.basename(full) === TOC_FILENAME) {
        console.error(`'${TOC_FILENAME}' is auto-managed; pick a different section.`);
        return;
    }
    const notePrompt = new Input({
        message: 'TODO note (single line):',
        validate: v => (v && v.trim() ? true : 'Note is required')
    });
    const note = (await notePrompt.run()).trim();
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const line = `- [ ] TODO (${stamp}): ${note}\n`;
    if (!fs.existsSync(full)) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, isNotes ? `# Notes\n\n${line}` : `${line}`);
    } else {
        fs.appendFileSync(full, line);
    }
    console.error(`Appended TODO to ${relPath(full)}`);
    if (!isNotes) rebuildAndOpen();
}

async function runMenu(args) {
    const preview = args.includes('--preview') || args.includes('-p');
    const nonFlag = args.filter(a => !a.startsWith('-') && a);
    const sectionArg = nonFlag[0];
    const modelArg = nonFlag[1];

    ensureCloned();
    await assertHostCleanOrCommit();
    await promptBranch();
    assertReportClean();
    if (!runMake('report')) {
        console.error('continuing despite build failure (toolchain may be missing).');
    }
    if (preview) runMake('open');

    if (sectionArg) {
        assertCleanBeforeSwitch();
        const sections = listSections();
        if (sections.length === 0) {
            console.error(`No markdown sections found under ${relPath(SRC_DIR)}/.`);
            process.exit(1);
        }
        const section = await promptSection(sections, sectionArg);
        const model = await resolveModel([...(modelArg ? [modelArg] : [])]);
        const status = await editSection(model, section.path, section.rel);
        if (status !== 0) console.error(`edit session exited with status ${status}.`);
        await confirmCommit(`update ${section.rel}`);
        process.exit(status);
    }

    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; pass a section path as an argument.');
        process.exit(1);
    }

    while (true) {
        const menu = new Select({
            name: 'mode',
            message: 'Article mode',
            choices: [
                { name: 'manage', message: 'Manage sections' },
                { name: 'edit', message: 'Edit a section' },
                { name: 'preamble', message: 'Edit the preamble' },
                { name: 'todo', message: 'Make a TODO note' },
                { name: 'exit', message: 'Exit' }
            ]
        });
        let choice;
        try { choice = await menu.run(); }
        catch { console.error('\nAborted.'); process.exit(130); }

        if (choice === 'exit') { process.exit(0); }
        if (choice === 'manage') {
            const before = isReportClean();
            await manageSections();
            const after = isReportClean();
            if (before && !after) await confirmCommit('manage sections');
            continue;
        }
        if (choice === 'todo') { await makeTodoNote(); continue; }
        if (choice === 'preamble') {
            assertCleanBeforeSwitch();
            const model = await resolveModel([...(modelArg ? [modelArg] : [])]);
            await editPreamble(model);
            continue;
        }
        if (choice === 'edit') {
            assertCleanBeforeSwitch();
            const sections = listSections();
            if (sections.length === 0) {
                console.error(`No markdown sections found under ${relPath(SRC_DIR)}/.`);
                continue;
            }
            const section = await promptSection(sections, null);
            const model = await resolveModel([...(modelArg ? [modelArg] : [])]);
            const status = await editSection(model, section.path, section.rel);
            if (status !== 0) console.error(`edit session exited with status ${status}.`);
            await confirmCommit(`update ${section.rel}`);
        }
    }
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

async function launchShell() {
    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; skipping shell.');
        return;
    }
    const shell = process.env.SHELL || '/bin/bash';
    const result = spawnSync(shell, [], {
        cwd: REPORT_DIR,
        stdio: 'inherit',
        env: { ...process.env, PWD: REPORT_DIR }
    });
    if (result.error) console.error(`shell failed: ${result.error.message}`);
}

async function confirmCommit(label) {
    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; skipping manual commit confirmation.');
        return false;
    }
    const dirty = !isReportClean();
    if (!dirty) {
        console.error('No uncommitted changes.');
        return false;
    }
    const r = reportGit(['status', '--short']);
    process.stderr.write(r.stdout);
    const ok = await new Confirm({
        name: 'commit',
        message: `Commit ${label ? `${label} ` : ''}changes now?`
    }).run().catch(() => false);
    if (!ok) {
        console.error('Skipped commit; launching a shell in report/ (exit to resume).');
        await launchShell();
        return false;
    }
    const msgPrompt = new Input({
        name: 'message',
        message: 'Commit message:',
        default: label ? `article: ${label}` : 'article: update',
        validate: v => (v && v.trim() ? true : 'Message is required')
    });
    let message;
    try { message = (await msgPrompt.run()).trim(); }
    catch { console.error('Commit cancelled.'); return false; }

    const addResult = reportGit(['add', '-A']);
    if (!addResult.ok) {
        console.error(`git add failed: ${addResult.stderr.trim()}`);
        return false;
    }
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
        console.error('              if omitted, opens an interactive menu (manage/edit/preamble/todo/exit)');
        console.error('  model       opencode model id (otherwise prompted from opencode.json)');
        console.error('  Clones akinevz2/report-template.git into ./report/ if absent,');
        console.error('  builds with `make report`, lets you pick a section, edits it in');
        console.error('  $EDITOR alongside opencode, then commits the section on exit.');
        return;
    }

    await runMenu(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { ensureCloned, runMake, listSections, promptSection, isReportClean, isHostClean, assertReportClean, assertHostCleanOrCommit, editSection, editPreamble, commitSection, manageSections, makeTodoNote, runMenu, normalizeSectionRel, appendToTOC, removeFromTOC, rebuildAndOpen, main };

export default {
    name: 'article',
    description: 'Manage the academic report: clone, build, edit a section, commit',
    main
};