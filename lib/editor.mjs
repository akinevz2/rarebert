import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';

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

export default { LAST_MODULE_FILE, readLastModule, writeLastModule, clearLastModule, editFile }; // test marker
