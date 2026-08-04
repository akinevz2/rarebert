import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Enquirer from 'enquirer';
import { onAbort, runAbortCallbacks } from './cli.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
export const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
export const SRC_DIR = path.join(PROJECT_ROOT, 'src');
export const LIB_DIR = path.resolve(MODULE_DIR);

export const DIRECTORIES = ['scripts', 'lib', 'src'];

let exiting = false;

export function exit(code = 0) {
    if (exiting) return;
    exiting = true;
    runAbortCallbacks();
    process.exit(code);
}

export function readDirectoryFlag(args = []) {
    if (args.includes('--lib')) return 'lib';
    if (args.includes('--src')) return 'src';
    if (args.includes('--scripts') || args.includes('--script')) return 'scripts';
    return null;
}

export async function promptDirectory(defaultDirectory = 'src') {
    if (process.stdin.isTTY !== true) {
        console.log(`Non-interactive; defaulting directory to ${defaultDirectory}.`);
        return defaultDirectory;
    }

    const prompt = new Enquirer.Select({
        name: 'directory',
        initial: defaultDirectory,
        choices: [
            { name: 'src', message: 'src/      (Project modules run via make run)' },
            { name: 'lib', message: 'lib/      (shared library imported by other modules)' },
            { name: 'scripts', message: 'scripts/  (executable script invoked via make/<script>)' }
        ]
    });

    try {
        return await prompt.run();
    } catch {
        throw new AbortError();
    }
}

export async function resolveDirectory(args = [], defaultDirectory = 'scripts') {
    return readDirectoryFlag(args) ?? (await promptDirectory(defaultDirectory));
}

export function assertProjectRoot() {
    const cwd = process.cwd();
    if (cwd !== PROJECT_ROOT) {
        console.error(`Error: must be run from project root (${PROJECT_ROOT})`);
        console.error(`  Current directory: ${cwd}`);
        console.error(`  Run: cd ${PROJECT_ROOT} && make ...`);
        process.exit(1);
    }
}

export function normalizeModuleName(rawName, extensions = ['.js', '.mjs', '.py']) {
    const name = rawName.trim();
    for (const ext of extensions) {
        if (name.endsWith(ext)) return name.slice(0, -ext.length);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(
            'Invalid module name: must start with letter/underscore and contain only letters, numbers, underscores, or hyphens'
        );
    }
    return name;
}

export function discover(modulesDir = SCRIPTS_DIR, exts = ['.mjs', '.js']) {
    if (!fs.existsSync(modulesDir)) return [];
    return fs
        .readdirSync(modulesDir)
        .filter((f) => exts.some((ext) => f.endsWith(ext)))
        .map((f) => ({
            name: f.replace(
                new RegExp(`(${exts.map((e) => e.replace('.', '\\.')).join('|')})$`),
                ''
            ),
            path: path.join(modulesDir, f)
        }));
}

export function getScriptMetadata(scriptPath) {
    try {
        const content = fs.readFileSync(scriptPath, 'utf-8');
        if (scriptPath.endsWith('.py')) {
            const docMatch = content.match(/"""([\s\S]*?)"""/);
            const desc = docMatch ? docMatch[1].trim().split('\n')[0] : '';
            return desc ? { description: desc } : {};
        }
        const match = content.match(/export\s+default\s*({[\s\S]+?})\s*;?/);
        if (!match) return {};
        const obj = match[1];
        const nameMatch = obj.match(/name:\s*['"`]([^'"`]+)['"`]/);
        const descMatch = obj.match(/description:\s*(['"`])([\s\S]*?)\1\s*,?/);
        const desc = descMatch ? descMatch[2].replace(/\s+/g, ' ').trim() : '';
        return {
            name: nameMatch ? nameMatch[1] : '',
            description: desc
        };
    } catch {
        return {};
    }
}
