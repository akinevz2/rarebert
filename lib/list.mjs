import { rarebert } from './projects.mjs';

function listOne(project) {
    const scripts = rarebert.discoverModules(project.dir, project.exts);
    if (scripts.length === 0) {
        console.log(`${project.rel}/ (0 modules)`);
        return;
    }
    console.log(
        `${project.rel}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`
    );
    for (const mod of scripts) {
        const scriptMeta = rarebert.getScriptMetadata(rarebert.absPath(mod.path));
        console.log(`  ${mod.path.padEnd(24)}${scriptMeta.description || ''}`);
    }
}

async function listModules(args = []) {
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
        if (project) listOne(project);
        return;
    }

    const projects = rarebert.discover();
    for (const project of projects) {
        if (project !== projects[0]) console.log();
        listOne(project);
    }
}

export { listOne, listModules };
export default { listOne, listModules };