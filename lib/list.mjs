import { discoverScripts, getScriptMetadata, resolveDirectory, DIRECTORIES } from './core.mjs';
import { dirForDirectory } from './libs.mjs';

function listOne(directory) {
    const scanDir = dirForDirectory(directory);
    const exts = directory === 'src' ? ['.py'] : ['.mjs', '.js'];
    const scripts = discoverScripts(scanDir, exts);
    if (scripts.length === 0) {
        console.error(`${directory}/ (0 modules)`);
        return;
    }
    console.error(`${directory}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`);
    for (const mod of scripts) {
        const meta = getScriptMetadata(mod.path);
        console.log(`  ${mod.name.padEnd(18)}${meta.description || ''}`);
    }
}

export async function listModules(args = []) {
    const hasDirectoryFlag = args.some(
        (a) => a === '--lib' || a === '--src' || a === '--scripts' || a === '--script'
    );
    if (hasDirectoryFlag) {
        const directory = await resolveDirectory(args, 'scripts');
        listOne(directory);
        return;
    }

    for (const directory of DIRECTORIES) {
        if (directory !== DIRECTORIES[0]) console.log();
        listOne(directory);
    }
}

export default { listModules };
