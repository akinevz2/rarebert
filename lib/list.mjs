import path from 'path';
import {
    PROJECT_ROOT,
    discover,
    getScriptMetadata,
    resolveDirectory,
    DIRECTORIES
} from './core.mjs';
import { dirForDirectory } from './libs.mjs';

class List {
    listOne(directory) {
        const scanDir = dirForDirectory(directory);
        const exts = directory === 'src' ? ['.py'] : ['.mjs', '.js'];
        const scripts = discover(scanDir, exts);
        if (scripts.length === 0) {
            console.log(`${directory}/ (0 modules)`);
            return;
        }
        console.log(`${directory}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`);
        for (const mod of scripts) {
            const meta = getScriptMetadata(mod.abs);
            console.log(`  ${mod.path.padEnd(24)}${meta.description || ''}`);
        }
    }

    async listModules(args = []) {
        const hasDirectoryFlag = args.some(
            (a) => a === '--lib' || a === '--src' || a === '--scripts' || a === '--script'
        );
        if (hasDirectoryFlag) {
            const directory = await resolveDirectory(args, 'scripts');
            this.listOne(directory);
            return;
        }

        for (const directory of DIRECTORIES) {
            if (directory !== DIRECTORIES[0]) console.log();
            this.listOne(directory);
        }
    }
}

const list = new List();
const listModules = (args) => list.listModules(args);

export { List, list, listModules };
export default { List, list, listModules };
