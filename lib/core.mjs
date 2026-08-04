import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { AbortError } from './cli.mjs';
import { Project, rarebert, current } from './projects.mjs';

const project = rarebert;
const ROOT = rarebert.root;

class ExitSignal {
    constructor(code) {
        this.code = code;
    }
}

class HelpRequestedSignal extends Error {
    constructor() {
        super('Help requested');
        this.name = 'HelpRequestedSignal';
    }
}



function exit(code = 0) {
    return new ExitSignal(code);
}

function readDirectoryFlag(args = []) {
    if (args.includes('--lib')) return 'lib';
    if (args.includes('--src')) return 'src';
    if (args.includes('--scripts') || args.includes('--script')) return 'scripts';
    return null;
}

async function promptDirectory(defaultDirectory = 'src') {
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

async function resolveDirectory(args = [], defaultDirectory = 'scripts') {
    return readDirectoryFlag(args) ?? (await promptDirectory(defaultDirectory));
}

function assertProjectRoot() {
    const cwd = process.cwd();
    if (cwd !== rarebert.root) {
        console.error(`Error: must be run from project root (${rarebert.root})`);
        console.error(`  Current directory: ${cwd}`);
        console.error(`  Run: cd ${rarebert.root} && make ...`);
        process.exit(1);
    }
}

function normalizeModuleName(rawName, extensions = ['.js', '.mjs', '.py']) {
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

function getScriptMetadata(scriptPath) {
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

export {
    project,
    rarebert,
    current,
    Project,
    ExitSignal,
    HelpRequestedSignal,
    exit,
    readDirectoryFlag,
    promptDirectory,
    resolveDirectory,
    assertProjectRoot,
    normalizeModuleName,
    getScriptMetadata
};

export default {
    project,
    Project,
    ExitSignal,
    HelpRequestedSignal,
    exit,
    readDirectoryFlag,
    promptDirectory,
    resolveDirectory,
    assertProjectRoot,
    normalizeModuleName,
    getScriptMetadata
};
