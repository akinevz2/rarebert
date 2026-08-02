import Enquirer from 'enquirer';
import { SCRIPTS_DIR, LIB_DIR, discoverScripts, getScriptMetadata, normalizeModuleName } from './core.mjs';

export function listAllModules() {
    return [...discoverScripts(SCRIPTS_DIR), ...discoverScripts(LIB_DIR)];
}

export function buildModuleChoices(modules) {
    return modules.map(s => {
        const meta = getScriptMetadata(s.path);
        const label = `${s.name}${meta.description ? ' - ' + meta.description : ''}`;
        return { name: s.path, message: label };
    });
}

export async function promptModule(modules, moduleArg, message = 'Select a module') {
    if (moduleArg) {
        const match = modules.find(s => normalizeModuleName(s.name) === normalizeModuleName(moduleArg));
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
            return q ? choices.filter(c => c.message.toLowerCase().includes(q)) : choices;
        }
    });

    try {
        const answer = await prompt.run();
        return modules.find(s => s.path === answer);
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

export default { listAllModules, buildModuleChoices, promptModule };