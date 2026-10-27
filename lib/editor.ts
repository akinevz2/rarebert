import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { rarebert, home } from './runtime/Project.ts';
import { listAllModules, findDirectoryTarget } from './runtime/discovery.ts';
import { libs } from './runtime/libs.ts';
import { git } from './git.ts';
// Terminal/abort helpers — free functions from the runtime Module module
// (the legacy `cli` singleton was deleted).
import { isInteractive, nonInteractive, truncate } from './runtime/Module.ts';
import { exit, ExitSignal } from './runtime/core.ts';
import type { Module } from './runtime/Module.ts';

// REQUEST: resolveActiveFiles() can be called from multiple submodules that need
// cleanup on ctrl-c. On abort during interactive file selection:
// - Current selection state should be cleared
// - Any spawned editor processes should be terminated
// Meta suggestion: { retryOnFailure: false, cleanup: 'clearSelection' }


/** A file selected for editing. */
export interface SelectedFile {
    /** The project-relative path. */
    rel: string;
    /** The absolute path. */
    abs: string;
    /** Whether the entry is a file (rather than a directory). */
    isFile: boolean;
}

/** A resolved target argument (a file or a directory). */
export interface ResolvedTarget {
    /** The working directory (set for directories). */
    cwd: string | null;
    /** The project-relative path. */
    rel: string;
    /** Whether the target is a file. */
    isFile: boolean;
    /** The absolute path (set for files). */
    abs?: string;
}

/** The result of resolving the active files for an edit. */
export interface ActiveFiles {
    /** The selected files. */
    entries: SelectedFile[];
    /** The concatenated file contents used as context. */
    context: string;
}

/** The last-module marker file's contents. */
export interface LastModuleInfo {
    /** The project-relative path of the last edited module. */
    rel: string;
    /** The pid of the process that opened it, when known. */
    pid: number | null;
}

const normalizeModuleName = (rawName: string): string => rarebert.normalizeModuleName(rawName);

const LAST_MODULE_FILE = path.join(home.root, '.last-module');

class Editor {
    /** Path of the marker file recording the last edited module. */
    lastModuleFile: string;

    constructor() {
        this.lastModuleFile = LAST_MODULE_FILE;
    }

    readLastModuleInfo(): LastModuleInfo | null {
        if (!fs.existsSync(this.lastModuleFile)) return null;
        const raw = fs.readFileSync(this.lastModuleFile, 'utf-8').trim();
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.rel === 'string') {
                return { rel: parsed.rel, pid: parsed.pid ?? null };
            }
        } catch {
            /* legacy plain-text marker */
        }
        return { rel: raw, pid: null };
    }

    readLastModule(): string | null {
        const info = this.readLastModuleInfo();
        return info ? info.rel : null;
    }

    writeLastModule(rel: string, pid: number | null = null): void {
        fs.writeFileSync(this.lastModuleFile, JSON.stringify({ rel, pid }));
    }

    clearLastModule(): void {
        if (fs.existsSync(this.lastModuleFile)) fs.unlinkSync(this.lastModuleFile);
    }

    editFile(filePath: string | string[]): ChildProcess {
        const envEditor = process.env.EDITOR || 'nano';
        const [editor, ...maybeArgs] = envEditor.split(/\s+/).filter(Boolean);
        const editorFlags = process.env.EDITOR_FLAGS
            ? process.env.EDITOR_FLAGS.split(/\s+/).filter(Boolean)
            : [];
        const paths = Array.isArray(filePath) ? filePath : [filePath];
        return spawn(editor, [...maybeArgs, ...editorFlags, ...paths], { stdio: 'inherit' });
    }

    loadContent(file: string): string | null {
        const abs = path.isAbsolute(file) ? file : path.join(rarebert.root, file);
        if (!fs.existsSync(abs)) return null;
        const rel = path.relative(rarebert.root, abs) || file;
        const body = fs.readFileSync(abs, 'utf-8');
        return `--- ${rel} ---\n${body}`;
    }

    loadStageContent(file: string): string {
        const rel = path.isAbsolute(file) ? path.relative(rarebert.root, file) : file;
        const header = `--- ${rel} (tracked + modified; staged patch) ---`;
        const patch = git.stagedDiffForPath(rel) || '';
        const body = fs.existsSync(path.join(rarebert.root, rel))
            ? fs.readFileSync(path.join(rarebert.root, rel), 'utf-8')
            : '';
        return [header, patch, `--- ${rel} (working tree) ---`, body]
            .filter((s) => s && s.trim())
            .join('\n');
    }

    resolveTargetArg(arg: string): ResolvedTarget | null {
        const abs = path.isAbsolute(arg) ? arg : path.join(rarebert.root, arg);
        if (fs.existsSync(abs)) {
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) {
                const rel = path.relative(rarebert.root, abs);
                return { cwd: abs, rel: rel || abs, isFile: false };
            }
            if (stat.isFile()) {
                const rel = path.relative(rarebert.root, abs);
                return { cwd: null, rel: rel || arg, isFile: true, abs };
            }
        }
        const modules = listAllModules();
        let match;
        try {
            match = modules.find((s) => normalizeModuleName(s.name) === normalizeModuleName(arg));
        } catch {
            match = undefined;
        }
        if (match) {
            return { cwd: null, rel: libs.relPath(match.path), isFile: true, abs: match.path };
        }
        return null;
    }

    moduleChoices(modules: Module[]): Array<{ name: string; message: string }> {
        return modules.map((s) => {
            const meta = rarebert.getScriptMetadata(s.path);
            const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
            const rel = path.relative(rarebert.root, s.path);
            return { name: s.path, message: truncate(`${rel}${desc ? ' - ' + desc : ''}`) };
        });
    }

    async promptSingleModule(message: string): Promise<Module | null> {
        const modules = listAllModules();
        if (modules.length === 0) {
            console.error('editor: no modules found in lib/ or scripts/.');
            return null;
        }
        const choices = this.moduleChoices(modules);
        const prompt = new Enquirer.AutoComplete({
            name: 'module',
            message,
            limit: 12,
            choices,
            result: (v: string) => v,
            suggest(input: string) {
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

    listFilesInDir(dir: string): string[] {
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => path.join(dir, e.name));
    }

    async promptWorkspaceMultiSelect(dir: string): Promise<string[] | null> {
        const files = this.listFilesInDir(dir);
        if (files.length === 0) {
            console.error(`editor: no files in ${path.relative(rarebert.root, dir) || '.'}`);
            return [];
        }
        const choices = files.map((f) => {
            const rel = path.relative(rarebert.root, f);
            return { name: f, message: rel };
        });
        const prompt = new Enquirer.MultiSelect({
            name: 'files',
            message: 'Select files (esc returns to workspace-select):',
            choices,
            result(names: string | string[]) {
                return (Array.isArray(names) ? names : [names]) as unknown as string;
            }
        });
        try {
            const answer = await prompt.run();
            return Array.isArray(answer) ? answer : [answer];
        } catch {
            return null;
        }
    }

    async promptWorkspaceChoice(): Promise<string> {
        const choices = rarebert.discover().map((d) => ({
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

    async interactiveSelectActiveFiles({
        message
    }: {
        message?: string;
    } = {}): Promise<SelectedFile[] | ExitSignal> {
        let confirmed = false;
        let selected: SelectedFile[] = [];
        while (!confirmed) {
            const single = await this.promptSingleModule(
                `${message} (esc allows selecting multiple files)`
            );
            if (single) {
                selected = [
                    { rel: libs.relPath(single.path), abs: single.path ?? single.abs, isFile: true }
                ];
                confirmed = true;
                break;
            }
            while (true) {
                const action = await this.promptWorkspaceChoice();
                if (action === '__abort__') {
                    return exit('Aborted');
                }
                if (action === '__confirm__') {
                    confirmed = true;
                    break;
                }
                const target = findDirectoryTarget(action);
                if (!target) break;
                const picked = await this.promptWorkspaceMultiSelect(target.dir);
                if (picked === null) continue;
                for (const p of picked) {
                    const rel = path.relative(rarebert.root, p);
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

    async resolveActiveFiles(
        args: string[] = [],
        options: { message?: string } = {}
    ): Promise<ActiveFiles | ExitSignal> {
        const { message = 'Select a module to implement' } = options;
        let entries: SelectedFile[] = [];

        if (args.length > 0) {
            for (const arg of args) {
                const t = this.resolveTargetArg(arg);
                if (!t) {
                    console.error(`editor: target not found: ${arg}`);
                    continue;
                }
                if (t.isFile) {
                    entries.push({ rel: t.rel, abs: t.abs ?? t.rel, isFile: true });
                } else {
                    for (const f of this.listFilesInDir(t.cwd ?? rarebert.root)) {
                        const rel = path.relative(rarebert.root, f);
                        entries.push({ rel, abs: f, isFile: true });
                    }
                }
            }
        } else if (isInteractive()) {
            const picked = await this.interactiveSelectActiveFiles({ message });
            if (picked instanceof ExitSignal) return picked;
            entries = picked || [];
        } else {
            return nonInteractive('pass file or directory arguments, or run interactively.');
        }

        if (entries.length === 0) {
            console.error('editor: no files selected.');
            return { entries: [], context: '' };
        }

        const parts: string[] = [];
        for (const e of entries) {
            if (git.isTrackedModified(e.rel)) {
                parts.push(this.loadStageContent(e.rel));
            } else {
                const c = this.loadContent(e.abs);
                if (c) parts.push(c);
            }
        }
        return { entries, context: parts.filter(Boolean).join('\n\n') };
    }
}

const editor = new Editor();
export { Editor, editor, LAST_MODULE_FILE };
export default editor;
