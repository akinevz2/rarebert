import path from 'path';
import Enquirer from 'enquirer';
import { project, getScriptMetadata, normalizeModuleName } from './core.mjs';
import { cli, AbortError } from './cli.mjs';

const DIRECTORY_TARGETS = [
    { key: 'root', dir: project.root, label: './  (rarebert core)' },
    { key: 'scripts', dir: project.scriptsDir, label: 'scripts/  (rarebert api)' },
    { key: 'lib', dir: project.libDir, label: 'lib/  (rarebert library)' },
    { key: 'src', dir: project.srcDir, label: 'src/  (rarebert projects)' }
];

class Module {
    constructor(rel) {
        this.path = rel;
        this.name = path.basename(rel, path.extname(rel));
        this.abs = project.absPath(rel);
        this.ext = path.extname(rel);
        this.dir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
    }

    toString() {
        return this.path;
    }

    memoFile() {
        return this.abs + '.';
    }
}

function findDirectoryTarget(key) {
    return DIRECTORY_TARGETS.find((t) => t.key === key) || null;
}

function directoryTargetByPath(absPath) {
    const resolved = path.resolve(absPath);
    return (
        DIRECTORY_TARGETS.find((t) => t.dir === resolved) ||
        DIRECTORY_TARGETS.find((t) => resolved.startsWith(t.dir + path.sep)) ||
        null
    );
}

function listAllModules() {
    const raw = [...project.discover(project.scriptsDir), ...project.discover(project.libDir)];
    return raw.map((m) => new Module(m.path));
}

function buildModuleChoices(modules) {
    return modules.map((s) => {
        const meta = getScriptMetadata(s.abs);
        const desc = meta.description ? meta.description.split('\n')[0].trim() : '';
        const label = cli.truncate(`${s.path}${desc ? ' - ' + desc : ''}`);
        return { name: s.path, message: label };
    });
}

async function promptModule(modules, moduleArg, message = 'Select a module') {
    if (moduleArg) {
        const match =
            modules.find((s) => normalizeModuleName(s.name) === normalizeModuleName(moduleArg)) ||
            modules.find((s) => s.path === moduleArg) ||
            modules.find((s) => s.path.endsWith(moduleArg) || s.name === moduleArg);
        if (!match) {
            console.error(`Module not found: ${moduleArg}`);
            process.exit(1);
        }
        return match;
    }

    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; pass a module name as an argument.');
        process.exit(1);
    }

    const choices = buildModuleChoices(modules);
    const prompt = new Enquirer.AutoComplete({
        name: 'module',
        message,
        limit: 12,
        choices,
        suggest(input) {
            const q = (input || '').toLowerCase().trim();
            return q ? choices.filter((c) => c.message.toLowerCase().includes(q)) : choices;
        }
    });

    try {
        const answer = await prompt.run();
        return modules.find((s) => s.path === answer);
    } catch {
        throw new AbortError();
    }
}

export {
    Module,
    DIRECTORY_TARGETS,
    findDirectoryTarget,
    directoryTargetByPath,
    listAllModules,
    buildModuleChoices,
    promptModule
};
export default Module;
