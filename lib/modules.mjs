import path from 'path';
import Enquirer from 'enquirer';
import {
    PROJECT_ROOT,
    SCRIPTS_DIR,
    SRC_DIR,
    LIB_DIR,
    discover,
    getScriptMetadata,
    normalizeModuleName
} from './core.mjs';
import { AbortError } from './cli.mjs';

export const DIRECTORY_TARGETS = [
    { key: 'root', dir: PROJECT_ROOT, label: './  (rarebert core)' },
    { key: 'scripts', dir: SCRIPTS_DIR, label: 'scripts/  (rarebert api)' },
    { key: 'lib', dir: LIB_DIR, label: 'lib/  (rarebert library)' },
    { key: 'src', dir: SRC_DIR, label: 'src/  (rarebert projects)' }
];

export function findDirectoryTarget(key) {
    return DIRECTORY_TARGETS.find((t) => t.key === key) || null;
}

export function directoryTargetByPath(absPath) {
    const resolved = path.resolve(absPath);
    return (
        DIRECTORY_TARGETS.find((t) => t.dir === resolved) ||
        DIRECTORY_TARGETS.find((t) => resolved.startsWith(t.dir + path.sep)) ||
        null
    );
}

export function listAllModules() {
    return [...discover(SCRIPTS_DIR), ...discover(LIB_DIR)];
}

export function buildModuleChoices(modules) {
    return modules.map((s) => {
        const meta = getScriptMetadata(s.path);
        const label = `${s.name}${meta.description ? ' - ' + meta.description : ''}`;
        return { name: s.path, message: label };
    });
}

export async function promptModule(modules, moduleArg, message = 'Select a module') {
    if (moduleArg) {
        const match = modules.find(
            (s) => normalizeModuleName(s.name) === normalizeModuleName(moduleArg)
        );
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

export default {
    DIRECTORY_TARGETS,
    findDirectoryTarget,
    directoryTargetByPath,
    listAllModules,
    buildModuleChoices,
    promptModule
};
