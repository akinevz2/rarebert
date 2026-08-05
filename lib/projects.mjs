import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Enquirer from 'enquirer';
import { AbortError } from './cli.mjs';


const DIRECTORIES = ['scripts', 'lib', 'src'];
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, '..');


class Project {
    constructor(root) {
        this.root = root;
        this.scriptsDir = path.join(root, 'scripts');
        this.libDir = path.join(root, 'lib');
        this.srcDir = path.join(root, 'src');
    }

    discover(dir = this.scriptsDir, exts = ['.mjs', '.js']) {
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir)
            .filter((f) => exts.some((ext) => f.endsWith(ext)))
            .map((f) => {
                const rel = path.relative(this.root, path.join(dir, f));
                return { name: path.basename(rel, path.extname(rel)), path: rel };
            });
    }

    absPath(rel) {
        return path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    }

    relPath(abs) {
        return path.relative(this.root, abs);
    }

    readDirectoryFlag(args = []) {
        if (args.includes('--lib')) return 'lib';
        if (args.includes('--src')) return 'src';
        if (args.includes('--scripts') || args.includes('--script')) return 'scripts';
        return null;
    }

    async promptDirectory(defaultDirectory = 'scripts') {
        if (process.stdin.isTTY !== true) {
            console.log(`Non-interactive; defaulting directory to ${defaultDirectory}.`);
            return defaultDirectory;
        }

        const prompt = new Enquirer.Select({
            name: 'directory',
            initial: defaultDirectory,
            choices: [
                { name: 'scripts', message: 'scripts/  (executable script invoked via make/<script>)' },
                { name: 'lib', message: 'lib/      (shared library imported by other modules)' },
                { name: 'src', message: 'src/      (rarebert projects)' }
            ]
        });

        try {
            return await prompt.run();
        } catch {
            throw new AbortError();
        }
    }

    async resolveDirectory(args = [], defaultDirectory = 'scripts') {
        return this.readDirectoryFlag(args) ?? (await this.promptDirectory(defaultDirectory));
    }

    // assertProjectRoot() {
    //     const cwd = process.cwd();
    //     if (cwd !== this.root) {
    //         console.error(`Error: must be run from project root (${this.root})`);
    //         console.error(`  Current directory: ${cwd}`);
    //         console.error(`  Run: cd ${this.root} && make ...`);
    //         process.exit(1);
    //     }
    // }

    normalizeModuleName(rawName, extensions = ['.js', '.mjs', '.py']) {
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

    getScriptMetadata(scriptPath) {
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
}

export const rarebert = new Project(ROOT);
export const current = new Project(process.cwd());

export { Project, DIRECTORIES };
export default Project;
