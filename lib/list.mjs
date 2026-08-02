import { discoverScripts, getScriptMetadata, resolvePlacement } from './core.mjs';
import { dirForPlacement } from './libs.mjs';

export async function listModules(args = []) {
    const hasPlacementFlag = args.some(a => a === '--lib' || a === '--scripts' || a === '--script');
    const placement = hasPlacementFlag
        ? await resolvePlacement(args, 'scripts')
        : 'scripts';
    const scanDir = dirForPlacement(placement);

    const scripts = discoverScripts(scanDir);
    if (scripts.length === 0) {
        console.error(`No modules found in ${placement}/.`);
        return;
    }

    console.error(`${placement}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`);
    for (const mod of scripts) {
        const meta = getScriptMetadata(mod.path);
        console.log(`  ${mod.name.padEnd(18)}${meta.description || ''}`);
    }
}

export function listScripts(scriptsDir) {
    const scripts = discoverScripts(scriptsDir);
    return scripts.map(s => {
        const meta = getScriptMetadata(s.path);
        return {
            name: s.name,
            path: s.path,
            description: meta.description || ''
        };
    });
}

export default { listModules, listScripts };