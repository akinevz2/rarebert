import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { spawn } from 'child_process';
import { PROJECT_ROOT, normalizeModuleName, getScriptMetadata } from './core.mjs';
import { listAllModules, DIRECTORY_TARGETS, findDirectoryTarget } from './modules.mjs';
import { relPath } from './libs.mjs';
import { isTrackedModified, stagedDiffForPath } from './git.mjs';
import { isInteractive, nonInteractive, abort, AbortError } from './cli.mjs';

export const LAST_MODULE_FILE = path.join(PROJECT_ROOT, '.last-module');

export function readLastModule() {
    if (!fs.existsSync(LAST_MODULE_FILE)) return null;
    return fs.readFileSync(LAST_MODULE_FILE, 'utf-8').trim() || null;
}

export function writeLastModule(relPath) {
    fs.writeFileSync(LAST_MODULE_FILE, relPath);
}

export function clearLastModule() {
    if (fs.existsSync(LAST_MODULE_FILE)) fs.unlinkSync(LAST_MODULE_FILE);
}

export function editFile(filePath) {
    const envEditor = process.env.EDITOR || 'nano';
    const [editor, ...maybeArgs] = envEditor.split(/\s+/).filter(Boolean);
    const editorFlags = process.env.EDITOR_FLAGS
        ? process.env.EDITOR_FLAGS.split(/\s+/).filter(Boolean)
        : [];
    const child = spawn(editor, [...maybeArgs, ...editorFlags, filePath], { stdio: 'inherit' });
    return child;
}

export function loadContent(file) {
    const abs = path.isAbsolute(file) ? file : path.join(PROJECT_ROOT, file);
    if (!fs.existsSync(abs)) return null;
    const rel = path.relative(PROJECT_ROOT, abs) || file;
    const body = fs.readFileSync(abs, 'utf-8');
    return `--- ${rel} ---\n${body}`;
}

export function loadStageContent(file) {
    const rel = path.isAbsolute(file) ? path.relative(PROJECT_ROOT, file) : file;
    const header = `--- ${rel} (tracked + modified; staged patch) ---`;
    const patch = stagedDiffForPath(rel) || '';
    const body = fs.existsSync(path.join(PROJECT_ROOT, rel))
        ? fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf-8')
        : '';
    return [header, patch, `--- ${rel} (working tree) ---`, body]
        .filter((s) => s && s.trim())
        .join('\n');
}

export function resolveTargetArg(arg) {
    const abs = path.isAbsolute(arg) ? arg : path.join(PROJECT_ROOT, arg);
    if (fs.existsSync(abs)) {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            const rel = path.relative(PROJECT_ROOT, abs);
            return { cwd: abs, rel: rel || abs, isFile: false };
        }
        if (stat.isFile()) {
            const rel = path.relative(PROJECT_ROOT, abs);
            return { cwd: null, rel: rel || arg, isFile: true, abs };
        }
    }
    const modules = listAllModules();
    const match = modules.find((s) => normalizeModuleName(s.name) === normalizeModuleName(arg));
    if (match) {
        const rel = relPath(match.path);
        return { cwd: null, rel, isFile: true, abs: match.path };
    }
    return null;
}

function moduleChoices(modules) {
    return modules.map((s) => {
        const meta = getScriptMetadata(s.path);
        const rel = path.relative(PROJECT_ROOT, s.path);
        const label = `${rel}${meta.description ? ' - ' + meta.description : ''}`;
        return { name: s.path, message: label };
    });
}

async function promptSingleModule(message) {
    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('editor: no modules found in lib/ or scripts/.');
        return null;
    }
    const choices = moduleChoices(modules);
    const prompt = new Enquirer.AutoComplete({
        name: 'module',
        message,
        limit: 12,
        choices,
        result: (v) => v,
        suggest(input) {
            const q = (input || '').toLowerCase().trim();
            return q ? choices.filter((c) => c.message.toLowerCase().includes(q)) : choices;
        }
    });
    try {
        const answer = await prompt.run();
        return modules.find((s) => s.path === answer) || null;
    } catch {
        return null;
    }
}

function listFilesInDir(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(dir, e.name));
}

async function promptWorkspaceMultiSelect(dir) {
    const files = listFilesInDir(dir);
    if (files.length === 0) {
        console.error(`editor: no files in ${path.relative(PROJECT_ROOT, dir) || '.'}`);
        return [];
    }
    const choices = files.map((f) => {
        const rel = path.relative(PROJECT_ROOT, f);
        return { name: f, message: rel };
    });
    const prompt = new Enquirer.MultiSelect({
        name: 'files',
        message: 'Select files (esc returns to workspace-select):',
        choices,
        result(names) {
            return Array.isArray(names) ? names : [names];
        }
    });
    try {
        const answer = await prompt.run();
        return Array.isArray(answer) ? answer : [answer];
    } catch {
        return null;
    }
}

async function promptWorkspaceChoice() {
    const choices = DIRECTORY_TARGETS.map((d) => ({
        name: d.key,
        message: d.label
    }));
    choices.push({ name: '__confirm__', message: 'Confirm selection' });
    choices.push({ name: '__abort__', message: 'Abort' });
    const prompt = new Enquirer.Select({
        name: 'workspace',
        message: 'Pick a workspace (folder) to select files from:',
        choices
    });
    try {
        return await prompt.run();
    } catch {
        return '__abort__';
    }
}

async function interactiveSelectActiveFiles({ message }) {
    let confirmed = false;
    let selected = [];
    while (!confirmed) {
        const single = await promptSingleModule(`${message} (esc allows selecting multiple files)`);
        if (single) {
            selected = [{ rel: relPath(single.path), abs: single.path, isFile: true }];
            confirmed = true;
            break;
        }
        while (true) {
            const action = await promptWorkspaceChoice();
            if (action === '__abort__') {
                throw new AbortError();
            }
            if (action === '__confirm__') {
                confirmed = true;
                break;
            }
            const target = findDirectoryTarget(action);
            if (!target) break;
            const picked = await promptWorkspaceMultiSelect(target.dir);
            if (picked === null) continue;
            for (const p of picked) {
                const rel = path.relative(PROJECT_ROOT, p);
                if (!selected.some((s) => s.rel === rel)) {
                    selected.push({ rel, abs: p, isFile: true });
                }
            }
            console.log(
                `editor: ${selected.length} file(s) labelled so far. (Confirm at workspace-select to finish.)`
            );
        }
    }
    return selected;
}

export async function resolveActiveFiles(args = [], options = {}) {
    const { message = 'Select a module to implement' } = options;
    let entries = [];

    if (args.length > 0) {
        for (const arg of args) {
            const t = resolveTargetArg(arg);
            if (!t) {
                console.error(`editor: target not found: ${arg}`);
                continue;
            }
            if (t.isFile) {
                entries.push({ rel: t.rel, abs: t.abs, isFile: true });
            } else {
                for (const f of listFilesInDir(t.cwd)) {
                    const rel = path.relative(PROJECT_ROOT, f);
                    entries.push({ rel, abs: f, isFile: true });
                }
            }
        }
    } else if (isInteractive()) {
        entries = (await interactiveSelectActiveFiles({ message })) || [];
    } else {
        nonInteractive('pass file or directory arguments, or run interactively.');
    }

    if (entries.length === 0) {
        console.error('editor: no files selected.');
        return { entries: [], context: '' };
    }

    const parts = [];
    for (const e of entries) {
        if (isTrackedModified(e.rel)) {
            parts.push(loadStageContent(e.rel));
        } else {
            const c = loadContent(e.abs);
            if (c) parts.push(c);
        }
    }
    return { entries, context: parts.filter(Boolean).join('\n\n') };
}

export default {
    LAST_MODULE_FILE,
    readLastModule,
    writeLastModule,
    clearLastModule,
    editFile,
    loadContent,
    loadStageContent,
    resolveTargetArg,
    resolveActiveFiles
}; // test marker
