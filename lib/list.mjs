import { rarebert } from './projects.mjs';

class List {
    listOne(project) {
        const scripts = rarebert.discoverModules(project.dir, project.exts);
        if (scripts.length === 0) {
            console.log(`${project.rel}/ (0 modules)`);
            return;
        }
        console.log(
            `${project.rel}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`
        );
        for (const mod of scripts) {
            const meta = rarebert.getScriptMetadata(rarebert.absPath(mod.path));
            console.log(`  ${mod.path.padEnd(24)}${meta.description || ''}`);
        }
    }

    async listModules(args = []) {
        const hasDirectoryFlag = args.some(
            (a) =>
                a === '--lib' ||
                a === '--src' ||
                a === '--supports' ||
                a === '--scripts' ||
                a === '--script'
        );
        if (hasDirectoryFlag) {
            const directory = await rarebert.resolveDirectory(args, 'scripts');
            const project = rarebert.projectByKey(directory);
            if (project) this.listOne(project);
            return;
        }

        const projects = rarebert.discover();
        for (const project of projects) {
            if (project !== projects[0]) console.log();
            this.listOne(project);
        }
    }
}

const list = new List();
export { List, list };
export default list;
