import { project, getScriptMetadata, resolveDirectory } from './core.mjs';
import { DIRECTORIES } from './projects.mjs';
import { libs } from './libs.mjs';

class List {
    listOne(directory) {
        const scanDir = libs.dirForDirectory(directory);
        const exts = directory === 'src' ? ['.py'] : ['.mjs', '.js'];
        const scripts = project.discover(scanDir, exts);
        if (scripts.length === 0) {
            console.log(`${directory}/ (0 modules)`);
            return;
        }
        console.log(`${directory}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`);
        for (const mod of scripts) {
            const meta = getScriptMetadata(project.absPath(mod.path));
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
export { List, list };
export default list;
